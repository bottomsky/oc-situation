import { z } from 'zod';
import {
  PositionObservationSchema,
  StaticFieldsSchema,
  MmsiSchema,
  SourceKindSchema,
} from '@ais/contracts';
import { Iso, PageQuery } from '../common';
export const ProvenanceSchema = z.record(
  z.string(),
  z.object({
    sourceId: z.string(),
    sourceKind: SourceKindSchema,
    sourcePriority: z.number(),
    eventId: z.string(),
    observedAt: Iso.nullable(),
    receivedAt: Iso,
  }),
);
export const VesselSchema = z.object({
  mmsi: MmsiSchema,
  latestPosition: PositionObservationSchema.nullable(),
  staticFields: StaticFieldsSchema,
});
export const VesselDetailSchema = VesselSchema.extend({ provenance: ProvenanceSchema });
export const VesselQuerySchema = PageQuery.extend({
  query: z.string().max(100).optional(),
  mmsi: MmsiSchema.optional(),
  name: z.string().max(100).optional(),
  imo: z
    .string()
    .regex(/^\d{7}$/)
    .optional(),
});
export const TrackQuerySchema = z
  .strictObject({
    from: Iso,
    to: Iso,
    maxPoints: z.coerce.number().int().min(2).max(5000).default(2000),
  })
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) - Date.parse(v.from) <= 30 * 86400000 &&
      Date.parse(v.from) >= Date.now() - 30 * 86400000 &&
      Date.parse(v.to) <= Date.now() + 60000,
    'Track range must be within retained recent 30 days',
  );
export const TrackResponseSchema = z.object({
  mmsi: MmsiSchema,
  from: Iso,
  to: Iso,
  segments: z.array(z.object({ points: z.array(PositionObservationSchema) })),
  sampled: z.boolean(),
  truncated: z.boolean(),
  total: z.number(),
  returned: z.number(),
});
