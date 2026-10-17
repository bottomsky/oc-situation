import { z } from 'zod';
export * from './intelligence';
export * from './intelligence-spatial';
export * from './topics';
export * from './agent';
export * from './intelligence-search';
export * from './heatmap';
export * from './agent-capabilities';

export const MAX_INLINE_BYTES = 1_048_576;
export const EXPORT_INLINE_THRESHOLD_BYTES = 262_144;
export const IdSchema = z.string().min(1).max(200);
export const MmsiSchema = z.string().regex(/^[1-9]\d{8}$/);
export const UtcTimestampSchema = z.iso
  .datetime()
  .max(40)
  .refine((value) => {
    const date = new Date(value);
    return (
      Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19)
    );
  }, 'Invalid UTC calendar timestamp');
export const SourceKindSchema = z.enum([
  'aisstream',
  'marinetraffic',
  'fixture-http',
  'fixture-browser',
]);
export type SourceKind = z.infer<typeof SourceKindSchema>;
export const ReceptionTypeSchema = z.enum(['TER', 'SAT', 'ROAM', 'UNKNOWN']);
export type ReceptionType = z.infer<typeof ReceptionTypeSchema>;

function isBoundedJson(value: unknown): boolean {
  try {
    const seen = new WeakSet<object>();
    let nodes = 0;
    const visit = (item: unknown, depth: number): boolean => {
      if (++nodes > 20_000 || depth > 32) return false;
      if (item === null || typeof item === 'boolean') return true;
      if (typeof item === 'string') return item.length <= MAX_INLINE_BYTES;
      if (typeof item === 'number') return Number.isFinite(item);
      if (typeof item !== 'object' || seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) return item.every((entry) => visit(entry, depth + 1));
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
        return false;
      return Object.entries(item).every(
        ([key, entry]) => key.length <= 1024 && visit(entry, depth + 1),
      );
    };
    return (
      visit(value, 0) &&
      new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_INLINE_BYTES
    );
  } catch {
    return false;
  }
}

export const InlinePayloadSchema = z.strictObject({
  kind: z.literal('inline'),
  value: z.unknown().refine(isBoundedJson, 'Payload must be bounded JSON'),
});
export const ObjectPayloadSchema = z.strictObject({
  kind: z.literal('object'),
  bucket: IdSchema,
  key: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type InlinePayload = z.infer<typeof InlinePayloadSchema>;
export type ObjectPayload = z.infer<typeof ObjectPayloadSchema>;
export const ResponseMetaSchema = z.strictObject({
  format: z.enum(['json', 'html', 'text']),
  contentType: z.string().max(200).optional(),
  statusCode: z.number().int().min(100).max(599).optional(),
});
export const RawEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  captureId: IdSchema,
  sourceId: IdSchema,
  sourceKind: SourceKindSchema,
  adapterVersion: z.string().min(1).max(100),
  runId: IdSchema.nullable(),
  receivedAt: UtcTimestampSchema,
  sourcePriority: z.number().int().min(0).max(10000),
  payload: z.discriminatedUnion('kind', [InlinePayloadSchema, ObjectPayloadSchema]),
  /** Missing encoding denotes legacy JSON.stringify order; new inline records use canonical-json-v1. */
  checksumEncoding: z.enum(['json-stringify-v1', 'canonical-json-v1']).optional(),
  /** SHA-256 of encoded inline JSON or the exact stored object bytes. */
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  integrity: z.enum(['verified', 'legacy_unverified']).optional(),
  responseMeta: ResponseMetaSchema.optional(),
});
export type RawEnvelope = z.infer<typeof RawEnvelopeSchema>;

const baseObservation = {
  schemaVersion: z.literal(1),
  cleaningVersion: z.literal(1),
  eventId: IdSchema,
  captureId: IdSchema,
  sourceId: IdSchema,
  sourceKind: SourceKindSchema,
  sourcePriority: z.number().int().min(0).max(10000),
  runId: IdSchema.nullable(),
  receivedAt: UtcTimestampSchema,
  quality: z.array(z.string().min(1).max(100)).max(100),
};
export const PositionObservationSchema = z.strictObject({
  ...baseObservation,
  kind: z.literal('position'),
  observedAt: UtcTimestampSchema,
  mmsi: MmsiSchema,
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  sogKnots: z.number().min(0).max(102.2).nullable(),
  cogDegrees: z.number().min(0).lt(360).nullable(),
  headingDegrees: z.number().min(0).lt(360).nullable(),
  rotDegPerMinute: z.number().min(-720).max(720).nullable(),
  navigationStatus: z.number().int().min(0).max(15).nullable(),
  receptionType: ReceptionTypeSchema,
});
export type PositionObservation = z.infer<typeof PositionObservationSchema>;
export const PartialEtaSchema = z
  .strictObject({
    year: z.number().int().min(1900).max(9999).optional(),
    month: z.number().int().min(1).max(12).optional(),
    day: z.number().int().min(1).max(31).optional(),
    hour: z.number().int().min(0).max(23).optional(),
    minute: z.number().int().min(0).max(59).optional(),
  })
  .refine((v) => {
    if (v.month === undefined || v.day === undefined) return true;
    const maxDay = new Date(Date.UTC(v.year ?? 2000, v.month, 0)).getUTCDate();
    return v.day <= maxDay;
  }, 'Invalid ETA calendar date');
export type PartialEta = z.infer<typeof PartialEtaSchema>;
export const StaticFieldsSchema = z.strictObject({
  name: z.string().min(1).max(200).optional(),
  imo: z
    .string()
    .regex(/^\d{7}$/)
    .optional(),
  callsign: z.string().min(1).max(40).optional(),
  shipType: z.number().int().min(1).max(99).optional(),
  length: z.number().positive().max(1022).optional(),
  width: z.number().positive().max(126).optional(),
  draught: z.number().positive().max(25.5).optional(),
  destination: z.string().min(1).max(200).optional(),
  eta: PartialEtaSchema.optional(),
});
export type StaticFields = z.infer<typeof StaticFieldsSchema>;
export const StaticObservationSchema = z.strictObject({
  ...baseObservation,
  kind: z.literal('static'),
  observedAt: UtcTimestampSchema.nullable(),
  mmsi: MmsiSchema,
  fields: StaticFieldsSchema,
});
export type StaticObservation = z.infer<typeof StaticObservationSchema>;
export const QuarantineObservationSchema = z.strictObject({
  ...baseObservation,
  kind: z.literal('quarantine'),
  observedAt: UtcTimestampSchema.nullable(),
  mmsi: MmsiSchema.nullable(),
  reasons: z.array(z.string().min(1).max(200)).min(1).max(100),
});
export type QuarantineObservation = z.infer<typeof QuarantineObservationSchema>;
export const NormalizedObservationSchema = z.discriminatedUnion('kind', [
  PositionObservationSchema,
  StaticObservationSchema,
  QuarantineObservationSchema,
]);
export type NormalizedObservation = z.infer<typeof NormalizedObservationSchema>;
export const parseRawEnvelope = (input: unknown): RawEnvelope => {
  const raw = RawEnvelopeSchema.parse(input);
  return { ...raw, integrity: raw.checksum ? 'verified' : 'legacy_unverified' };
};
export const parseNormalizedObservation = (input: unknown): NormalizedObservation =>
  NormalizedObservationSchema.parse(input);

export const UserRoleSchema = z.enum(['viewer', 'operator', 'admin']);
export type UserRole = z.infer<typeof UserRoleSchema>;
export const PaginationQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(1000).default(100),
  cursor: z.string().max(1000).optional(),
});
export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}
export const BboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3], 'South must precede north');
export type Bbox = z.infer<typeof BboxSchema>;
export interface MapPoint {
  kind: 'point';
  mmsi: string;
  lat: number;
  lon: number;
  observedAt: string;
  sourceId: string;
  sogKnots: number | null;
  cogDegrees: number | null;
  headingDegrees: number | null;
  quality: string[];
}
export interface MapCluster {
  kind: 'cluster';
  clusterId: string;
  lat: number;
  lon: number;
  count: number;
  bbox: Bbox;
}
export interface MapResponse {
  items: (MapPoint | MapCluster)[];
  sampled: boolean;
  truncated: boolean;
  total: number;
  generatedAt: string;
}
export interface TrackSegment {
  points: PositionObservation[];
}
export interface TrackResponse {
  mmsi: string;
  from: string;
  to: string;
  segments: TrackSegment[];
  sampled: boolean;
  truncated: boolean;
  total: number;
  returned: number;
}
export interface VesselSummary {
  mmsi: string;
  latestPosition: PositionObservation | null;
  staticFields: StaticFields;
}
export interface VesselDetail extends VesselSummary {
  provenance: Partial<Record<keyof StaticFields, FieldProvenance>>;
}
export interface FieldProvenance {
  sourceId: string;
  sourceKind: SourceKind;
  sourcePriority: number;
  eventId: string;
  observedAt: string | null;
  receivedAt: string;
}
export const SourceStatusSchema = z.enum(['enabled', 'disabled', 'error']);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;
export const RunModeSchema = z.enum(['crawl', 'collect', 'replay']);
export type RunMode = z.infer<typeof RunModeSchema>;
export const JobStatusSchema = z.enum(['enabled', 'paused']);
export type JobStatus = z.infer<typeof JobStatusSchema>;
export const RunStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type RunStatus = z.infer<typeof RunStatusSchema>;
export const SourceSettingsSchema = z.strictObject({
  allowedHosts: z
    .array(
      z
        .string()
        .min(1)
        .max(253)
        .regex(/^(?:localhost|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?)$/),
    )
    .max(10)
    .default([]),
  requestsPerMinute: z.number().int().min(1).max(10000).default(30),
  maxPages: z.number().int().min(1).max(1000).default(100),
  httpConcurrency: z.number().int().min(1).max(10).default(2),
  browserConcurrency: z.number().int().min(1).max(2).default(1),
  timeoutSeconds: z.number().int().min(1).max(120).default(30),
  timespanMinutes: z.number().int().min(1).max(1440).default(5),
  pageLimit: z.number().int().min(1000).max(5000).default(2000),
  authorizationConfirmed: z.boolean().default(false),
});
export const CrawlSettingsSchema = SourceSettingsSchema;
export type SourceSettings = z.infer<typeof SourceSettingsSchema>;
export type CrawlSettings = SourceSettings;
export const SourceConfigSchema = z.strictObject({
  sourceId: IdSchema,
  sourceKind: SourceKindSchema,
  name: z.string().min(1).max(200),
  status: SourceStatusSchema,
  secretRef: IdSchema.nullable(),
  priority: z.number().int().min(0).max(10000),
  endpoint: z.string().url().max(2000).optional(),
  bbox: BboxSchema.optional(),
  settings: SourceSettingsSchema.optional(),
});
export type SourceConfig = z.infer<typeof SourceConfigSchema>;
export const TaskCommandSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: IdSchema,
  jobId: IdSchema,
  sourceId: IdSchema,
  idempotencyKey: IdSchema,
  mode: RunModeSchema,
  requestedAt: UtcTimestampSchema,
  replayCaptureIds: z.array(IdSchema).max(10000).optional(),
});
export type TaskCommand = z.infer<typeof TaskCommandSchema>;
export const JobConfigSchema = z.strictObject({
  jobId: IdSchema,
  sourceId: IdSchema,
  name: z.string().min(1).max(200),
  mode: RunModeSchema,
  status: JobStatusSchema,
  scheduleSeconds: z.number().int().min(10).max(86400).nullable(),
});
export type JobConfig = z.infer<typeof JobConfigSchema>;
export interface RunRecord {
  runId: string;
  jobId: string;
  sourceId: string;
  mode: RunMode;
  status: RunStatus;
  requestedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  captures: number | null;
  positions: number | null;
  quarantined: number | null;
  error: string | null;
}
export interface AuditRecord {
  auditId: string;
  actorId: string;
  action: string;
  resourceId: string;
  at: string;
}
export interface ApiError {
  error: { code: string; message: string; requestId: string };
}

export * from './agent-ui';
export * from './agent-map';
export * from './vessel-tracks';
export * from './dynamic-skills';
