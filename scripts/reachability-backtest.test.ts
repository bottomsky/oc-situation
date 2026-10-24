import { describe, expect, it } from 'vitest';
import { createGeoJsonLandChecker, executeReachabilityBacktest } from './reachability-backtest';
import type { PredictionPath } from '../packages/contracts/reachability';

const land = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
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
    },
  ],
};
const path = (lat: number): PredictionPath => ({
  id: 0,
  points: [
    { at: '2026-10-24T00:00:00Z', coordinate: [0, lat] },
    { at: '2026-10-24T00:01:00Z', coordinate: [1, lat] },
  ],
});
describe('offline reachability backtest command', () => {
  it('checks complete segments and rejects unknown coverage', async () => {
    const checker = createGeoJsonLandChecker(land, [-2, -2, 2, 2]);
    expect(await checker([path(0), path(1.5), path(3)])).toEqual([false, true, false]);
  });
  it('validates imported voyage data and reports missing land as inapplicable', async () => {
    await expect(
      executeReachabilityBacktest({
        voyages: [{ voyageId: 'bad' }],
        splitAt: '2026-10-23T00:00:00Z',
      }),
    ).rejects.toThrow();
    const report = await executeReachabilityBacktest({
      voyages: [],
      splitAt: '2026-10-23T00:00:00Z',
    });
    expect(report.status).toBe('model_not_applicable');
    expect(report.landConstraint).toBe('unavailable');
    expect(report.calibrationState).toBe('uncalibrated');
    await expect(
      executeReachabilityBacktest({
        voyages: [],
        splitAt: '2026-10-23T00:00:00Z',
        land,
        coverage: [-2, -2, 2, 2],
      }),
    ).rejects.toThrow('quality');
    expect(() => createGeoJsonLandChecker({ ...land, displayOnly: true }, [-2, -2, 2, 2])).toThrow(
      'Display',
    );
  });
});
