import { createServer, request, type ClientRequest, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLiveUpgradeProxy } from '../apps/web/integrations/liveProxy';

/** Test-only same-origin routing for compiled Nuxt and the existing API. */
export function createE2eWebGateway(options: {
  apiTarget: string;
  frontendTarget: string;
  timeoutMs?: number;
}) {
  const api = new URL(options.apiTarget);
  const frontend = new URL(options.frontendTarget);
  if (api.protocol !== 'http:' || frontend.protocol !== 'http:')
    throw new Error('E2E upstream targets must use HTTP');
  const live = createLiveUpgradeProxy(api.origin);
  const pending = new Set<ClientRequest>();
  const connections = new Set<Socket>();
  let closing: Promise<void> | undefined;
  function fail(response: ServerResponse, status: number) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      Connection: 'close',
    });
    response.end(
      JSON.stringify({ error: status === 504 ? '测试上游请求超时' : '测试上游服务暂不可用' }),
    );
  }
  const server = createServer((incoming, outgoing) => {
    let path: string;
    try {
      path = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      fail(outgoing, 400);
      return;
    }
    const target = path === '/api' || path.startsWith('/api/') ? api : frontend;
    let timedOut = false;
    const upstream = request({
      hostname: target.hostname,
      port: target.port || 80,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    });
    pending.add(upstream);
    upstream.once('close', () => pending.delete(upstream));
    upstream.on('error', () => fail(outgoing, timedOut ? 504 : 502));
    upstream.setTimeout(options.timeoutMs ?? 15000, () => {
      timedOut = true;
      upstream.destroy(new Error('E2E upstream timeout'));
    });
    upstream.on('response', (response) => {
      if (outgoing.destroyed) {
        response.destroy();
        return;
      }
      outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, response.headers);
      response.on('error', () => outgoing.destroy());
      response.on('aborted', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    incoming.on('aborted', () => upstream.destroy());
    incoming.on('error', () => {
      upstream.destroy();
      outgoing.destroy();
    });
    outgoing.once('close', () => {
      if (!outgoing.writableFinished) upstream.destroy();
    });
    incoming.pipe(upstream);
  });
  server.on('connection', (socket) => {
    connections.add(socket);
    socket.once('close', () => connections.delete(socket));
  });
  server.on('upgrade', (incoming, socket, head) => {
    if (incoming.url?.split('?')[0] === '/api/v1/live') live.upgrade(incoming, socket, head);
    else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  function close() {
    if (closing) return closing;
    closing = new Promise<void>((resolveClose) => {
      live.close();
      for (const upstream of pending) upstream.destroy();
      for (const socket of connections) socket.destroy();
      if (!server.listening) resolveClose();
      else server.close(() => resolveClose());
    });
    return closing;
  }
  return { server, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const gateway = createE2eWebGateway({
    apiTarget: 'http://127.0.0.1:13000',
    frontendTarget: 'http://127.0.0.1:13003',
  });
  const shutdown = () => {
    void gateway.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    gateway.server.listen(13001, '127.0.0.1');
    await once(gateway.server, 'listening');
    console.log('Compiled E2E gateway listening on http://127.0.0.1:13001');
  } catch (error) {
    console.error(
      'Compiled E2E gateway failed:',
      error instanceof Error ? error.message : String(error),
    );
    await gateway.close();
    process.exitCode = 1;
  }
}
