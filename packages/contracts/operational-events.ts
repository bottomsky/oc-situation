import { z } from 'zod';
import { GeometrySchema } from './intelligence-spatial';
import { CircleRegionSchema } from './spatial';

export const OperationalEventStatusSchema = z.enum(['active', 'resolved', 'archived', 'merged']);
export const OperationalEventFieldsSchema = z.strictObject({
  title: z.string().trim().min(1).max(500),
  summary: z.string().max(10000).default(''),
  category: z.string().trim().min(1).max(100).default('other'),
  severity: z.enum(['unknown', 'low', 'medium', 'high', 'critical']).default('unknown'),
  occurredAt: z.iso.datetime().nullable().default(null),
  geometry: GeometrySchema.nullable().default(null),
  linkedMmsis: z
    .array(z.string().regex(/^[1-9]\d{8}$/))
    .max(1000)
    .default([]),
  linkedRouteIds: z.array(z.uuid()).max(1000).default([]),
});
export type OperationalEventFields = z.infer<typeof OperationalEventFieldsSchema>;
// Strip creation defaults before partializing: Zod 4 otherwise applies them to omitted patch fields.
export const OperationalEventPatchFieldsSchema = OperationalEventFieldsSchema.extend({
  summary: OperationalEventFieldsSchema.shape.summary.removeDefault(),
  category: OperationalEventFieldsSchema.shape.category.removeDefault(),
  severity: OperationalEventFieldsSchema.shape.severity.removeDefault(),
  occurredAt: OperationalEventFieldsSchema.shape.occurredAt.removeDefault(),
  geometry: OperationalEventFieldsSchema.shape.geometry.removeDefault(),
  linkedMmsis: OperationalEventFieldsSchema.shape.linkedMmsis.removeDefault(),
  linkedRouteIds: OperationalEventFieldsSchema.shape.linkedRouteIds.removeDefault(),
}).partial();
export const OperationalEventSchema = OperationalEventFieldsSchema.extend({
  id: z.uuid(),
  revision: z.number().int().positive(),
  status: OperationalEventStatusSchema,
  primarySourceKey: z.string().nullable(),
  sourceSuggestions: OperationalEventPatchFieldsSchema,
  overrides: OperationalEventPatchFieldsSchema,
  mergedInto: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OperationalEvent = z.infer<typeof OperationalEventSchema>;
export const CreateOperationalEventSchema = OperationalEventFieldsSchema.extend({
  operationId: z.uuid(),
});
export const UpdateOperationalEventSchema = z
  .strictObject({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    fields: OperationalEventPatchFieldsSchema.default({}),
    releaseOverrides: z
      .array(
        z.enum([
          'title',
          'summary',
          'category',
          'severity',
          'occurredAt',
          'geometry',
          'linkedMmsis',
          'linkedRouteIds',
        ]),
      )
      .default([]),
    status: z.enum(['active', 'resolved', 'archived']).optional(),
  })
  .refine(
    (v) => !v.releaseOverrides.some((key) => key in v.fields),
    'A field cannot be updated and released together',
  );
export const MergeOperationalEventsSchema = z.strictObject({
  operationId: z.uuid(),
  targetId: z.uuid(),
  expectedRevision: z.number().int().positive(),
  targetExpectedRevision: z.number().int().positive(),
  primarySourceKey: z.string().min(1).max(1000),
});
export const OperationalEventQuerySchema = z.strictObject({
  keyword: z.string().max(500).optional(),
  status: OperationalEventStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  circle: CircleRegionSchema.optional(),
});
export type CreateOperationalEvent = z.infer<typeof CreateOperationalEventSchema>;
export type UpdateOperationalEvent = z.infer<typeof UpdateOperationalEventSchema>;
export type MergeOperationalEvents = z.infer<typeof MergeOperationalEventsSchema>;
export type OperationalEventQuery = z.infer<typeof OperationalEventQuerySchema>;
export interface OperationalEventSourceSnapshot {
  key: string;
  kind: 'intelligence' | 'analysis';
  sourceId: string;
  externalId: string;
  version: number;
  status: string;
  reviewStatus: string;
  fields: OperationalEventFields;
}
export interface OperationalEventSource extends OperationalEventSourceSnapshot {
  eventId: string;
  revision: number;
  updatedAt: string;
}
