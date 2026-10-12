import { TaskCommandSchema } from '@ais/contracts';
import { consume, createInfrastructure, logger, startWorkerMetrics } from '@ais/infrastructure';
import { createAcquisitionMetrics } from './metrics';
import { runCrawl } from './service';
const shutdown = new AbortController();
const infra = await createInfrastructure();
const health = startWorkerMetrics(infra, 'crawler', Number(process.env.METRICS_PORT ?? 13106));
const metrics = createAcquisitionMetrics(health.registry);
const messages = await consume(infra, 'AIS_COMMANDS', 'crawler', 1);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    shutdown.abort();
    messages.stop();
  });
try {
  for await (const message of messages) {
    const working = setInterval(() => message.working(), 30_000);
    try {
      const command = TaskCommandSchema.parse(JSON.parse(message.string()));
      if (await runCrawl(infra, command, shutdown.signal, metrics)) message.ack();
      else message.nak(5000);
    } catch {
      logger.error('Crawler command failed');
      message.nak(5000);
    } finally {
      clearInterval(working);
    }
    if (shutdown.signal.aborted) break;
  }
} finally {
  messages.stop();
  await health.close();
  await infra.close();
}
