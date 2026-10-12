import {
  Inject,
  Injectable,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { TaskCommandSchema } from '@ais/contracts';
import { assertCollectionReady, flushOutbox, type Infrastructure } from '@ais/infrastructure';
import { INFRA } from '../common';
import { runRow } from '../runs/controller';
@Injectable()
export class JobsService {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  async dispatch(jobId: string, key: string) {
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`dispatch:${jobId}`]);
      const result = await client.query(
        'SELECT j.*,s.enabled AS source_enabled FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.id=$1 FOR UPDATE OF j',
        [jobId],
      );
      const job = result.rows[0];
      if (!job) throw new NotFoundException('Job not found');
      const existing = await client.query(
        'SELECT * FROM runs WHERE job_id=$1 AND idempotency_key=$2',
        [jobId, key],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return runRow(existing.rows[0]);
      }
      if (!job.source_enabled)
        throw new ConflictException('Source must be enabled before dispatch');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`source:${job.source_id}`]);
      const active = await client.query(
        "SELECT id FROM runs WHERE source_id=$1 AND status IN ('queued','running') LIMIT 1",
        [job.source_id],
      );
      if (active.rows[0]) throw new ConflictException('Source has an active run');
      if (job.mode === 'replay') throw new ConflictException('Replay requires an archive range');
      try {
        await assertCollectionReady(this.infra);
      } catch (error) {
        throw new ServiceUnavailableException(
          error instanceof Error ? error.message : 'Collection paused: bus health unavailable',
          { cause: error },
        );
      }
      const runId = randomUUID();
      const requestedAt = new Date().toISOString();
      const command = TaskCommandSchema.parse({
        schemaVersion: 1,
        runId,
        jobId: job.id,
        sourceId: job.source_id,
        idempotencyKey: key,
        mode: job.mode,
        requestedAt,
      });
      const run = await client.query(
        "INSERT INTO runs(id,job_id,source_id,status,mode,requested_at,idempotency_key) VALUES($1,$2,$3,'queued',$4,$5,$6) RETURNING *",
        [runId, job.id, job.source_id, job.mode, requestedAt, key],
      );
      await client.query('INSERT INTO outbox(id,subject,payload) VALUES($1,$2,$3::jsonb)', [
        randomUUID(),
        `ais.commands.${job.mode}`,
        JSON.stringify(command),
      ]);
      await client.query('COMMIT');
      return runRow(run.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 5000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await flushOutbox(this.infra);
      const due = await this.infra.pool.query(
        `SELECT j.id,j.schedule_seconds,coalesce(max(r.requested_at),'-infinity') AS last_run FROM jobs j JOIN sources s ON s.id=j.source_id LEFT JOIN runs r ON r.job_id=j.id WHERE j.enabled AND j.status='enabled' AND s.enabled AND j.mode<>'replay' AND j.schedule_seconds IS NOT NULL GROUP BY j.id HAVING coalesce(max(r.requested_at),'-infinity')<=now()-make_interval(secs=>j.schedule_seconds) LIMIT 100`,
      );
      for (const job of due.rows) {
        const slot = Math.floor(Date.now() / (job.schedule_seconds * 1000));
        try {
          await this.dispatch(job.id, `schedule:${job.id}:${slot}`);
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
        }
      }
      await flushOutbox(this.infra);
    } finally {
      this.busy = false;
    }
  }
}
