import { describe, expect, it } from 'vitest';
import { parseHeatmapQuery } from './heatmap-query';

const input = {
  bbox: '170,-10,-170,10',
  from: '2026-10-10T00:00:00.000Z',
  to: '2026-10-11T00:00:00.000Z',
};
describe('heatmap HTTP query', () => {
  it('parses comma-separated bounds, MMSIs and the current profile type', () => {
    expect(
      parseHeatmapQuery({
        ...input,
        mmsis: '123456789,987654321',
        shipType: '70',
        sourceId: 'fixture',
      }),
    ).toEqual({
      ...input,
      bbox: [170, -10, -170, 10],
      mmsis: ['123456789', '987654321'],
      shipType: 70,
      sourceId: 'fixture',
    });
  });
  it('rejects empty coordinates, unknown fields and over-limit MMSIs', () => {
    expect(() => parseHeatmapQuery({ ...input, bbox: ',-10,-170,10' })).toThrow();
    expect(() => parseHeatmapQuery({ ...input, limit: '50000' })).toThrow();
    expect(() =>
      parseHeatmapQuery({
        ...input,
        mmsis: Array.from({ length: 101 }, (_, i) => String(123456789 + i)).join(','),
      }),
    ).toThrow();
  });
});
