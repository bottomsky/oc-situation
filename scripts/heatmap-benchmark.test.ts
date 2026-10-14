import { describe, expect, it } from 'vitest';
import { heatmapBenchmarkConfig, heatmapResponseBytes } from './heatmap-benchmark';
import type { HeatmapResult } from '../packages/contracts/heatmap';

const isolated = {
  AIS_HEATMAP_BENCH: '1',
  DATABASE_URL: 'postgresql://ais:local@127.0.0.1:15433/ais',
  CLICKHOUSE_URL: 'http://127.0.0.1:18124',
  NATS_URL: 'nats://127.0.0.1:14223',
  S3_ENDPOINT: 'http://127.0.0.1:19001',
};
describe('heatmap benchmark isolated database guard', () => {
  it('measures UTF-8 serialized response bytes and records failed queries as null', () => {
    const result: HeatmapResult = {
      query: {
        bbox: [0, 0, 1, 1],
        from: '2026-10-14T00:00:00.000Z',
        to: '2026-10-14T01:00:00.000Z',
        sourceId: '中文来源',
      },
      grid: { level: 0, cellDegrees: 360 },
      cells: [],
      totalVessels: 0,
      generatedAt: '2026-10-14T01:00:00.000Z',
      metric: 'unique_vessels',
      shipTypeBasis: 'current_profile',
    };
    const serialized = JSON.stringify(result);
    expect(heatmapResponseBytes(result)).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(heatmapResponseBytes(result)).toBeGreaterThan(serialized.length);
    expect(heatmapResponseBytes(null)).toBeNull();
  });
  it('requires opt-in and fixed isolated ports before any write', () => {
    expect(() => heatmapBenchmarkConfig({})).toThrow();
    expect(() =>
      heatmapBenchmarkConfig({ ...isolated, CLICKHOUSE_URL: 'http://127.0.0.1:18123' }),
    ).toThrow();
    expect(() =>
      heatmapBenchmarkConfig({
        ...isolated,
        DATABASE_URL: 'postgresql://ais:local@example.com:15433/ais',
      }),
    ).toThrow();
    expect(heatmapBenchmarkConfig(isolated)).toEqual({ rows: 100000, repeats: 5 });
  });
  it('accepts a million rows but rejects undersized or unbounded benchmarks', () => {
    expect(
      heatmapBenchmarkConfig({
        ...isolated,
        AIS_HEATMAP_BENCH_ROWS: '1000000',
        AIS_HEATMAP_BENCH_REPEATS: '7',
      }),
    ).toEqual({ rows: 1000000, repeats: 7 });
    expect(() => heatmapBenchmarkConfig({ ...isolated, AIS_HEATMAP_BENCH_ROWS: '1000' })).toThrow();
    expect(() =>
      heatmapBenchmarkConfig({ ...isolated, AIS_HEATMAP_BENCH_REPEATS: '100' }),
    ).toThrow();
  });
});
