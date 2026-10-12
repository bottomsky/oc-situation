import { setTimeout as delay } from 'node:timers/promises';
import { createInfrastructure, logger, startWorkerMetrics } from '@ais/infrastructure';
import { IntelligenceSourceSchema } from '../../packages/contracts/intelligence';
import { ensureFusionBus, flushReadyOutbox } from '../../packages/infrastructure/fusion-data';
import { ingestSource } from './adapter';

const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const infra = await createInfrastructure();
const metrics = startWorkerMetrics(
  infra,
  'intelligence',
  Number(process.env.INTERNAL_METRICS_PORT ?? 13107),
);
try {
  await ensureFusionBus(infra);
  while (!abort.signal.aborted) {
    const rows = await infra.pool.query(
      "SELECT id,config FROM intelligence_sources WHERE config->>'kind' <> 'manual' AND (config->>'enabled')::boolean=true AND (last_polled_at IS NULL OR last_polled_at <= now() - ((config->>'pollSeconds')::integer * interval '1 second')) ORDER BY id LIMIT 100",
    );
    for (const row of rows.rows) {
      if (abort.signal.aborted) break;
      const lock = await infra.pool.connect();
      let acquired = false;
      try {
        const result = await lock.query(
          'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired',
          [`intelligence:${row.id}`],
        );
        acquired = Boolean(result.rows[0]?.acquired);
        if (!acquired) continue;
        const source = IntelligenceSourceSchema.parse(row.config);
        const ingestion = await ingestSource(infra, source, abort.signal);
        if ('failures' in ingestion && ingestion.failures?.length)
          metrics.failures.inc(ingestion.failures.length);
        metrics.processed.inc();
        await infra.pool.query(
          'UPDATE intelligence_sources SET last_polled_at=now(),last_error=$2,last_ingestion=$3::jsonb,last_successful_at=CASE WHEN $4::boolean THEN now() ELSE last_successful_at END WHERE id=$1',
          [
            row.id,
            'failures' in ingestion && ingestion.failures?.length
              ? JSON.stringify({
                  failures: ingestion.failures,
                  pending: ingestion.pending?.length ?? 0,
                }).slice(0, 4000)
              : 'pending' in ingestion && ingestion.pending?.length
                ? `${ingestion.pending.length} documents archived pending manual structuring`
                : null,
            JSON.stringify(ingestion),
            !('failures' in ingestion && ingestion.failures?.length),
          ],
        );
      } catch (error) {
        metrics.failures.inc();
        logger.error(
          { sourceId: row.id, error: error instanceof Error ? error.message : 'Ingestion failed' },
          'Intelligence source failed',
        );
        await infra.pool.query(
          'UPDATE intelligence_sources SET last_polled_at=now(),last_error=$2,last_ingestion=$3::jsonb WHERE id=$1',
          [
            row.id,
            error instanceof Error
              ? error.message.slice(0, 4000)
              : 'Source ingestion failed; inspect operator logs',
            JSON.stringify({
              imported: 0,
              failed: true,
              error: error instanceof Error ? error.message : 'Ingestion failed',
            }),
          ],
        );
      } finally {
        if (acquired)
          await lock.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
            `intelligence:${row.id}`,
          ]);
        lock.release();
      }
    }
    await flushReadyOutbox(infra);
    await delay(2000, undefined, { signal: abort.signal }).catch((error) => {
      if (!abort.signal.aborted) throw error;
    });
  }
} finally {
  await metrics.close();
  await infra.close();
}
