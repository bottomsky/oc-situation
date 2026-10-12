import { randomUUID } from 'node:crypto';
import type { TaskCommand } from '@ais/contracts';
import {
  acquireLease,
  checkpointRun,
  createRawEnvelope,
  getRun,
  getSource,
  publishRaw,
  releaseLease,
  renewLease,
  updateRunStatus,
  type Infrastructure,
} from '@ais/infrastructure';
import { crawlSource, CrawlAuthorizationError } from './worker';
import type { AcquisitionMetrics } from './metrics';

export async function runCrawl(
  infra: Infrastructure,
  command: TaskCommand,
  shutdown: AbortSignal,
  metrics?: AcquisitionMetrics,
): Promise<boolean> {
  if (command.mode !== 'crawl') throw new Error('Crawler only handles crawl mode');
  const run = await getRun(infra, command.runId);
  if (!run) throw new Error('Run not found');
  if (['succeeded', 'failed', 'cancelled'].includes(String(run.status))) return true;
  const source = await getSource(infra, command.sourceId);
  if (!source) throw new Error('Source not found');
  const lease = await acquireLease(infra, `source:${source.sourceId}`, randomUUID(), 120);
  if (!lease) return false;
  metrics?.activeRuns.inc();
  const controller = new AbortController();
  const signal = AbortSignal.any([shutdown, controller.signal]);
  let captures = Number((run.counters as { captures?: number })?.captures ?? 0);
  let cancelled = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!(await renewLease(infra, lease, 120))) {
        controller.abort();
        return;
      }
      const state = await infra.pool.query(
        'SELECT j.enabled AS job_enabled,s.enabled AS source_enabled,r.status AS run_status FROM runs r JOIN jobs j ON j.id=r.job_id JOIN sources s ON s.id=r.source_id WHERE r.id=$1',
        [command.runId],
      );
      const row = state.rows[0];
      if (!row || !row.job_enabled || !row.source_enabled || row.run_status === 'cancelled') {
        cancelled = true;
        controller.abort();
      }
    })().catch(() => controller.abort());
  }, 30_000);
  try {
    await updateRunStatus(infra, command.runId, 'running');
    await crawlSource({
      onRequest: () => metrics?.requests.inc(),
      source,
      runId: command.runId,
      production: infra.config.production,
      signal,
      publish: async (payload, format, rendered) => {
        if (!(await renewLease(infra, lease, 120))) {
          controller.abort();
          throw new Error('Source lease lost');
        }
        const raw = await createRawEnvelope(infra, {
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          adapterVersion: rendered ? '1.0.0-rendered' : '1.0.0',
          sourcePriority: source.priority,
          runId: command.runId,
          payload,
          responseMeta: {
            format,
            contentType:
              format === 'json'
                ? 'application/json'
                : format === 'html'
                  ? 'text/html'
                  : 'text/plain',
          },
        });
        await publishRaw(infra, raw);
        metrics?.captures.inc();
        metrics?.lastReceived.set(Date.parse(raw.receivedAt) / 1000);
        captures++;
        await infra.pool.query(
          'UPDATE sources SET last_received_at=$2,last_error=NULL,updated_at=now() WHERE id=$1',
          [source.sourceId, raw.receivedAt],
        );
      },
      checkpoint: async (url) => {
        await checkpointRun(infra, command.runId, { lastUrl: url, captures }, lease);
        await infra.pool.query(
          `UPDATE runs SET counters=jsonb_set(counters,'{captures}',to_jsonb($2::int)),updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM leases WHERE name=$3 AND owner=$4 AND fencing_token=$5 AND expires_at>now())`,
          [command.runId, captures, lease.name, lease.owner, lease.fencingToken],
        );
      },
    });
    if (controller.signal.aborted) throw new Error('Source lease lost');
    await updateRunStatus(infra, command.runId, 'succeeded');
    return true;
  } catch (error) {
    metrics?.failures.inc();
    const message = (error instanceof Error ? error.message : 'Crawl failed')
      .replace(/https?:\/\/[^\s]+/g, '[source-url]')
      .slice(0, 500);
    await updateRunStatus(
      infra,
      command.runId,
      shutdown.aborted || cancelled ? 'cancelled' : 'failed',
      message,
    );
    await infra.pool.query(
      'UPDATE sources SET last_error=$2,status=CASE WHEN $3 THEN $4 ELSE status END,updated_at=now() WHERE id=$1',
      [source.sourceId, message, error instanceof CrawlAuthorizationError, 'error'],
    );
    return true;
  } finally {
    metrics?.activeRuns.dec();
    clearInterval(heartbeat);
    await releaseLease(infra, lease);
  }
}
