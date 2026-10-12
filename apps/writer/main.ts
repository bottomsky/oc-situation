import {
  createInfrastructure,
  logger,
  shutdownSignal,
  startWorkerMetrics,
} from '@ais/infrastructure';
import { runWriter } from './index';
const infra = await createInfrastructure();
const shutdown = shutdownSignal();
const target = process.env.WRITER_TARGET === 'postgres' ? 'postgres' : 'clickhouse';
const metrics = startWorkerMetrics(
  infra,
  `writer-${target}`,
  Number(process.env.INTERNAL_METRICS_PORT ?? (target === 'postgres' ? 13102 : 13103)),
);
try {
  await runWriter(
    infra,
    target,
    shutdown.signal,
    () => metrics.processed.inc(),
    () => metrics.failures.inc(),
  );
} catch (error) {
  logger.fatal(
    { error: error instanceof Error ? error.message : 'Writer startup failed' },
    'Writer stopped',
  );
  process.exitCode = 1;
} finally {
  shutdown.remove();
  await metrics.close();
  await infra.close();
}
