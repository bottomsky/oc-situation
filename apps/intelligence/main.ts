import { setTimeout as delay } from 'node:timers/promises';
import { createInfrastructure, logger, startWorkerMetrics } from '@ais/infrastructure';
import { ensureFusionBus, flushReadyOutbox } from '../../packages/infrastructure/fusion-data';
import {
  registerIntelligenceSources,
  collectIntelligenceDueSources,
} from '../../packages/infrastructure/intelligence-ingestion';
import { cleanupMarineForecasts } from '../../packages/infrastructure/intelligence-weather';
import { ingestSource } from './adapter';
import { publicIntelligenceSources } from './source-presets';

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
  await registerIntelligenceSources(infra, publicIntelligenceSources);
  let lastCleanup = 0;
  while (!abort.signal.aborted) {
    const batches = await collectIntelligenceDueSources(
      infra,
      (source, signal) => ingestSource(infra, source, signal),
      { signal: abort.signal, concurrency: 3 },
    );
    for (const batch of batches) {
      metrics.processed.inc();
      if (batch.status !== 'succeeded') {
        metrics.failures.inc();
        logger.warn(
          { sourceId: batch.sourceId, status: batch.status },
          'Intelligence collection incomplete',
        );
      }
    }
    await flushReadyOutbox(infra);
    if (!abort.signal.aborted && Date.now() - lastCleanup >= 3600_000) {
      lastCleanup = Date.now();
      try {
        await cleanupMarineForecasts(infra);
      } catch {
        logger.warn({ operation: 'marine-retention' }, 'Intelligence retention cleanup failed');
      }
    }
    await delay(2000, undefined, { signal: abort.signal }).catch((error) => {
      if (!abort.signal.aborted) throw error;
    });
  }
} finally {
  await metrics.close();
  await infra.close();
}
