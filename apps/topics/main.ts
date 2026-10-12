import {
  createInfrastructure,
  logger,
  shutdownSignal,
  startWorkerMetrics,
} from '@ais/infrastructure';
import { TopicDefinitionIdSchema } from '../../packages/contracts/topics';
import { runTopics } from './index';
const infra = await createInfrastructure();
const shutdown = shutdownSignal();
const metrics = startWorkerMetrics(
  infra,
  'topics',
  Number(process.env.INTERNAL_METRICS_PORT ?? 13108),
);
try {
  const definitionId = process.env.TOPIC_DEFINITION_ID
    ? TopicDefinitionIdSchema.parse(process.env.TOPIC_DEFINITION_ID)
    : undefined;
  await runTopics(infra, shutdown.signal, definitionId, {
    onSucceeded: () => metrics.processed.inc(),
    onFailed: () => metrics.failures.inc(),
  });
} catch (error) {
  logger.fatal(
    { error: error instanceof Error ? error.message : String(error) },
    'Topic process stopped',
  );
  process.exitCode = 1;
} finally {
  shutdown.remove();
  await metrics.close();
  await infra.close();
}
