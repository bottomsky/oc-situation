import { z } from 'zod';
import { CircleRegionSchema } from './spatial';

export const RouteCoordinateSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-85).max(85),
]);
export const RouteLineSchema = z.strictObject({
  type: z.literal('LineString'),
  coordinates: z.array(RouteCoordinateSchema).min(2).max(100000),
});
export const RouteStatusSchema = z.enum(['draft', 'active', 'archived']);
export const RouteWaypointSchema = z.array(RouteCoordinateSchema).min(2).max(10);
export const RouteSchema = z.strictObject({
  id: z.uuid(),
  revision: z.number().int().positive(),
  name: z.string().min(1).max(200),
  status: RouteStatusSchema,
  mmsis: z.array(z.string().regex(/^[1-9]\d{8}$/)).max(100),
  waypoints: RouteWaypointSchema,
  geometry: RouteLineSchema,
  lengthMeters: z.number().nonnegative(),
  generatedBy: z.enum(['manual', 'import', 'planner']),
  planId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const CreateRouteSchema = z
  .strictObject({
    operationId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    status: RouteStatusSchema.default('draft'),
    mmsis: z
      .array(z.string().regex(/^[1-9]\d{8}$/))
      .max(100)
      .default([]),
    waypoints: RouteWaypointSchema.optional(),
    geometry: RouteLineSchema.optional(),
    planId: z.uuid().optional(),
  })
  .refine(
    (v) => (v.planId ? !v.geometry && !v.waypoints : Boolean(v.geometry && v.waypoints)),
    'Provide exclusively planId or geometry and waypoints',
  )
  .refine(
    (v) =>
      !v.geometry ||
      !v.waypoints ||
      (JSON.stringify(v.geometry.coordinates[0]) === JSON.stringify(v.waypoints[0]) &&
        JSON.stringify(v.geometry.coordinates.at(-1)) === JSON.stringify(v.waypoints.at(-1))),
    'Geometry endpoints must match waypoints',
  );
export const UpdateRouteSchema = z
  .strictObject({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(200).optional(),
    status: RouteStatusSchema.optional(),
    mmsis: z
      .array(z.string().regex(/^[1-9]\d{8}$/))
      .max(100)
      .optional(),
    waypoints: RouteWaypointSchema.optional(),
    geometry: RouteLineSchema.optional(),
  })
  .refine(
    (v) => Boolean(v.waypoints) === Boolean(v.geometry),
    'Change waypoints and geometry together',
  )
  .refine(
    (v) =>
      !v.geometry ||
      !v.waypoints ||
      (JSON.stringify(v.geometry.coordinates[0]) === JSON.stringify(v.waypoints[0]) &&
        JSON.stringify(v.geometry.coordinates.at(-1)) === JSON.stringify(v.waypoints.at(-1))),
    'Geometry endpoints must match waypoints',
  );
export const RouteOperationSchema = z.strictObject({
  operationId: z.uuid(),
  expectedRevision: z.number().int().positive(),
});
export const CopyRouteSchema = RouteOperationSchema.extend({
  name: z.string().trim().min(1).max(200),
});
export const PlanRouteSchema = z.strictObject({
  operationId: z.uuid(),
  waypoints: RouteWaypointSchema,
});
export const CircleRouteQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
    status: RouteStatusSchema.optional(),
    search: z.string().max(200).optional(),
    longitude: z.coerce.number().min(-180).max(180).optional(),
    latitude: z.coerce.number().min(-85).max(85).optional(),
    radiusMeters: z.coerce.number().min(100).max(2000000).optional(),
  })
  .refine(
    (v) =>
      [v.longitude, v.latitude, v.radiusMeters].filter((x) => x !== undefined).length % 3 === 0,
    'Circle requires longitude, latitude and radiusMeters',
  );
export const RoutePlanSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
  input: PlanRouteSchema,
  datasetVersion: z.string().nullable(),
  restrictionVersion: z.number().int(),
  result: z.object({ geometry: RouteLineSchema, lengthMeters: z.number() }).nullable(),
  error: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  stale: z.boolean(),
});
const ring = z
  .array(RouteCoordinateSchema)
  .min(4)
  .max(10000)
  .refine((v) => JSON.stringify(v[0]) === JSON.stringify(v.at(-1)), 'Ring must be closed');
export const RoutePolygonSchema = z.union([
  z.strictObject({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
  z.strictObject({
    type: z.literal('MultiPolygon'),
    coordinates: z.array(z.array(ring).min(1)).min(1),
  }),
]);
export const RestrictionSchema = z
  .strictObject({
    operationId: z.uuid(),
    expectedRevision: z.number().int().nonnegative().default(0),
    name: z.string().trim().min(1).max(200),
    geometry: RoutePolygonSchema,
    validFrom: z.iso.datetime(),
    validUntil: z.iso.datetime().nullable(),
    enabled: z.boolean().default(true),
  })
  .refine((v) => !v.validUntil || v.validUntil > v.validFrom, 'validUntil must follow validFrom');
export const ImportRouteSchema = z.strictObject({
  operationId: z.uuid(),
  name: z.string().min(1).max(200),
  geojson: z.strictObject({
    type: z.literal('Feature'),
    geometry: RouteLineSchema,
    properties: z.record(z.string(), z.unknown()).default({}),
  }),
});
export type RouteCoordinate = z.infer<typeof RouteCoordinateSchema>;
export type Route = z.infer<typeof RouteSchema>;
export type RoutePlan = z.infer<typeof RoutePlanSchema>;
export type CreateRoute = z.infer<typeof CreateRouteSchema>;
export type UpdateRoute = z.infer<typeof UpdateRouteSchema>;
export type PlanRoute = z.infer<typeof PlanRouteSchema>;
export type RouteRestrictionInput = z.infer<typeof RestrictionSchema>;

export function routeQueryCircle(query: z.infer<typeof CircleRouteQuerySchema>) {
  return query.radiusMeters === undefined
    ? undefined
    : CircleRegionSchema.parse({
        kind: 'circle',
        center: [query.longitude, query.latitude],
        radiusMeters: query.radiusMeters,
      });
}
