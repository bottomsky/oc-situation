import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createE2eWebGateway } from './e2e-web-gateway';

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server, close?: () => Promise<void>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanup.push(
    close ??
      (() =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('编译前端测试网关', () => {
  it('API保持原始路径、查询、Origin和Cookie，响应保留多个Set-Cookie', async () => {
    const backend = createServer(async (request, response) => {
      const body: Buffer[] = [];
      for await (const chunk of request) body.push(Buffer.from(chunk));
      response.setHeader('Set-Cookie', [
        'ais_session=sample; HttpOnly; SameSite=Lax; Path=/',
        'marker=one; Path=/',
      ]);
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          url: request.url,
          method: request.method,
          origin: request.headers.origin,
          cookie: request.headers.cookie,
          host: request.headers.host,
          body: Buffer.concat(body).toString(),
        }),
      );
    });
    const frontend = createServer((_request, response) => response.end('frontend'));
    const gateway = createE2eWebGateway({
      apiTarget: await listen(backend),
      frontendTarget: await listen(frontend),
    });
    const origin = await listen(gateway.server, gateway.close);
    const response = await fetch(origin + '/api/v1/auth/login?source=fixture', {
      method: 'POST',
      headers: {
        Origin: origin,
        Cookie: 'ais_session=original',
        'Content-Type': 'application/json',
      },
      body: '{"username":"测试"}',
    });
    expect(await response.json()).toEqual({
      url: '/api/v1/auth/login?source=fixture',
      method: 'POST',
      origin,
      cookie: 'ais_session=original',
      host: new URL(origin).host,
      body: '{"username":"测试"}',
    });
    expect(response.headers.getSetCookie()).toEqual([
      'ais_session=sample; HttpOnly; SameSite=Lax; Path=/',
      'marker=one; Path=/',
    ]);
  });
  it('前端资源和相似非API前缀转发生产Nuxt，保留状态及重定向', async () => {
    const backend = createServer((_request, response) => response.end('API'));
    const frontend = createServer((request, response) => {
      response.writeHead(307, { Location: '/login', 'Content-Type': 'text/plain' });
      response.end(request.url);
    });
    const gateway = createE2eWebGateway({
      apiTarget: await listen(backend),
      frontendTarget: await listen(frontend),
    });
    const origin = await listen(gateway.server, gateway.close);
    for (const path of ['/_nuxt/application.js?v=1', '/apiary?test=1', '/topics']) {
      const response = await fetch(origin + path, { redirect: 'manual' });
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('/login');
      expect(await response.text()).toBe(path);
    }
  });
  it('WebSocket复用现有升级转发，保留Origin、Cookie、游标并随网关关闭', async () => {
    const backend = createServer();
    const upstream = await listen(backend);
    const sockets = new WebSocketServer({ noServer: true });
    let observed: unknown;
    backend.on('upgrade', (request, socket, head) => {
      observed = {
        url: request.url,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
      };
      sockets.handleUpgrade(request, socket, head, (ws) =>
        ws.on('message', (message) => ws.send(message)),
      );
    });
    cleanup.push(() => {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
    });
    const frontend = createServer((_request, response) => response.end('frontend'));
    const gateway = createE2eWebGateway({
      apiTarget: upstream,
      frontendTarget: await listen(frontend),
    });
    const origin = await listen(gateway.server, gateway.close);
    const client = new WebSocket(origin.replace('http:', 'ws:') + '/api/v1/live?cursor=12', {
      headers: { Origin: origin, Cookie: 'ais_session=original' },
    });
    client.on('error', () => {});
    cleanup.push(() => client.terminate());
    await once(client, 'open');
    const message = once(client, 'message');
    client.send('gateway-frame');
    expect((await message)[0].toString()).toBe('gateway-frame');
    expect(observed).toEqual({
      url: '/api/v1/live?cursor=12',
      origin,
      cookie: 'ais_session=original',
    });
    const closed = once(client, 'close');
    await gateway.close();
    await closed;
  });
  it('上游不可达返回502，上游超时返回504并释放连接', async () => {
    const unavailable = createServer();
    const missing = await listen(unavailable);
    await new Promise<void>((resolve) => unavailable.close(() => resolve()));
    const idle = createServer(() => {});
    const idleTarget = await listen(idle);
    const gateway = createE2eWebGateway({
      apiTarget: missing,
      frontendTarget: idleTarget,
      timeoutMs: 30,
    });
    const origin = await listen(gateway.server, gateway.close);
    expect((await fetch(origin + '/api/v1/sources')).status).toBe(502);
    expect((await fetch(origin + '/')).status).toBe(504);
  });
});
