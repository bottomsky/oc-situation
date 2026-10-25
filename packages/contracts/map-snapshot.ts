import { z } from 'zod';
const BboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((bbox) => bbox[1] <= bbox[3], 'South must not exceed north');

export const MAP_POINT_PAGE_SIZE = 1000;
export const MAP_POINT_MAX_POINTS = 100_000;
export const MapPointSchema = z.strictObject({
  kind: z.literal('point'),
  mmsi: z.string(),
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  observedAt: z.iso.datetime(),
  sourceId: z.string(),
  sogKnots: z.number().nullable(),
  cogDegrees: z.number().nullable(),
  headingDegrees: z.number().min(0).lt(360).nullable(),
  quality: z.array(z.string()),
});
export const MapPointQuerySchema = z.strictObject({
  bbox: BboxSchema,
  zoom: z.number().min(0).max(22).default(3),
  hours: z
    .number()
    .min(1 / 60)
    .max(720)
    .default(24),
  sourceId: z.string().max(200).optional(),
  shipType: z.number().int().min(1).max(99).optional(),
});
export const MapPointSnapshotPageSchema = z.strictObject({
  snapshotId: z.uuid(),
  sequence: z.number().int().positive(),
  items: z.array(MapPointSchema).max(MAP_POINT_PAGE_SIZE),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
  generatedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type MapPoint = z.infer<typeof MapPointSchema>;
export type MapPointQuery = z.infer<typeof MapPointQuerySchema>;
export type MapPointSnapshotPage = z.infer<typeof MapPointSnapshotPageSchema>;
export interface MapPointReadResult {
  items: MapPoint[];
  total: number;
  generatedAt: string;
}
export interface MapPointDelta {
  snapshotId: string;
  sequence: number;
  upsert: MapPoint[];
  remove: string[];
  total: number;
  generatedAt: string;
}
