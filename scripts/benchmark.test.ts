import { describe, expect, it } from 'vitest';
import { percentile, makeSyntheticPositions, benchmarkPhases } from './benchmark';
describe('synthetic benchmark accounting', () => {
  it('counts expanded position observations and keeps deterministic identifiers', () => {
    const data = makeSyntheticPositions('run', 499_999, 3, 500_000, '2026-10-01T00:00:00.000Z');
    expect(data.map((x) => x.mmsi)).toEqual(['500499999', '500000000', '500000001']);
    expect(data).toHaveLength(3);
    expect(data[0]).not.toHaveProperty('fields');
  });
  it('has the approved full duration and a distinct smoke mode', () => {
    expect(benchmarkPhases(true)).toEqual([
      { name: 'steady', seconds: 3600, rate: 1000 },
      { name: 'peak', seconds: 300, rate: 3000 },
      { name: 'recovery', seconds: 600, rate: 1000 },
    ]);
    expect(benchmarkPhases(false)[0]?.seconds).toBe(15);
  });
  it('reports null for unmeasured percentiles', () => {
    expect(percentile([], 0.95)).toBeNull();
    expect(percentile([4, 1, 2, 3], 0.95)).toBe(4);
  });
});
