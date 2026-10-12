import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createLiveUpgradeProxy } from './integrations/liveProxy';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('Nuxt 开发实时升级代理', () => {
  it('保持会话Cookie、Origin及游标，双向转发并在关闭时释放上游', async () => {
    const upstream = createServer();
    const upstreamUrl = await listen(upstream);
    const wss = new WebSocketServer({ noServer: true });
    let headers: { cookie?: string; origin?: string; url?: string } = {};
    upstream.on('upgrade', (req, socket, head) => {
      headers = { cookie: req.headers.cookie, origin: req.headers.origin, url: req.url };
      wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (data) => ws.send(data)));
    });
    cleanup.push(() => {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
    });
    const proxy = createLiveUpgradeProxy(upstreamUrl);
    const server = createServer();
    server.on('upgrade', proxy.upgrade);
    const proxyUrl = await listen(server);
    cleanup.push(() => proxy.close());
    const client = new WebSocket(proxyUrl.replace('http:', 'ws:') + '/api/v1/live?cursor=12', {
      headers: { Cookie: 'ais_session=test-session', Origin: 'http://127.0.0.1:13001' },
    });
    cleanup.push(() => client.terminate());
    await once(client, 'open');
    const message = once(client, 'message');
    client.send('test payload');
    expect((await message)[0].toString()).toBe('test payload');
    expect(headers).toEqual({
      cookie: 'ais_session=test-session',
      origin: 'http://127.0.0.1:13001',
      url: '/api/v1/live?cursor=12',
    });
    const closed = once(client, 'close');
    proxy.close();
    await closed;
    await new Promise((resolve) => setImmediate(resolve));
    expect(proxy.connections()).toBe(0);
  });

  it('上游拒绝或连接中断时关闭客户端，不产生未处理拒绝', async () => {
    const upstream = createServer();
    upstream.on('upgrade', (_req, socket) => socket.destroy());
    const proxy = createLiveUpgradeProxy(await listen(upstream));
    const server = createServer();
    server.on('upgrade', proxy.upgrade);
    const proxyUrl = await listen(server);
    cleanup.push(() => proxy.close());
    const client = new WebSocket(proxyUrl.replace('http:', 'ws:') + '/api/v1/live');
    client.on('error', () => {});
    await new Promise<void>((resolve) => client.once('close', () => resolve()));
    expect(proxy.connections()).toBe(0);
  });
});
