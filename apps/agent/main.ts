import {
  createInfrastructure,
  loadConfig,
  logger,
  shutdownSignal,
  startWorkerMetrics,
} from '@ais/infrastructure';
import { agentEnvironment, agentWorkerFailure, runAgentWorker } from './index';
import { agentDatabaseUrl } from './database';

const options = agentEnvironment();
if (options.enabled) {
  const config = loadConfig();
  const infra = await createInfrastructure({
    ...config,
    databaseUrl: agentDatabaseUrl(config.databaseUrl),
  });
  const shutdown = shutdownSignal();
  const metrics = startWorkerMetrics(
    infra,
    'agent',
    Number(process.env.INTERNAL_METRICS_PORT ?? 13109),
  );
  try {
    await runAgentWorker(infra, shutdown.signal, options);
  } catch (error) {
    logger.fatal(
      agentWorkerFailure(error),
      'Agent worker stopped; inspect task status and infrastructure health',
    );
    process.exitCode = 1;
  } finally {
    shutdown.remove();
    await metrics.close();
    await infra.close();
  }
} else logger.info('Agent worker disabled by feature flag');
