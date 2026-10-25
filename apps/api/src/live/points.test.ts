import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { attachLiveGateway, type LiveGatewayOptions } from './gateway';
import type {
  MapPoint,
  MapPointReadResult,
  MapPointSnapshotPage,
} from '../../../../packages/contracts/map-snapshot';

const point = (index: number): MapPoint => ({
  kind: 'point',
  mmsi: String(413000000 + index),
  lat: 30,
  lon: 120,
  observedAt: '2026-10-24T00:00:00.000Z',
  sourceId: 'fixture',
  sogKnots: 10,
  cogDegrees: 90,
  headingDegrees: null,
  quality: [],
});
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function setup(extra: Partial<LiveGatewayOptions> = {}) {
  const server = createServer();
  const state: MapPointReadResult = {
    items: Array.from({ length: 5001 }, (_, i) => point(i)),
    total: 5001,
    generatedAt: new Date().toISOString(),
  };
  const readMap = vi.fn().mockResolvedValue({
    items: [],
    total: 0,
    sampled: false,
    truncated: false,
    generatedAt: state.generatedAt,
  });
  const readMapPoints = vi.fn().mockImplementation(async () => ({ ...state }));
  const gateway = attachLiveGateway(server, {
    origins: ['http://localhost'],
    authenticate: async () => ({ user: { id: 'alice' } }),
    readFeed: async (cursor) => ({ items: [], nextCursor: cursor }),
    readMap,
    readMapPoints,
    intervalMs: 15,
    ...extra,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const socket = new WebSocket(
    `ws://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/live`,
    { origin: 'http://localhost' },
  );
  const frames: {
    type: string;
    code?: string;
    version: number;
    data: MapPointSnapshotPage;
    remove: string[];
    snapshotId: string;
    sequence: number;
  }[] = [];
  socket.on('message', (data) => frames.push(JSON.parse(data.toString())));
  await once(socket, 'open');
  cleanups.push(async () => {
    socket.terminate();
    await gateway.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { socket, state, frames, readMap, readMapPoints };
}
const subscribe = (socket: WebSocket, version: number, mode = 'points') =>
  socket.send(
    JSON.stringify({
      type: 'viewport',
      version,
      query: { mode, bbox: '-180,-90,180,90', zoom: 2, hours: 24 },
    }),
  );
describe('points viewport streaming', () => {
  it('分钟范围订阅随时间推移移除刚过期船位，并保留边界内单船身份', async () => {
    let now = Date.parse('2026-10-25T00:00:00.000Z');
    const initial = [
      { ...point(0), observedAt: new Date(now - 15 * 60_000).toISOString() },
      { ...point(1), observedAt: new Date(now).toISOString() },
    ];
    const readMapPoints = vi.fn(async (query: Record<string, unknown>) => {
      const items = initial.filter(
        (item) => Date.parse(item.observedAt) >= now - Number(query.hours) * 3600_000,
      );
      return { items, total: items.length, generatedAt: new Date(now).toISOString() };
    });
    const { socket, frames } = await setup({ readMapPoints });
    socket.send(
      JSON.stringify({
        type: 'viewport',
        version: 1,
        query: { mode: 'points', bbox: '-180,-90,180,90', zoom: 2, hours: 0.25 },
      }),
    );
    await vi.waitFor(() =>
      expect(frames.find((frame) => frame.type === 'ais.points.snapshot')?.data.items).toHaveLength(
        2,
      ),
    );
    expect(readMapPoints).toHaveBeenCalledWith(expect.objectContaining({ hours: 0.25 }), 'alice');
    now++;
    await vi.waitFor(() =>
      expect(
        frames.some(
          (frame) => frame.type === 'ais.points.delta' && frame.remove.includes(point(0).mmsi),
        ),
      ).toBe(true),
    );
    expect(frames.some((frame) => frame.type === 'error')).toBe(false);
  });
  it('explicitly rejects an incomplete or oversized reader result', async () => {
    const { socket, frames } = await setup({
      readMapPoints: async () => ({
        items: [point(0)],
        total: 5001,
        generatedAt: new Date().toISOString(),
      }),
    });
    subscribe(socket, 1);
    await vi.waitFor(() =>
      expect(frames.some((frame) => frame.code === 'AIS_POINTS_DATA_LIMIT')).toBe(true),
    );
    expect(frames.some((frame) => frame.type === 'ais.points.snapshot')).toBe(false);
  });
  it('completes all chunks before ordered deltas and ignores duplicate viewport versions', async () => {
    const { socket, state, frames, readMap, readMapPoints } = await setup();
    subscribe(socket, 1);
    await vi.waitFor(() =>
      expect(
        frames.filter((f) => f.type === 'ais.points.snapshot' && f.data.complete),
      ).toHaveLength(1),
    );
    const snapshots = frames.filter((f) => f.type === 'ais.points.snapshot');
    expect(snapshots).toHaveLength(6);
    expect(snapshots.flatMap((f) => f.data.items)).toHaveLength(5001);
    expect(new Set(snapshots.map((f) => f.data.snapshotId)).size).toBe(1);
    expect(readMap).not.toHaveBeenCalled();
    expect(readMapPoints).toHaveBeenCalledWith(
      expect.not.objectContaining({ mode: 'points' }),
      'alice',
    );
    state.items = state.items.slice(1);
    state.total = 5000;
    await vi.waitFor(() =>
      expect(
        frames.some((f) => f.type === 'ais.points.delta' && f.remove.includes(point(0).mmsi)),
      ).toBe(true),
    );
    const deltas = frames.filter((f) => f.type === 'ais.points.delta');
    expect(deltas.map((f) => f.sequence)).toEqual(deltas.map((_, i) => i + 2));
    expect(deltas.every((f) => f.snapshotId === snapshots[0]!.data.snapshotId)).toBe(true);
    subscribe(socket, 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(frames.filter((f) => f.type === 'ais.points.snapshot')).toHaveLength(6);
  });
  it('discards an in-flight response after a newer viewport replaces it', async () => {
    let resolve!: (data: MapPointReadResult) => void;
    const readMapPoints = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      )
      .mockResolvedValue({ items: [], total: 0, generatedAt: new Date().toISOString() });
    const { socket, frames } = await setup({ readMapPoints });
    subscribe(socket, 1);
    await vi.waitFor(() => expect(readMapPoints).toHaveBeenCalledTimes(1));
    subscribe(socket, 2);
    await new Promise((done) => setTimeout(done, 20));
    resolve({ items: [point(1)], total: 1, generatedAt: new Date().toISOString() });
    await vi.waitFor(() =>
      expect(frames.some((f) => f.type === 'ais.points.snapshot' && f.version === 2)).toBe(true),
    );
    expect(frames.some((f) => f.type.startsWith('ais.points.') && f.version === 1)).toBe(false);
  });
  it('requires a stable authenticated owner only for the new points mode', async () => {
    const { socket, frames, readMapPoints } = await setup({ authenticate: async () => undefined });
    subscribe(socket, 1);
    await vi.waitFor(() =>
      expect(frames.some((f) => f.type === 'error' && f.code === 'AIS_POINTS_UNAUTHORIZED')).toBe(
        true,
      ),
    );
    expect(readMapPoints).not.toHaveBeenCalled();
  });
});
