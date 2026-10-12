import {
  Body,
  ConflictException,
  Controller,
  Get,
  Query,
  Headers,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { TaskCommandSchema } from '@ais/contracts';
import type { Infrastructure } from '@ais/infrastructure';
import {
  DocumentRoute,
  DocumentQuery,
  INFRA,
  MinimumRole,
  Iso,
  SafeId,
  Uuid,
  parse,
  audit,
  PageQuery,
  PageResponse,
  isoValue,
} from '../common';
import type { AuthRequest } from '../auth/guard';
import { runRow, RunResponseSchema } from '../runs/controller';
export const ReplaySchema = z
  .strictObject({
    sourceId: SafeId,
    from: Iso,
    to: Iso,
    cleaningVersion: z.literal(1).default(1),
    targetDataset: z.literal('current').default('current'),
  })
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) - Date.parse(v.from) <= 90 * 86400000 &&
      Date.parse(v.from) > Date.now() - 90 * 86400000 &&
      Date.parse(v.to) <= Date.now() + 60000,
    'Replay requires a retained, increasing range of at most 90 days',
  );
const ReplayQuery = PageQuery.extend({ sourceId: SafeId.optional() });
const ReplayResponse = z.object({
  replayId: Uuid,
  runId: Uuid,
  sourceId: SafeId,
  from: Iso,
  to: Iso,
  cleaningVersion: z.literal(1),
  targetDataset: z.literal('current'),
  status: z.string(),
  createdAt: Iso,
  counters: z.record(z.string(), z.number()),
});
@Controller('replays')
export class ReplayController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(ReplayQuery)
  @DocumentRoute('Read archive replay records with associated runId', PageResponse(ReplayResponse))
  async list(@Query() input: unknown) {
    const q = parse(ReplayQuery, input);
    if (q.cursor) parse(Uuid, q.cursor);
    const result = await this.infra.pool.query(
      'SELECT * FROM replays WHERE ($1::uuid IS NULL OR id<$1) AND ($2::text IS NULL OR source_id=$2) ORDER BY id DESC LIMIT $3',
      [q.cursor ?? null, q.sourceId ?? null, q.limit + 1],
    );
    const items = result.rows.slice(0, q.limit).map((r) => ({
      replayId: r.id,
      runId: r.id,
      sourceId: r.source_id,
      from: isoValue(r.from_time),
      to: isoValue(r.to_time),
      cleaningVersion: r.cleaning_version,
      targetDataset: r.target_dataset,
      status: r.status,
      createdAt: isoValue(r.created_at),
      counters: r.counters,
    }));
    return { items, nextCursor: result.rows.length > q.limit ? items.at(-1)!.replayId : null };
  }
  @Post()
  @HttpCode(202)
  @MinimumRole('operator')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @DocumentRoute(
    'Queue a retained archive replay using cleaning version 1',
    RunResponseSchema,
    ReplaySchema,
    202,
  )
  async create(
    @Body() body: unknown,
    @Headers('idempotency-key') key: string,
    @Req() req: AuthRequest,
  ) {
    parse(Uuid, key);
    const q = parse(ReplaySchema, body);
    const client = await this.infra.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        `replay:${q.sourceId}:${key}`,
      ]);
      const existing = await client.query(
        "SELECT * FROM runs WHERE source_id=$1 AND mode='replay' AND idempotency_key=$2",
        [q.sourceId, key],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return runRow(existing.rows[0]);
      }
      const archive = await client.query(
        "SELECT id FROM archive_batches WHERE source_id=$1 AND min_received_at<$3::timestamptz AND max_received_at>=$2::timestamptz AND status='committed' AND expire_at>now() LIMIT 1",
        [q.sourceId, q.from, q.to],
      );
      if (!archive.rows[0]) throw new ConflictException('No retained committed archive in range');
      const runId = randomUUID();
      const jobId = randomUUID();
      const requestedAt = new Date().toISOString();
      await client.query(
        "INSERT INTO jobs(id,source_id,name,enabled,status,mode) VALUES($1,$2,'Archive replay',false,'paused','replay')",
        [jobId, q.sourceId],
      );
      const run = await client.query(
        "INSERT INTO runs(id,job_id,source_id,mode,status,requested_at,idempotency_key) VALUES($1,$2,$3,'replay','queued',$4,$5) RETURNING *",
        [runId, jobId, q.sourceId, requestedAt, key],
      );
      await client.query(
        'INSERT INTO replays(id,source_id,from_time,to_time,cleaning_version,target_dataset) VALUES($1,$2,$3,$4,$5,$6)',
        [runId, q.sourceId, q.from, q.to, q.cleaningVersion, q.targetDataset],
      );
      const command = TaskCommandSchema.parse({
        schemaVersion: 1,
        runId,
        jobId,
        sourceId: q.sourceId,
        idempotencyKey: key,
        mode: 'replay',
        requestedAt,
      });
      await client.query('INSERT INTO outbox(id,subject,payload) VALUES($1,$2,$3::jsonb)', [
        randomUUID(),
        'ais.commands.replay',
        JSON.stringify(command),
      ]);
      await client.query('COMMIT');
      await audit(this.infra, req.user.id, 'replay.create', 'replay', runId, q);
      return runRow(run.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
