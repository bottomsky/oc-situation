import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import { MapPointSnapshotService } from './map-snapshots';
import type { MapPointQuery } from '../contracts/map-snapshot';

const query: MapPointQuery = { bbox: [-180, -90, 180, 90], zoom: 3, hours: 24 };
const observation = (index: number) => ({
  mmsi: String(413000000 + index),
  lat: 30,
  lon: 120,
  observedAt: '2026-10-24T00:00:00.000Z',
  sourceId: 'fixture',
  sogKnots: 12,
  cogDegrees: 90,
  headingDegrees: null,
  quality: [],
});
function fixture(count = 5001, options = {}) {
  const sql = vi.fn().mockResolvedValue({
    rows: Array.from({ length: count }, (_, i) => ({ observation: observation(i) })),
  });
  const service = new MapPointSnapshotService(
    { pool: { query: sql } } as unknown as Infrastructure,
    options,
  );
  return { service, sql };
}
describe('complete bounded map point snapshots', () => {
  it.each([1 / 60, 0.25, 0.5, 24])(
    '单船快照保留%s小时范围，并按秒传递相对观测截止条件',
    async (hours) => {
      const { service, sql } = fixture(1);
      await expect(service.page('alice', { ...query, hours })).resolves.toMatchObject({
        complete: true,
        total: 1,
      });
      expect(sql.mock.calls[0]![1][0]).toBe(hours);
      expect(sql.mock.calls[0]![0]).toContain('make_interval(secs=>');
      expect(sql.mock.calls[0]![0]).not.toContain('make_interval(hours=>');
    },
  );
  it('freezes and pages every vessel above the legacy 5000 limit at low zoom', async () => {
    const { service, sql } = fixture();
    let page = await service.page('alice', query);
    const items = [...page.items];
    while (!page.complete) {
      page = await service.page('alice', { snapshotId: page.snapshotId, cursor: page.nextCursor! });
      items.push(...page.items);
    }
    expect(items).toHaveLength(5001);
    expect(new Set(items.map((point) => point.mmsi)).size).toBe(5001);
    expect(page.total).toBe(5001);
    expect(page.sequence).toBe(1);
    expect(sql).toHaveBeenCalledTimes(1);
    expect(sql.mock.calls[0]?.[0]).not.toMatch(/count\(\*\) OVER|GROUP BY|LIMIT 5000\b/i);
  });
  it('rejects unauthenticated, foreign, expired, invalid cursor and over-capacity snapshots explicitly', async () => {
    let now = 1000;
    const { service } = fixture(10, { now: () => now, ttlMs: 60_000 });
    await expect(service.page('', query)).rejects.toMatchObject({ category: 'unauthorized' });
    const page = await service.page('alice', query);
    await expect(
      service.page('bob', { snapshotId: page.snapshotId, cursor: '0' }),
    ).rejects.toMatchObject({ category: 'gone' });
    await expect(
      service.page('alice', { snapshotId: page.snapshotId, cursor: '-1' }),
    ).rejects.toMatchObject({ category: 'invalid_input' });
    now += 60_000;
    await expect(
      service.page('alice', { snapshotId: page.snapshotId, cursor: '0' }),
    ).rejects.toMatchObject({ category: 'gone' });
    const limited = fixture(11, { maxPoints: 10 });
    await expect(limited.service.page('alice', query)).rejects.toMatchObject({
      category: 'data_limit',
    });
  });
  it('counts pending work toward per-owner and global admission limits and releases failed reservations', async () => {
    const { service, sql } = fixture(1, { maxSnapshots: 3 });
    const resolves: ((result: unknown) => void)[] = [];
    sql.mockImplementation(
      () =>
        new Promise((done) => {
          resolves.push(done);
        }),
    );
    const first = service.page('alice', query);
    const second = service.page('alice', query);
    await expect(service.page('alice', query)).rejects.toMatchObject({ category: 'busy' });
    const third = service.page('bob', query);
    await expect(service.page('charlie', query)).rejects.toMatchObject({ category: 'busy' });
    for (const resolve of resolves)
      resolve({ rows: Array.from({ length: 1001 }, (_, i) => ({ observation: observation(i) })) });
    await Promise.all([first, second, third]);
    await expect(service.page('alice', query)).rejects.toMatchObject({ category: 'busy' });
    sql.mockRejectedValueOnce(new Error('database failure'));
    await expect(service.page('charlie', query)).rejects.toMatchObject({ category: 'busy' });
  });
  it('rejects a snapshot exceeding its byte budget instead of trimming its points', async () => {
    const { service } = fixture(10, { maxBytes: 100 });
    await expect(service.page('alice', query)).rejects.toMatchObject({ category: 'data_limit' });
  });
  it('replays a cursor without changing its snapshot or reading a moving database', async () => {
    const { service } = fixture(2001);
    const page = await service.page('alice', query);
    const next = { snapshotId: page.snapshotId, cursor: page.nextCursor! };
    expect(await service.page('alice', next)).toEqual(await service.page('alice', next));
  });
  it('releases reservations when querying fails', async () => {
    const { service, sql } = fixture(1);
    sql
      .mockRejectedValueOnce(new Error('query failed'))
      .mockRejectedValueOnce(new Error('query failed'));
    await expect(service.page('alice', query)).rejects.toMatchObject({ category: 'unavailable' });
    await expect(service.page('alice', query)).rejects.toMatchObject({ category: 'unavailable' });
    await expect(service.page('alice', query)).resolves.toMatchObject({ total: 1 });
  });
  it('reclaims completed snapshots under admission pressure so dragging can continue', async () => {
    const { service } = fixture(1);
    const first = await service.page('alice', query);
    await service.page('alice', query);
    await expect(service.page('alice', query)).resolves.toMatchObject({ total: 1, complete: true });
    await expect(
      service.page('alice', { snapshotId: first.snapshotId, cursor: '0' }),
    ).rejects.toMatchObject({ category: 'gone' });
  });
  it('supports more than fifty thousand points without dropping the last page', async () => {
    const { service } = fixture(50_001);
    const first = await service.page('alice', query);
    const last = await service.page('alice', { snapshotId: first.snapshotId, cursor: '50000' });
    expect(first.total).toBe(50_001);
    expect(last).toMatchObject({ complete: true, nextCursor: null });
    expect(last.items.map((item) => item.mmsi)).toEqual([observation(50_000).mmsi]);
  });
  it('releases abandoned pagination immediately and keeps another owner snapshot intact', async () => {
    const { service } = fixture(2001);
    const bob = await service.page('bob', query);
    for (let index = 0; index < 4; index++) {
      const page = await service.page('alice', query);
      expect(service.release('alice', page.snapshotId)).toBe(true);
      expect(service.release('alice', page.snapshotId)).toBe(false);
    }
    expect(service.release('alice', bob.snapshotId)).toBe(false);
    await expect(
      service.page('bob', { snapshotId: bob.snapshotId, cursor: bob.nextCursor! }),
    ).resolves.toMatchObject({ total: 2001 });
    expect(() => service.release('', bob.snapshotId)).toThrow();
  });
});
