import { createServer } from 'node:http';
import { Registry, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import type { Infrastructure } from './clients';
import { cachedBusHealth } from './bus';

export function startWorkerMetrics(infra: Infrastructure, name: string, port: number) {
  const registry = new Registry();
  registry.setDefaultLabels({ worker: name });
  collectDefaultMetrics({ register: registry });
  const processed = new Counter({
    name: 'ais_messages_processed_total',
    help: 'Persisted or processed messages',
    registers: [registry],
  });
  const failures = new Counter({
    name: 'ais_messages_failed_total',
    help: 'Messages retained for retry',
    registers: [registry],
  });
  const pressure = new Gauge({
    name: 'ais_bus_pressure',
    help: '0 ready, 1 warning, 2 paused',
    registers: [registry],
  });
  let stopping = false;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/metrics') {
        response.setHeader('Content-Type', registry.contentType);
        response.end(await registry.metrics());
        return;
      }
      if (request.url === '/health' || request.url === '/ready') {
        const [health] = await Promise.all([
          cachedBusHealth(infra),
          infra.pool.query('SELECT 1'),
          infra.clickhouse.ping().then((ping) => {
            if (!ping.success) throw new Error('ClickHouse unavailable');
            return ping;
          }),
          infra.s3.send(new HeadBucketCommand({ Bucket: infra.config.s3Bucket })),
        ]);
        pressure.set(health.status === 'paused' ? 2 : health.status === 'warning' ? 1 : 0);
        response.statusCode = health.ready && !stopping ? 200 : 503;
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ready: health.ready && !stopping, bus: health }));
        return;
      }
      response.statusCode = 404;
      response.end();
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ ready: false, error: 'Dependency unavailable' }));
    }
  });
  server.listen(port, process.env.METRICS_HOST ?? '127.0.0.1');
  const timer = setInterval(() => {
    void cachedBusHealth(infra)
      .then((health) =>
        pressure.set(health.status === 'paused' ? 2 : health.status === 'warning' ? 1 : 0),
      )
      .catch(() => pressure.set(2));
  }, 1000);
  timer.unref();
  return {
    processed,
    failures,
    registry,
    async close() {
      stopping = true;
      clearInterval(timer);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
export function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    remove() {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    },
  };
}
