import { createServer } from 'node:http';
import { once } from 'node:events';
import { connect as connectTcp } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { MapResponse } from '@ais/contracts';
import { attachLiveGateway, mapDelta } from './src/live/gateway';

const empty: MapResponse = {
  items: [],
  total: 0,
  sampled: false,
  truncated: false,
  generatedAt: new Date().toISOString(),
};
const point: MapResponse['items'][number] = {
  kind: 'point',
  mmsi: '413000001',
  lat: 24,
  lon: 118,
  sourceId: 'fixture',
  observedAt: empty.generatedAt,
  sogKnots: 2,
  cogDegrees: 30,
  headingDegrees: null,
  quality: ['synthetic'],
};
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of cleanups.splice(0).reverse()) await stop();
});

async function setup(authorized = true) {
  const server = createServer();
  const state = {
    authorized,
    map: { ...empty, items: [point], total: 1 },
    feed: [{ cursor: '1', resultId: 'result-1', revision: 1 }],
  };
  const gateway = attachLiveGateway(server, {
    origins: ['http://localhost:13001'],
    authenticate: async (token) => {
      if (!state.authorized || token !== 'valid') throw new Error('unauthorized');
    },
    readFeed: async (cursor) => ({
      items: state.feed.filter((item) => BigInt(item.cursor) > BigInt(cursor)),
      nextCursor: state.feed.at(-1)?.cursor ?? cursor,
    }),
    readMap: async () => state.map,
    intervalMs: 20,
    reauthenticateMs: 40,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  cleanups.push(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { state, url: `ws://127.0.0.1:${port}/api/v1/live` };
}

function waitMessage(socket: WebSocket, type: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', listener);
      reject(new Error(`Missing ${type}`));
    }, 2000);
    function listener(raw: WebSocket.RawData) {
      const data = JSON.parse(raw.toString());
      if (data.type === type) {
        clearTimeout(timeout);
        socket.off('message', listener);
        resolve(data);
      }
    }
    socket.on('message', listener);
  });
}

describe('authenticated realtime gateway', () => {
  it('rejects malformed and unknown upgrade paths without retaining a socket', async () => {
    const { url } = await setup();
    for (const [path, status] of [
      ['//', '400'],
      ['/unknown', '404'],
    ]) {
      const socket = connectTcp(Number(new URL(url).port), '127.0.0.1');
      cleanups.push(async () => {
        socket.destroy();
      });
      await once(socket, 'connect');
      const response = once(socket, 'data');
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
      expect(String((await response)[0])).toContain(`HTTP/1.1 ${status}`);
      socket.destroy();
    }
  });
  it('calculates changed and removed map items without unchanged observations', () => {
    const previous = { ...empty, items: [point], total: 1 };
    expect(mapDelta(previous, previous).upsert).toEqual([]);
    expect(mapDelta(previous, empty).remove).toEqual(['point:413000001']);
    expect(mapDelta(empty, previous).upsert).toEqual([point]);
  });
  it('rejects an untrusted origin before websocket upgrade', async () => {
    const { url } = await setup();
    const socket = new WebSocket(url, {
      origin: 'https://untrusted.example',
      headers: { Cookie: 'ais_session=valid' },
    });
    const status = await new Promise<number>((resolve) => {
      socket.on('unexpected-response', (_request, response) => {
        resolve(response.statusCode!);
        response.resume();
        socket.terminate();
      });
      socket.on('error', () => {});
    });
    expect(status).toBe(403);
  });
  it('replays durable result notifications and sends viewport snapshots then deltas', async () => {
    const { state, url } = await setup();
    const socket = new WebSocket(url + '?cursor=0', {
      origin: 'http://localhost:13001',
      headers: { Cookie: 'ais_session=valid' },
    });
    const result = waitMessage(socket, 'analysis.updated');
    await once(socket, 'open');
    expect(await result).toMatchObject({ cursor: '1', resultId: 'result-1', revision: 1 });
    const snapshot = waitMessage(socket, 'ais.snapshot');
    socket.send(
      JSON.stringify({
        type: 'viewport',
        version: 1,
        query: { bbox: '117,23,119,25', zoom: 8, hours: 24 },
      }),
    );
    expect(await snapshot).toMatchObject({ version: 1, data: { total: 1 } });
    const delta = waitMessage(socket, 'ais.delta');
    state.map = { ...empty, items: [], total: 0 };
    expect(await delta).toMatchObject({ version: 1, remove: ['point:413000001'], total: 0 });
    socket.close();
  });
  it('closes an established connection after its session is revoked', async () => {
    const { state, url } = await setup();
    const socket = new WebSocket(url, {
      origin: 'http://localhost:13001',
      headers: { Cookie: 'ais_session=valid' },
    });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    state.authorized = false;
    expect((await closed)[0]).toBe(4401);
  });
});
