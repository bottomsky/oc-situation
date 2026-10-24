import { describe, expect, it } from 'vitest';
import { ReachabilityQuerySchema, NavigationWarningSchema } from './reachability';

describe('reachability contracts', () => {
  it('bounds the public query to one vessel and reproducible seed', () => {
    expect(ReachabilityQuerySchema.parse({ mmsi: '413000001' }).seed).toBe(20261024);
    expect(ReachabilityQuerySchema.safeParse({ mmsi: 'bad' }).success).toBe(false);
    expect(ReachabilityQuerySchema.safeParse({ mmsi: '413000001', pathCount: 10 }).success).toBe(
      false,
    );
  });
  it('requires finite warning lifetime and explicit applicability', () => {
    const warning = {
      id: 'w',
      reviewStatus: 'confirmed',
      effectiveFrom: '2026-10-24T00:00:00Z',
      effectiveTo: '2026-10-24T01:00:00Z',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 0],
          ],
        ],
      },
      applicability: { kind: 'all' },
    };
    expect(NavigationWarningSchema.safeParse(warning).success).toBe(true);
    expect(NavigationWarningSchema.safeParse({ ...warning, effectiveTo: null }).success).toBe(
      false,
    );
    expect(
      NavigationWarningSchema.safeParse({ ...warning, applicability: undefined }).success,
    ).toBe(false);
    expect(
      NavigationWarningSchema.safeParse({ ...warning, effectiveTo: warning.effectiveFrom }).success,
    ).toBe(false);
  });
});
