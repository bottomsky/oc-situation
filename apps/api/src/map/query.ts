import { z } from 'zod';
import { BboxSchema, type Bbox } from '@ais/contracts';
import { parse } from '../common';
export const MapQuerySchema = z.strictObject({
  bbox: z.string().max(150),
  zoom: z.coerce.number().min(0).max(22).default(3),
  hours: z.coerce
    .number()
    .min(1 / 60)
    .max(720)
    .default(24),
  sourceId: z.string().max(200).optional(),
  shipType: z.coerce.number().int().min(1).max(99).optional(),
});
export function bounds(bbox: Bbox): Bbox[] {
  return bbox[0] <= bbox[2]
    ? [bbox]
    : [
        [bbox[0], bbox[1], 180, bbox[3]],
        [-180, bbox[1], bbox[2], bbox[3]],
      ];
}
export function parseMapQuery(input: unknown) {
  const data = parse(MapQuerySchema, input);
  const bbox = parse(BboxSchema, data.bbox.split(',').map(Number));
  return { ...data, bbox };
}
