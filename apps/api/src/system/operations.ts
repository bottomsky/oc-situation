import { createServer } from 'node:http';
import type { SystemController } from './controller';
export async function startOperationsServer(
  system: SystemController,
  options: { host?: string; port?: number } = {},
) {
  const host = options.host ?? process.env.METRICS_HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.METRICS_PORT ?? 13100);
  const server = createServer((req, res) => {
    const handle = async () => {
      if (req.method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      if (req.url === '/ready') {
        const health = await system.health();
        res.writeHead(health.status === 'ready' ? 200 : 503, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(health));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, {
          'Content-Type': system.metricsContentType(),
          'Cache-Control': 'no-store',
        });
        res.end(await system.metricsText());
        return;
      }
      res.writeHead(404);
      res.end();
    };
    void handle().catch(() => {
      if (!res.headersSent) res.writeHead(503);
      res.end('Service unavailable');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
