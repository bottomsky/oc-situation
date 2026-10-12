import {
  createInfrastructure,
  logger,
  shutdownSignal,
  startWorkerMetrics,
} from '@ais/infrastructure';
import { runArchiver } from './index';
const infra = await createInfrastructure();
const shutdown = shutdownSignal();
const metrics = startWorkerMetrics(
  infra,
  'archiver',
  Number(process.env.INTERNAL_METRICS_PORT ?? 13104),
);
try {
  await runArchiver(
    infra,
    shutdown.signal,
    () => metrics.processed.inc(),
    () => metrics.failures.inc(),
  );
} catch (error) {
  logger.fatal(
    { error: error instanceof Error ? error.message : 'Archiver startup failed' },
    'Archiver stopped',
  );
  process.exitCode = 1;
} finally {
  shutdown.remove();
  await metrics.close();
  await infra.close();
}
