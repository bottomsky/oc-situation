import { TaskCommandSchema } from '@ais/contracts';
import { consume, createInfrastructure, logger, startWorkerMetrics } from '@ais/infrastructure';
import { createAcquisitionMetrics } from './metrics';
import { runCollection, redactError } from './service';
import { dispatchBounded } from './dispatch';
const shutdown = new AbortController();
const infra = await createInfrastructure();
const health = startWorkerMetrics(infra, 'collector', Number(process.env.METRICS_PORT ?? 13105));
const metrics = createAcquisitionMetrics(health.registry);
const messages = await consume(infra, 'AIS_COMMANDS', 'collector', 8);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    shutdown.abort();
    messages.stop();
  });
try {
  await dispatchBounded(messages, 8, async (message) => {
    const working = setInterval(() => message.working(), 30_000);
    try {
      const command = TaskCommandSchema.parse(JSON.parse(message.string()));
      if (await runCollection(infra, command, shutdown.signal, process.env, metrics)) message.ack();
      else message.nak(5000);
    } catch (error) {
      logger.error({ error: redactError(error) }, 'Collector task failed');
      message.nak(5000);
    } finally {
      clearInterval(working);
    }
  });
} finally {
  messages.stop();
  await health.close();
  await infra.close();
}
