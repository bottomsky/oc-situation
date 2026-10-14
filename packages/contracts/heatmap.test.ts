import { describe, expect, it } from 'vitest';
import * as contracts from './index';

const query = {
  bbox: [179, -10, -179, 10],
  from: '2026-10-12T00:00:00Z',
  to: '2026-10-13T00:00:00Z',
};
const result = {
  query,
  grid: { level: 2, cellDegrees: 90 },
  cells: [
    { id: '2:0:0', x: 0, y: 0, lon: -135, lat: -45, vesselCount: 2 },
    { id: '2:3:0', x: 3, y: 0, lon: 135, lat: -45, vesselCount: 2 },
  ],
  totalVessels: 2,
  generatedAt: '2026-10-13T00:01:00Z',
  metric: 'unique_vessels',
  shipTypeBasis: 'current_profile',
};

describe('heatmap contracts', () => {
  it('exports the bounded query and durable result contracts', () => {
    expect(contracts).toHaveProperty('HeatmapQuerySchema');
    expect(contracts).toHaveProperty('HeatmapResultSchema');
    expect(contracts).toHaveProperty('AgentHeatmapResultSchema');
  });
  it('accepts dateline queries and independently deduplicated vessel totals', () => {
    expect(contracts.HeatmapQuerySchema.parse(query)).toEqual(query);
    expect(contracts.HeatmapResultSchema.parse(result)).toEqual(result);
  });
  it('bounds time spans, UTC times, vessel selections, and query fields', () => {
    for (const invalid of [
      { ...query, to: query.from },
      { ...query, to: '2026-10-20T00:00:00Z' },
      { ...query, from: '2026-10-12T08:00:00+08:00' },
      { ...query, bbox: [0, 10, 1, -10] },
      { ...query, mmsis: Array.from({ length: 101 }, (_, i) => String(412000000 + i)) },
      { ...query, mmsis: ['412000001', '412000001'] },
      { ...query, shipType: 100 },
      { ...query, execute: 'untrusted' },
    ]) {
      expect(contracts.HeatmapQuerySchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('checks retention against explicit execution time while allowing persisted history', () => {
    expect(() =>
      contracts.validateHeatmapQueryWindow(query, new Date('2026-10-14T00:00:00Z')),
    ).not.toThrow();
    expect(() =>
      contracts.validateHeatmapQueryWindow(query, new Date('2026-12-14T00:00:00Z')),
    ).toThrow();
    expect(() =>
      contracts.validateHeatmapQueryWindow(query, new Date('2026-10-12T12:00:00Z')),
    ).toThrow();
    expect(contracts.HeatmapResultSchema.safeParse(result).success).toBe(true);
  });
  it('validates fixed global grids and rejects duplicate or excessive cells', () => {
    for (const invalid of [
      { ...result, grid: { level: 21, cellDegrees: 360 / 2 ** 21 } },
      { ...result, grid: { level: 2, cellDegrees: 45 } },
      { ...result, cells: [result.cells[0], result.cells[0]] },
      { ...result, cells: Array.from({ length: 4097 }, () => result.cells[0]) },
      { ...result, cells: [{ ...result.cells[0], x: 4 }] },
      { ...result, cells: [{ ...result.cells[0], vesselCount: 3 }] },
    ]) {
      expect(contracts.HeatmapResultSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it('accepts empty agent results with an input revision and the whole-world level zero grid', () => {
    expect(
      contracts.AgentHeatmapResultSchema.safeParse({
        ...result,
        kind: 'ais_heatmap',
        version: 1,
        inputRevision: 3,
        cells: [],
        totalVessels: 0,
      }).success,
    ).toBe(true);
    expect(
      contracts.HeatmapResultSchema.safeParse({
        ...result,
        grid: { level: 0, cellDegrees: 360 },
        cells: [{ id: '0:0:0', x: 0, y: 0, lon: 0, lat: 0, vesselCount: 2 }],
      }).success,
    ).toBe(true);
  });
  it('exposes heatmap intent and explicit ambiguous time selection', () => {
    expect(contracts.AgentIntentSchema.safeParse('ais_heatmap').success).toBe(true);
    expect(
      contracts.AgentSelectionSchema.safeParse({ purpose: 'ais_heatmap', heatmapTimeUnclear: true })
        .success,
    ).toBe(true);
  });
});
