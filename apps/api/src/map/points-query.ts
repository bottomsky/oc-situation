import { z } from 'zod';
import { parse } from '../common';
import { MapQuerySchema, parseMapQuery } from './query';
import { MAP_POINT_PAGE_SIZE } from '../../../../packages/contracts/map-snapshot';

export const MapPointHttpQuerySchema = MapQuerySchema.extend({
  bbox: MapQuerySchema.shape.bbox.optional(),
  snapshotId: z.uuid().optional(),
  cursor: z
    .string()
    .regex(/^(0|[1-9]\d{0,8})$/)
    .optional(),
  pageSize: z.coerce.number().int().min(1).max(MAP_POINT_PAGE_SIZE).optional(),
});
export function parseMapPointHttpQuery(input: unknown) {
  const result = parse(MapPointHttpQuerySchema, input);
  if (result.snapshotId !== undefined || result.cursor !== undefined) {
    const page = parse(
      z.strictObject({
        snapshotId: z.uuid(),
        cursor: MapPointHttpQuerySchema.shape.cursor.unwrap(),
        pageSize: MapPointHttpQuerySchema.shape.pageSize,
      }),
      input,
    );
    return page;
  }
  const { pageSize, ...query } = result;
  return { ...parseMapQuery(query), pageSize };
}
