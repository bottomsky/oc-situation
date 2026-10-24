import { describe, expect, it } from 'vitest';
import { predictionResultBbox } from './prediction-bounds';
describe('prediction evidence map bounds', () => {
  it('uses the shortest date-line-spanning bounds', () => {
    expect(
      predictionResultBbox(
        [
          [179, 10],
          [-179, 12],
          [-178, 11],
        ],
        [-180, -90, 180, 90],
      ),
    ).toEqual([179, 10, -178, 12]);
  });
  it('uses a point for a single latest AIS and falls back only without valid geometry', () => {
    expect(predictionResultBbox([[120, 30]], [-180, -90, 180, 90])).toEqual([120, 30, 120, 30]);
    expect(predictionResultBbox([], [-180, -90, 180, 90])).toEqual([-180, -90, 180, 90]);
  });
});
