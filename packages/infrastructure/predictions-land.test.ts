import { expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import type { PredictionPath } from '../contracts/reachability';
import { checkPredictionPaths } from './predictions-land';

function fixture() {
  let batch: { id: number; segments: { type: string; coordinates: number[][] }[] }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (!sql.startsWith('WITH paths')) return { rows: [] };
    batch = JSON.parse(values![1] as string);
    return { rows: batch.map((path) => ({ id: path.id, navigable: path.id !== 0 })) };
  });
  const client = { query, release: vi.fn() };
  const infra = { pool: { connect: vi.fn(async () => client) } } as unknown as Infrastructure;
  return { infra, query, client, batch: () => batch };
}

function paths(): PredictionPath[] {
  return Array.from({ length: 2048 }, (_, id) => ({
    id,
    points: Array.from({ length: 122 }, (_, minute) => ({
      at: new Date(Date.UTC(2026, 9, 25, 0, minute)).toISOString(),
      coordinate: [(minute < 17 ? 179 : -180) + minute * 0.001, id * 0.0001] as [number, number],
    })),
  }));
}

it('完整2048条路径按连续16条边分块，日期线和不足整块的尾部坐标原样保留', async () => {
  const input = paths();
  const db = fixture();
  const allowed = await checkPredictionPaths(db.infra, 'exact-land', input);
  expect(allowed).toHaveLength(2048);
  expect(allowed[0]).toBe(false);
  expect(allowed.slice(1).every(Boolean)).toBe(true);
  expect(db.batch()).toHaveLength(2048);
  for (const [index, path] of db.batch().entries()) {
    expect(path.id).toBe(index);
    expect(path.segments).toHaveLength(8);
    const reconstructed = path.segments.flatMap((segment, part) => {
      expect(segment.type).toBe('LineString');
      expect(segment.coordinates.length).toBeGreaterThanOrEqual(2);
      expect(segment.coordinates.length).toBeLessThanOrEqual(17);
      if (part) expect(segment.coordinates[0]).toEqual(path.segments[part - 1]!.coordinates.at(-1));
      return part ? segment.coordinates.slice(1) : segment.coordinates;
    });
    expect(reconstructed).toEqual(input[index]!.points.map((point) => point.coordinate));
  }
  expect(db.client.release).toHaveBeenCalledOnce();
});

it('分块批次仍要求完整且有序的2048条检查回执', async () => {
  const db = fixture();
  const original = db.query.getMockImplementation()!;
  db.query.mockImplementation(async (sql, values) => {
    const response = await original(sql, values);
    if (sql.startsWith('WITH paths')) response.rows = response.rows.slice(0, -1);
    return response;
  });
  await expect(checkPredictionPaths(db.infra, 'exact-land', paths())).rejects.toThrow(
    'every complete prediction path',
  );
  expect(db.client.release).toHaveBeenCalledOnce();
});

it('恰好整块与多一条边的路径均不产生单点块或遗漏尾边', async () => {
  const db = fixture();
  const original = paths();
  const lengths = [17, 18, 33];
  const input = original.map((path, index) => ({
    ...path,
    points: path.points.slice(0, lengths[index % lengths.length]),
  }));
  await checkPredictionPaths(db.infra, 'exact-land', input);
  for (const [index, path] of db.batch().entries()) {
    expect(path.segments.every((segment) => segment.coordinates.length >= 2)).toBe(true);
    const edges = path.segments.reduce((sum, segment) => sum + segment.coordinates.length - 1, 0);
    expect(edges).toBe(input[index]!.points.length - 1);
    expect(path.segments.at(-1)!.coordinates.at(-1)).toEqual(
      input[index]!.points.at(-1)!.coordinate,
    );
  }
});
