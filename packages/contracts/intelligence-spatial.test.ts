import { describe, expect, it } from 'vitest';
import { GeometrySchema, RelationInputSchema } from './intelligence-spatial';
describe('intelligence spatial contracts', () => {
  it('validates finite WGS84 coordinates and closed rings', () => {
    expect(GeometrySchema.safeParse({ type: 'Point', coordinates: [181, 20] }).success).toBe(false);
    expect(GeometrySchema.safeParse({ type: 'Point', coordinates: [NaN, 20] }).success).toBe(false);
    expect(
      GeometrySchema.safeParse({
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [1, 0],
            [1, 1],
            [0, 1],
          ],
        ],
      }).success,
    ).toBe(false);
    expect(
      GeometrySchema.safeParse({
        type: 'MultiPoint',
        coordinates: [
          [120, 30],
          [121, 31],
        ],
      }).success,
    ).toBe(true);
  });
  it('requires evidence targets and impact period', () => {
    expect(RelationInputSchema.safeParse({ kind: 'mentions', basis: '原文' }).success).toBe(false);
    expect(
      RelationInputSchema.safeParse({ kind: 'impacts', objectId: 'port', basis: '原文' }).success,
    ).toBe(false);
    expect(
      RelationInputSchema.parse({ kind: 'mentions', objectId: 'port', basis: '原文' }).reviewStatus,
    ).toBe('candidate');
  });
});
