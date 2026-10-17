import { describe, expect, it } from 'vitest';
import {
  VesselTracksQuerySchema,
  VesselTracksResultSchema,
  validateVesselTracksWindow,
} from './vessel-tracks';

const input = {
  bbox: [170, -10, -170, 10],
  from: '2026-10-16T00:00:00.000Z',
  to: '2026-10-17T00:00:00.000Z',
  selector: { query: '  海巡  ', model: ' Type 052D ' },
};
describe('bounded vessel tracks contracts', () => {
  it('normalizes selector text and defaults while allowing a date-line region', () => {
    expect(VesselTracksQuerySchema.parse(input)).toMatchObject({
      selector: { query: '海巡', model: 'Type 052D' },
      maxVessels: 20,
      maxPointsPerVessel: 500,
    });
  });
  it('rejects empty, duplicate and over-budget selectors and unknown properties', () => {
    for (const selector of [
      {},
      { query: ' ' },
      { shipTypes: [70, 70] },
      { mmsis: ['012345678'] },
      { shipTypes: [] },
    ])
      expect(VesselTracksQuerySchema.safeParse({ ...input, selector }).success).toBe(false);
    expect(
      VesselTracksQuerySchema.safeParse({ ...input, maxVessels: 50, maxPointsPerVessel: 1000 })
        .success,
    ).toBe(false);
    expect(VesselTracksQuerySchema.safeParse({ ...input, script: 'anything' }).success).toBe(false);
  });
  it('uses an explicit fixed clock and keeps retained result schemas timeless', () => {
    expect(() => validateVesselTracksWindow(input, new Date(input.to))).not.toThrow();
    expect(() => validateVesselTracksWindow(input, new Date(input.from))).toThrow();
    expect(() => validateVesselTracksWindow(input, new Date('2026-12-01T00:00:00Z'))).toThrow();
    expect(VesselTracksQuerySchema.safeParse(input).success).toBe(true);
  });
  it('validates counts, bounded segments and temporal positions in persisted results', () => {
    const result = {
      query: VesselTracksQuerySchema.parse(input),
      asOf: input.to,
      generatedAt: input.to,
      shipTypeBasis: 'current_profile',
      selectionBasis: 'historical_observation_in_bbox',
      trackScope: 'full_time_window',
      returnedVessels: 1,
      matchedVesselsLowerBound: 1,
      hasMoreVessels: false,
      tracks: [
        {
          mmsi: '123456789',
          name: null,
          shipType: null,
          segments: [{ points: [{ lon: 179, lat: 0, observedAt: input.from }] }],
          total: 1,
          returned: 1,
          sampled: false,
          truncated: false,
        },
      ],
    };
    expect(VesselTracksResultSchema.safeParse(result).success).toBe(true);
    expect(VesselTracksResultSchema.safeParse({ ...result, returnedVessels: 2 }).success).toBe(
      false,
    );
    expect(
      VesselTracksResultSchema.safeParse({
        ...result,
        tracks: [{ ...result.tracks[0], returned: 2 }],
      }).success,
    ).toBe(false);
    expect(
      VesselTracksResultSchema.safeParse({
        ...result,
        tracks: [
          {
            ...result.tracks[0],
            segments: [{ points: [{ lon: 0, lat: 0, observedAt: input.to }] }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
