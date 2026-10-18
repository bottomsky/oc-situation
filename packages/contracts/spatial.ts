import { z } from 'zod';
import { GeometrySchema } from './intelligence-spatial';
export const SpatialPositionSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
]);
export const SpatialBboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3], 'South must precede north');
export const CircleRegionSchema = z.strictObject({
  kind: z.literal('circle'),
  center: SpatialPositionSchema,
  radiusMeters: z.number().min(100).max(2000000),
});
export const SpatialRegionSchema = z.discriminatedUnion('kind', [
  CircleRegionSchema,
  z.strictObject({ kind: z.literal('bbox'), bbox: SpatialBboxSchema }),
  z.strictObject({
    kind: z.literal('polygon'),
    geometry: GeometrySchema.refine(
      (g) => g.type === 'Polygon' || g.type === 'MultiPolygon',
      'Polygon required',
    ),
  }),
]);
export type CircleRegion = z.infer<typeof CircleRegionSchema>;
export type SpatialRegion = z.infer<typeof SpatialRegionSchema>;
