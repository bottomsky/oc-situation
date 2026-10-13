import { randomUUID } from 'node:crypto';
import { IntelligenceSourceSchema, type IntelligenceSource } from '../contracts/intelligence';
import type { Infrastructure } from './clients';

export interface IntelligenceIngestionResult {
  imported: number;
  unchanged?: number;
  pending?: unknown[];
  failures?: unknown[];
  [key: string]: unknown;
}
export type IntelligenceCollector = (
  source: IntelligenceSource,
  signal: AbortSignal,
) => Promise<IntelligenceIngestionResult>;
export async function registerIntelligenceSources(
  infra: Infrastructure,
  sources: readonly IntelligenceSource[],
) {
  let added = 0;
  for (const raw of sources) {
    const source = IntelligenceSourceSchema.parse(raw);
    const result = await infra.pool.query(
      'INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING',
      [source.sourceId, JSON.stringify(source)],
    );
    added += result.rowCount ?? 0;
  }
  return added;
}
export function ingestionBackoffSeconds(pollSeconds: number, failures: number) {
  return failures
    ? Math.min(21600, Math.max(pollSeconds, 60) * 2 ** Math.min(failures - 1, 10))
    : pollSeconds;
}
const due = `(config->>'enabled')::boolean=true AND config->>'kind'<>'manual' AND
  coalesce(next_poll_at,last_polled_at + (coalesce((config->>'pollSeconds')::integer,300)*interval '1 second'),'-infinity'::timestamptz)<=now()`;

/** One session advisory lock covers collection, raw archival and its durable batch result. */
export async function collectIntelligenceSource(
  infra: Infrastructure,
  id: string,
  collect: IntelligenceCollector,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
) {
  const client = await infra.pool.connect();
  let locked = false;
  let runId: string | undefined;
  try {
    locked = Boolean(
      (
        await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [
          `intelligence:${id}`,
        ])
      ).rows[0]?.acquired,
    );
    if (!locked || options.signal?.aborted) return null;
    const row = (
      await client.query(`SELECT * FROM intelligence_sources WHERE id=$1 AND ${due}`, [id])
    ).rows[0];
    if (!row) return null;
    await client.query(
      "UPDATE intelligence_ingestion_runs SET status='interrupted',finished_at=now(),error_code='worker_interrupted' WHERE source_id=$1 AND status='running'",
      [id],
    );
    runId = randomUUID();
    await client.query(
      "INSERT INTO intelligence_ingestion_runs(id,source_id,status) VALUES($1,$2,'running')",
      [runId, id],
    );
    const source = IntelligenceSourceSchema.parse(row.config);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 300_000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let result: IntelligenceIngestionResult;
    let errorCode: string | null = null;
    let status: 'succeeded' | 'partial' | 'failed' | 'interrupted';
    try {
      result = await collect(source, signal);
      status = result.failures?.length ? 'partial' : 'succeeded';
      if (status === 'partial') errorCode = 'partial_failure';
    } catch (error) {
      status = options.signal?.aborted ? 'interrupted' : 'failed';
      errorCode = options.signal?.aborted
        ? 'worker_interrupted'
        : timeout.aborted
          ? 'source_timeout'
          : 'collection_failed';
      result = {
        imported: 0,
        failures: [
          { reason: error instanceof Error ? error.message.slice(0, 1000) : 'Collection failed' },
        ],
      };
    }
    const failed = status !== 'succeeded';
    const failureCount = failed ? Number(row.consecutive_failures) + 1 : 0;
    const next = ingestionBackoffSeconds(source.pollSeconds, failureCount);
    await client.query('BEGIN');
    try {
      await client.query(
        `UPDATE intelligence_ingestion_runs SET status=$2,finished_at=now(),imported=$3,unchanged=$4,pending=$5,failures=$6,details=$7::jsonb,error_code=$8 WHERE id=$1`,
        [
          runId,
          status,
          result.imported,
          result.unchanged ?? 0,
          result.pending?.length ?? 0,
          result.failures?.length ?? 0,
          JSON.stringify(result),
          errorCode,
        ],
      );
      await client.query(
        `UPDATE intelligence_sources SET last_polled_at=now(),last_ingestion=$2::jsonb,last_error=$3,
        last_successful_at=CASE WHEN $4 THEN now() ELSE last_successful_at END,consecutive_failures=$5,next_poll_at=now()+($6*interval '1 second') WHERE id=$1`,
        [
          id,
          JSON.stringify(result),
          failed
            ? JSON.stringify({ code: errorCode, failures: result.failures ?? [] }).slice(0, 4000)
            : null,
          !failed,
          failureCount,
          next,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return { id: runId, sourceId: id, status, ...result };
  } catch (error) {
    if (runId)
      await client
        .query(
          "UPDATE intelligence_ingestion_runs SET status='failed',finished_at=now(),error_code='batch_failed' WHERE id=$1 AND status='running'",
          [runId],
        )
        .catch(() => {});
    throw error;
  } finally {
    if (locked)
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        `intelligence:${id}`,
      ]);
    client.release();
  }
}

/** Bounded workers isolate a slow or broken publisher from the other registered sources. */
export async function collectIntelligenceDueSources(
  infra: Infrastructure,
  collect: IntelligenceCollector,
  options: {
    signal?: AbortSignal;
    concurrency?: number;
    timeoutMs?: number;
    sourceIds?: string[];
  } = {},
) {
  const ids = (
    await infra.pool.query(
      `SELECT id FROM intelligence_sources WHERE ${due} AND ($1::text[] IS NULL OR id=ANY($1)) ORDER BY coalesce(next_poll_at,last_polled_at,'-infinity'::timestamptz),id LIMIT 100`,
      [options.sourceIds ?? null],
    )
  ).rows.map((r) => String(r.id));
  const results: Awaited<ReturnType<typeof collectIntelligenceSource>>[] = [];
  let next = 0;
  const worker = async () => {
    while (next < ids.length && !options.signal?.aborted) {
      const id = ids[next++]!;
      try {
        results.push(await collectIntelligenceSource(infra, id, collect, options));
      } catch {
        results.push({
          id: '',
          sourceId: id,
          status: 'failed',
          imported: 0,
          failures: [{ reason: 'Batch persistence or configuration failed' }],
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, 6, ids.length)) }, worker),
  );
  return results.filter((result) => result !== null);
}
