import { z } from 'zod';
import { HeatmapQuerySchema } from '../../../../packages/contracts/heatmap';
import { parse } from '../common';

export const HeatmapHttpQuerySchema = z.strictObject({
  bbox: z
    .string()
    .max(150)
    .refine(
      (value) =>
        value.split(',').length === 4 && value.split(',').every((part) => part.trim().length > 0),
      'Four coordinates required',
    ),
  from: z.iso.datetime().max(40),
  to: z.iso.datetime().max(40),
  sourceId: z.string().min(1).max(200).optional(),
  shipType: z.coerce.number().int().min(1).max(99).optional(),
  mmsis: z.string().min(1).max(999).optional(),
});
export function parseHeatmapQuery(input: unknown) {
  const query = parse(HeatmapHttpQuerySchema, input);
  return parse(HeatmapQuerySchema, {
    ...query,
    bbox: query.bbox.split(',').map(Number),
    ...(query.mmsis === undefined
      ? {}
      : { mmsis: query.mmsis.split(',').map((mmsi) => mmsi.trim()) }),
  });
}
