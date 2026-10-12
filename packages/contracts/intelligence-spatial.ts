import { z } from 'zod';
const Id = z.string().min(1).max(200);
export const ReviewStatusSchema = z.enum(['candidate', 'confirmed', 'rejected']);
export const IntelligenceCategorySchema = z.enum([
  'port-restriction',
  'notice',
  'navigation-warning',
  'weather',
  'security',
  'environment',
  'incident',
  'other',
]);
const Position = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
]);
const Line = z.array(Position).min(2).max(10000);
const Ring = z
  .array(Position)
  .min(4)
  .max(10000)
  .refine(
    (v) => v[0]![0] === v.at(-1)![0] && v[0]![1] === v.at(-1)![1],
    'Polygon rings must close',
  );
const Polygon = z.array(Ring).min(1).max(100);
export const GeometrySchema = z
  .discriminatedUnion('type', [
    z.strictObject({ type: z.literal('Point'), coordinates: Position }),
    z.strictObject({ type: z.literal('LineString'), coordinates: Line }),
    z.strictObject({ type: z.literal('Polygon'), coordinates: Polygon }),
    z.strictObject({
      type: z.literal('MultiPoint'),
      coordinates: z.array(Position).min(1).max(10000),
    }),
    z.strictObject({
      type: z.literal('MultiLineString'),
      coordinates: z.array(Line).min(1).max(100),
    }),
    z.strictObject({
      type: z.literal('MultiPolygon'),
      coordinates: z.array(Polygon).min(1).max(100),
    }),
  ])
  .refine((v) => JSON.stringify(v).length <= 1048576, 'Geometry exceeds 1 MiB');
export type IntelligenceGeometry = z.infer<typeof GeometrySchema>;
export const GeoObjectInputSchema = z
  .strictObject({
    id: Id.optional(),
    kind: z.enum(['vessel', 'port', 'channel', 'area', 'facility']),
    name: z.string().trim().min(1).max(300),
    geometry: GeometrySchema.optional(),
    mmsi: z
      .string()
      .regex(/^[1-9]\d{8}$/)
      .optional(),
    aliases: z.array(z.string().trim().min(1).max(300)).max(100).default([]),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((v) => v.kind !== 'vessel' || !!v.mmsi, 'Vessel requires MMSI');
export type GeoObjectInput = z.infer<typeof GeoObjectInputSchema>;
export interface IntelligenceGeoObject extends GeoObjectInput {
  id: string;
  updatedAt: string;
}
export const RelationInputSchema = z
  .strictObject({
    kind: z.enum(['occurs-at', 'mentions', 'involves', 'applies-to', 'impacts']),
    objectId: Id.optional(),
    geometry: GeometrySchema.optional(),
    basis: z.string().trim().min(1).max(10000),
    paragraphIds: z.array(Id).max(100).default([]),
    reviewStatus: ReviewStatusSchema.default('candidate'),
    origin: z.enum(['source', 'rule', 'manual', 'legacy']).default('manual'),
    impactType: z.string().trim().min(1).max(100).optional(),
    effectiveFrom: z.iso.datetime().optional(),
    effectiveTo: z.iso.datetime().nullable().optional(),
  })
  .refine((v) => !!v.objectId || !!v.geometry, 'Relation requires objectId or geometry')
  .refine(
    (v) => v.kind !== 'impacts' || (!!v.impactType && !!v.effectiveFrom),
    'Impact requires type and start time',
  )
  .refine(
    (v) =>
      !v.effectiveTo ||
      !v.effectiveFrom ||
      Date.parse(v.effectiveTo) >= Date.parse(v.effectiveFrom),
    'Impact interval reversed',
  );
export type IntelligenceRelationInput = z.infer<typeof RelationInputSchema>;
export interface IntelligenceRelation extends IntelligenceRelationInput {
  id: string;
  eventId: string;
  revision: number;
  recordedAt: string;
  reviewedBy?: string;
  createdBy?: string;
  objectSnapshot?: IntelligenceGeoObject;
}
export const ReviewSchema = z.strictObject({ reviewStatus: ReviewStatusSchema });
export const PlotRequestSchema = z.strictObject({
  eventIds: z.array(Id).max(1000),
  includeCandidates: z.boolean().default(false),
});
export const PlotSetSchema = z.strictObject({
  eventIds: z.array(Id).max(1000),
  hiddenEventIds: z.array(Id).max(1000),
});
const QueryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const IntelligenceEventQuerySchema = z
  .strictObject({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: Id.optional(),
    keyword: z.string().max(300).optional(),
    sourceId: Id.optional(),
    category: IntelligenceCategorySchema.optional(),
    reviewStatus: ReviewStatusSchema.optional(),
    status: z.enum(['active', 'revised', 'withdrawn']).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    objectId: Id.optional(),
    bbox: z
      .string()
      .transform((v) => v.split(',').map(Number))
      .pipe(
        z
          .tuple([
            z.number().min(-180).max(180),
            z.number().min(-90).max(90),
            z.number().min(-180).max(180),
            z.number().min(-90).max(90),
          ])
          .refine((v) => v[1] <= v[3]),
      )
      .optional(),
    latest: QueryBool.default(false),
  })
  .refine(
    (v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to),
    'Query window reversed',
  );
export type IntelligenceEventQuery = z.infer<typeof IntelligenceEventQuerySchema>;
export const GeoObjectImportSchema = z.strictObject({
  type: z.literal('FeatureCollection'),
  features: z
    .array(
      z.strictObject({
        type: z.literal('Feature'),
        id: Id.optional(),
        geometry: GeometrySchema,
        properties: GeoObjectInputSchema,
      }),
    )
    .min(1)
    .max(1000),
});
export interface IntelligencePlotFeature {
  type: 'Feature';
  id: string;
  geometry: IntelligenceGeometry;
  properties: {
    eventId: string;
    eventVersion?: number;
    relationRevision?: number;
    eventReviewStatus?: string;
    objectName?: string;
    historical?: boolean;
    validFrom?: string;
    validTo?: string | null;
    positionSource?: 'relation' | 'object' | 'ais-latest';
    effectiveTimePending?: boolean;
    sourceObserved?: boolean;
    synthetic?: boolean;
    eventSynthetic?: boolean;
    relationId: string;
    objectId?: string;
    kind: string;
    reviewStatus: string;
    origin: string;
    basis: string;
    observedAt: string;
    status: string;
    title: string;
  };
}
export interface IntelligencePlot {
  type: 'FeatureCollection';
  features: IntelligencePlotFeature[];
  items: { eventId: string; title: string; featureCount: number; reason?: string }[];
}
export const GeoObjectQuerySchema = z.strictObject({
  keyword: z.string().max(300).optional(),
  kind: z.enum(['vessel', 'port', 'channel', 'area', 'facility']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
