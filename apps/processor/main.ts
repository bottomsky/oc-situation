import {
  createInfrastructure,
  logger,
  shutdownSignal,
  startWorkerMetrics,
} from '@ais/infrastructure';
import { runProcessor, runReplayConsumer } from './index';
const infra = await createInfrastructure();
const shutdown = shutdownSignal();
const metrics = startWorkerMetrics(
  infra,
  'processor',
  Number(process.env.INTERNAL_METRICS_PORT ?? 13101),
);
try {
  await Promise.all([
    runProcessor(
      infra,
      shutdown.signal,
      () => metrics.processed.inc(),
      () => metrics.failures.inc(),
    ),
    runReplayConsumer(infra, shutdown.signal),
  ]);
} catch (error) {
  logger.fatal(
    { error: error instanceof Error ? error.message : 'Processor startup failed' },
    'Processor stopped',
  );
  process.exitCode = 1;
} finally {
  shutdown.remove();
  await metrics.close();
  await infra.close();
}
