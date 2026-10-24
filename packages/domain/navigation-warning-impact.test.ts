import { describe, expect, it } from 'vitest';
import { evaluateNavigationWarningImpact } from './navigation-warning-impact';
import { predictVesselReachability } from './reachability';
import type {
  NavigationWarning,
  PredictionPath,
  ReachabilityPrediction,
} from '../contracts/reachability';

const warning: NavigationWarning = {
  id: 'w',
  reviewStatus: 'confirmed',
  effectiveFrom: '2026-10-24T00:30:00Z',
  effectiveTo: '2026-10-24T00:31:00Z',
  geometry: {
    type: 'Polygon',
    coordinates: [
      [
        [0.4, -1],
        [0.6, -1],
        [0.6, 1],
        [0.4, 1],
        [0.4, -1],
      ],
    ],
  },
  applicability: { kind: 'all' },
};
async function prediction(paths: PredictionPath[]): Promise<ReachabilityPrediction> {
  const result = await predictVesselReachability({
    mmsi: '413000001',
    asOf: '2026-10-24T00:30:00Z',
    observations: [],
  });
  result.summary.status = 'ready';
  result.paths = paths;
  return result;
}
const path = (id: number, lat: number): PredictionPath => ({
  id,
  points: [
    { at: '2026-10-24T00:30:00Z', coordinate: [0, lat] },
    { at: '2026-10-24T00:31:00Z', coordinate: [1, lat] },
  ],
});

describe('warning path intersection', () => {
  it('treats warning expiry as an exclusive temporal boundary', async () => {
    const result = evaluateNavigationWarningImpact({
      prediction: await prediction([path(0, 0)]),
      warnings: [{ ...warning, effectiveTo: '2026-10-24T00:30:24Z' }],
      vessel: { mmsi: '413000001' },
    });
    expect(result.impacts[0]!.hitPaths).toBe(0);
  });
  it('rejects a different vessel identity rather than reusing another forecast', async () => {
    expect(() =>
      evaluateNavigationWarningImpact({
        prediction: {
          summary: { mmsi: '413000001' } as ReachabilityPrediction['summary'],
          paths: [],
        },
        warnings: [],
        vessel: { mmsi: '413000002' },
      }),
    ).toThrow('vessel');
  });
  it('finds a segment crossing with both endpoints outside and a precise first entry interval', async () => {
    const result = evaluateNavigationWarningImpact({
      prediction: await prediction([path(0, 0), path(1, 2)]),
      warnings: [warning],
      vessel: { mmsi: '413000001', shipType: 70 },
    });
    expect(result.impacts[0]!.probability).toBe(0.5);
    expect(result.impacts[0]!.firstEntry).toEqual({
      from: '2026-10-24T00:30:24.000Z',
      to: '2026-10-24T00:30:24.000Z',
    });
  });
  it('clips geometry to effective time and gives an upper uncertainty bound for zero hits', async () => {
    const result = evaluateNavigationWarningImpact({
      prediction: await prediction([path(0, 0)]),
      warnings: [{ ...warning, effectiveFrom: '2026-10-24T00:30:50Z' }],
      vessel: { mmsi: '413000001', shipType: null },
    });
    expect(result.impacts[0]!.hitPaths).toBe(0);
    expect(result.impacts[0]!.confidenceInterval[1]).toBeGreaterThan(0);
  });
  it('rejects unreviewed, unresolved applicability and missing lifetime warnings', async () => {
    const result = evaluateNavigationWarningImpact({
      prediction: await prediction([path(0, 0)]),
      warnings: [
        { ...warning, reviewStatus: 'pending' },
        { ...warning, effectiveTo: null },
        { ...warning, applicability: { kind: 'unknown' } },
        { ...warning, applicability: { kind: 'ship_types', shipTypes: [80] } },
      ],
      vessel: { mmsi: '413000001', shipType: 70 },
    });
    expect(result.impacts).toEqual([]);
    expect(result.skipped).toHaveLength(4);
  });
  it('excludes polygon holes, counts each path once and handles date-line crossings', async () => {
    const hole = {
      ...warning,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [0, -1],
            [1, -1],
            [1, 1],
            [0, 1],
            [0, -1],
          ],
          [
            [0.1, -0.5],
            [0.9, -0.5],
            [0.9, 0.5],
            [0.1, 0.5],
            [0.1, -0.5],
          ],
        ] as [number, number][][],
      },
    };
    const withinHole: PredictionPath = {
      id: 0,
      points: [
        { at: warning.effectiveFrom, coordinate: [0.2, 0] },
        { at: warning.effectiveTo, coordinate: [0.8, 0] },
      ],
    };
    expect(
      evaluateNavigationWarningImpact({
        prediction: await prediction([withinHole]),
        warnings: [hole],
        vessel: { mmsi: '413000001' },
      }).impacts[0]!.hitPaths,
    ).toBe(0);
    const dated = {
      ...warning,
      geometry: {
        type: 'Polygon' as const,
        coordinates: [
          [
            [179.9, -1],
            [-179.9, -1],
            [-179.9, 1],
            [179.9, 1],
            [179.9, -1],
          ],
        ] as [number, number][][],
      },
    };
    const crossing: PredictionPath = {
      id: 1,
      points: [
        { at: warning.effectiveFrom, coordinate: [179.8, 0] },
        { at: warning.effectiveTo, coordinate: [-179.8, 0] },
      ],
    };
    expect(
      evaluateNavigationWarningImpact({
        prediction: await prediction([crossing]),
        warnings: [dated],
        vessel: { mmsi: '413000001' },
      }).impacts[0]!.hitPaths,
    ).toBe(1);
  });
  it('never modifies baseline prediction paths when applying a warning', async () => {
    const observations = [0, 10, 20, 30].map((minute) => ({
      observedAt: new Date(Date.parse('2026-10-24T00:00:00Z') + minute * 60000).toISOString(),
      longitude: 120 + minute / 600,
      latitude: 20,
      speedOverGround: 10,
      courseOverGround: 90,
    }));
    const result = await predictVesselReachability(
      { mmsi: '413000001', asOf: '2026-10-24T00:30:00Z', observations },
      { checkPaths: async (paths) => paths.map(() => true) },
    );
    const before = JSON.stringify(result.paths);
    evaluateNavigationWarningImpact({
      prediction: result,
      warnings: [warning],
      vessel: { mmsi: '413000001' },
    });
    expect(JSON.stringify(result.paths)).toBe(before);
  });
});
