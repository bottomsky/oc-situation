import { z } from 'zod';
import {
  GeometrySchema,
  IntelligenceCategorySchema,
  ReviewStatusSchema,
} from './intelligence-spatial';

const Id = z.string().min(1).max(200);
const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((value) => value[1] < value[3], 'Invalid latitude bounds');
export const IntelligenceTimeRangeSchema = z
  .strictObject({ from: z.iso.datetime(), to: z.iso.datetime() })
  .refine((value) => Date.parse(value.from) < Date.parse(value.to), 'Reversed time range');
const IntelligenceSearchFieldsSchema = z.strictObject({
  keyword: z.string().trim().max(300).optional(),
  locationKeyword: z.string().trim().max(200).optional(),
  sourceIds: z.array(Id).max(20).optional(),
  category: IntelligenceCategorySchema.optional(),
  reviewStatus: ReviewStatusSchema.optional(),
  timeMode: z.enum(['published', 'effective', 'observed']).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  bbox: Bbox.optional(),
  objectId: Id.optional(),
  mmsis: z
    .array(z.string().regex(/^\d{9}$/))
    .max(100)
    .optional(),
  kind: z.enum(['events', 'marine', 'both']).optional(),
  samplePointId: Id.optional(),
  forecastFrom: z.iso.datetime().optional(),
  forecastTo: z.iso.datetime().optional(),
});
export const IntelligenceSearchSpecSchema = IntelligenceSearchFieldsSchema.refine(
  (value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to),
  'Reversed search range',
).refine(
  (value) =>
    !value.forecastFrom ||
    !value.forecastTo ||
    Date.parse(value.forecastFrom) < Date.parse(value.forecastTo),
  'Reversed forecast range',
);
export type IntelligenceSearchSpec = z.infer<typeof IntelligenceSearchSpecSchema>;
export const IntelligenceSearchQuerySchema = IntelligenceSearchFieldsSchema.omit({
  bbox: true,
  sourceIds: true,
  mmsis: true,
})
  .extend({
    bbox: z
      .string()
      .max(150)
      .transform((value) => value.split(',').map(Number))
      .pipe(Bbox)
      .optional(),
    sourceIds: z
      .string()
      .max(4000)
      .transform((value) => value.split(','))
      .pipe(z.array(Id).max(20))
      .optional(),
    mmsis: z
      .string()
      .max(1100)
      .transform((value) => value.split(','))
      .pipe(z.array(z.string().regex(/^\d{9}$/)).max(100))
      .optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(2000).optional(),
  })
  .refine(
    (value) => !value.from || !value.to || Date.parse(value.from) < Date.parse(value.to),
    'Reversed search range',
  )
  .refine(
    (value) =>
      !value.forecastFrom ||
      !value.forecastTo ||
      Date.parse(value.forecastFrom) < Date.parse(value.forecastTo),
    'Reversed forecast range',
  );
export type IntelligenceSearchQuery = z.infer<typeof IntelligenceSearchQuerySchema>;
export const IntelligenceSourceHealthSchema = z.object({
  sourceId: Id,
  name: z.string(),
  enabled: z.boolean(),
  visibility: z.enum(['public', 'internal']),
  status: z.enum(['ready', 'stale', 'unavailable', 'never_collected', 'disabled']),
  lastPolledAt: z.iso.datetime().nullable(),
  lastSuccessfulAt: z.iso.datetime().nullable(),
  nextPollAt: z.iso.datetime().nullable(),
  lastError: z.string().nullable(),
});
export type IntelligenceSourceHealth = z.infer<typeof IntelligenceSourceHealthSchema>;
export const IntelligenceSearchItemSchema = z.object({
  id: Id,
  sourceId: Id,
  sourceName: z.string(),
  externalId: Id,
  version: z.number().int().positive(),
  title: z.string(),
  summary: z.string(),
  snippet: z.string(),
  category: IntelligenceCategorySchema,
  status: z.enum(['active', 'revised', 'withdrawn']),
  reviewStatus: ReviewStatusSchema,
  visibility: z.enum(['public', 'internal']),
  publishedAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
  effectiveFrom: z.iso.datetime().nullable(),
  effectiveTo: z.iso.datetime().nullable(),
  collectedAt: z.iso.datetime(),
  timeBasis: z.enum(['publication', 'index-observation', 'effective', 'unknown']),
  originalUrl: z.url().nullable(),
  originalArchiveId: Id.nullable(),
  geometry: GeometrySchema.nullable(),
  matchBasis: z.enum(['geometry', 'object', 'mention', 'keyword', 'none']),
  locationNote: z.string(),
});
export type IntelligenceSearchItem = z.infer<typeof IntelligenceSearchItemSchema>;
export const MARINE_SAMPLE_POINTS = [
  { id: 'bohai', name: '渤海代表点', lon: 120, lat: 39, aliases: ['渤海', 'Bohai'] },
  { id: 'yellow-sea', name: '黄海代表点', lon: 123, lat: 35, aliases: ['黄海', 'Yellow Sea'] },
  {
    id: 'east-china-sea',
    name: '东海代表点',
    lon: 125,
    lat: 28,
    aliases: ['东海', 'East China Sea'],
  },
  {
    id: 'taiwan-strait',
    name: '台湾海峡代表点',
    lon: 119,
    lat: 24,
    aliases: ['台湾海峡', 'Taiwan Strait'],
  },
  {
    id: 'north-south-china-sea',
    name: '南海北部代表点',
    lon: 115,
    lat: 20,
    aliases: ['南海北部', '南海', 'South China Sea'],
  },
  {
    id: 'beibu-gulf',
    name: '北部湾代表点',
    lon: 108.5,
    lat: 19.5,
    aliases: ['北部湾', 'Beibu Gulf', 'Gulf of Tonkin'],
  },
] as const;
export const MarineForecastHourSchema = z.object({
  validAt: z.iso.datetime(),
  waveHeight: z.number().min(0).nullable(),
  waveDirection: z.number().min(0).max(360).nullable(),
  wavePeriod: z.number().min(0).nullable(),
});
export const MarineForecastSnapshotSchema = z.object({
  id: Id,
  sourceId: Id,
  samplePointId: Id,
  pointName: z.string(),
  point: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }),
  grid: z.object({ lon: z.number().min(-180).max(180), lat: z.number().min(-90).max(90) }),
  fetchedAt: z.iso.datetime(),
  modelPublishedAt: z.iso.datetime().nullable(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime(),
  series: z.array(MarineForecastHourSchema).min(1).max(384),
  originalArchiveId: Id,
  originalUrl: z.url(),
  visibility: z.enum(['public', 'internal']),
});
export type MarineForecastSnapshot = z.infer<typeof MarineForecastSnapshotSchema>;
export const IntelligenceSearchResultSchema = z.object({
  items: z.array(IntelligenceSearchItemSchema).max(50),
  forecasts: z.array(MarineForecastSnapshotSchema).max(20),
  total: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  asOf: z.iso.datetime(),
  spec: IntelligenceSearchSpecSchema,
  sourceHealth: z.array(IntelligenceSourceHealthSchema),
  coverageNotes: z.array(z.string()),
});
export type IntelligenceSearchResult = z.infer<typeof IntelligenceSearchResultSchema>;
export const IntelligenceEvidenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    reference: z.string().regex(/^I[1-9]\d{0,3}$/),
    event: IntelligenceSearchItemSchema,
  }),
  z.object({
    kind: z.literal('marine'),
    reference: z.string().regex(/^I[1-9]\d{0,3}$/),
    forecast: MarineForecastSnapshotSchema,
  }),
]);
export type IntelligenceEvidence = z.infer<typeof IntelligenceEvidenceSchema>;
export const AgentIntelligenceResultSchema = z.object({
  kind: z.literal('intelligence_search'),
  version: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
  asOf: z.iso.datetime(),
  spec: IntelligenceSearchSpecSchema,
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  evidence: z.array(IntelligenceEvidenceSchema).max(50),
  sourceHealth: z.array(IntelligenceSourceHealthSchema),
  coverageNotes: z.array(z.string()),
});
export type AgentIntelligenceResult = z.infer<typeof AgentIntelligenceResultSchema>;
