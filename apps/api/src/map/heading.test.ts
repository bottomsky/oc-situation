import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import { MapController, MapResponseSchema } from './controller';

const point = {
  kind: 'point' as const,
  mmsi: '413000001',
  lat: 30,
  lon: 120,
  observedAt: '2026-10-01T00:00:00.000Z',
  sourceId: 'fixture',
  sogKnots: 10,
  cogDegrees: 90,
  quality: [],
};

const response = (item: unknown) => ({
  items: [item],
  sampled: false,
  truncated: false,
  total: 1,
  generatedAt: '2026-10-01T00:00:00.000Z',
});

describe('map vessel heading', () => {
  it.each([0, 270, null, undefined])(
    'returns heading %s from latest observation',
    async (heading) => {
      const observation = { ...point, headingDegrees: heading };
      const query = vi.fn().mockResolvedValue({ rows: [{ observation, total: 1 }] });
      const api = new MapController({ pool: { query } } as unknown as Infrastructure);

      const result = await api.get({ bbox: '-180,-90,180,90', zoom: 8 });

      expect(result.items).toEqual([{ ...point, headingDegrees: heading ?? null }]);
      expect(MapResponseSchema.parse(result)).toEqual(result);
    },
  );

  it.each([0, 359.9, null])('preserves valid heading %s in the response schema', (heading) => {
    const result = response({ ...point, headingDegrees: heading });
    expect(MapResponseSchema.parse(result)).toEqual(result);
  });

  it.each([-1, 360, 511, undefined])('rejects invalid or absent heading %s', (heading) => {
    expect(
      MapResponseSchema.safeParse(response({ ...point, headingDegrees: heading })).success,
    ).toBe(false);
  });

  it('keeps spatial clusters without a vessel heading', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          x: 1,
          y: 2,
          lat: 30,
          lon: 120,
          count: 2,
          west: 119,
          south: 29,
          east: 121,
          north: 31,
          total: 2,
          cells: 1,
        },
      ],
    });
    const api = new MapController({ pool: { query } } as unknown as Infrastructure);

    const result = await api.get({ bbox: '-180,-90,180,90', zoom: 3 });

    expect(result.items).toEqual([
      {
        kind: 'cluster',
        clusterId: '3:1:2',
        lat: 30,
        lon: 120,
        count: 2,
        bbox: [119, 29, 121, 31],
      },
    ]);
    expect(MapResponseSchema.parse(result)).toEqual(result);
  });
});
