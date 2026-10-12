import { z } from 'zod';
import {
  IntelligenceCategorySchema,
  ReviewStatusSchema,
  RelationInputSchema,
} from './intelligence-spatial';
import type { PositionObservation, StaticObservation } from './index';
const IdSchema = z.string().min(1).max(200);
const MmsiSchema = z.string().regex(/^[1-9]\d{8}$/);
const UtcTimestampSchema = z.iso.datetime();
const BboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3]);

export const IntelligenceSourceSchema = z
  .strictObject({
    sourceId: IdSchema,
    name: z.string().min(1).max(200),
    kind: z.enum(['manual', 'api', 'json', 'rss', 'file', 'fixture']),
    enabled: z.boolean().default(true),
    adapter: z.enum(['maritime-html', 'gdacs', 'gdelt']).optional(),
    requestsPerMinute: z.number().int().min(1).max(60).default(6),
    maxDocuments: z.number().int().min(1).max(100).default(5),
    trust: z.enum(['official', 'aggregator']).default('aggregator'),
    endpoint: z.string().min(1).max(2000).optional(),
    allowedHosts: z.array(z.string().min(1).max(253)).max(10).default([]),
    authorizationConfirmed: z.boolean().default(false),
    pollSeconds: z.number().int().min(10).max(86400).default(300),
    timeoutSeconds: z.number().int().min(1).max(120).default(30),
  })
  .refine((s) => {
    if (['manual', 'fixture', 'file'].includes(s.kind)) return true;
    try {
      return Boolean(
        s.endpoint &&
        s.authorizationConfirmed &&
        s.allowedHosts.includes(new URL(s.endpoint).hostname),
      );
    } catch {
      return false;
    }
  }, 'Network sources require endpoint, registered host and authorization');
export type IntelligenceSource = z.infer<typeof IntelligenceSourceSchema>;

export const IntelligenceInputSchema = z
  .strictObject({
    sourceId: IdSchema,
    externalId: IdSchema,
    version: z.number().int().positive(),
    status: z.enum(['active', 'revised', 'withdrawn']).default('active'),
    category: IntelligenceCategorySchema,
    reviewStatus: ReviewStatusSchema.default('confirmed'),
    originalUrl: z
      .url()
      .max(2000)
      .refine(
        (v) => ['http:', 'https:'].includes(new URL(v).protocol),
        'Source URL must use HTTP(S)',
      )
      .optional(),
    relations: z.array(RelationInputSchema).max(1000).default([]),
    title: z.string().min(1).max(500),
    summary: z.string().max(10000),
    publishedAt: UtcTimestampSchema,
    effectiveFrom: UtcTimestampSchema,
    effectiveTo: UtcTimestampSchema.nullable(),
    bbox: BboxSchema.optional(),
    vesselTypes: z.array(z.number().int().min(1).max(99)).max(99).default([]),
    mmsis: z.array(MmsiSchema).max(1000).default([]),
    paragraphs: z
      .array(z.strictObject({ id: IdSchema, text: z.string().min(1).max(20000) }))
      .min(1)
      .max(100),
    commonSourceId: IdSchema.optional(),
    supersedesId: IdSchema.optional(),
    originalArchiveId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    raw: z.unknown().refine((v) => {
      try {
        const serialized = JSON.stringify(v);
        return (
          typeof serialized === 'string' &&
          new TextEncoder().encode(serialized).byteLength <= 1_048_576
        );
      } catch {
        return false;
      }
    }, 'Raw JSON exceeds limit'),
  })
  .refine(
    (v) => v.effectiveTo === null || Date.parse(v.effectiveTo) >= Date.parse(v.effectiveFrom),
    'Effective interval is reversed',
  )
  .refine((v) => v.version === 1 || Boolean(v.supersedesId), 'Revisions require supersedesId')
  .refine(
    (v) => new Set(v.paragraphs.map((p) => p.id)).size === v.paragraphs.length,
    'Paragraph ids must be unique',
  );
type ParsedIntelligenceInput = z.infer<typeof IntelligenceInputSchema>;
export type IntelligenceInput = Omit<ParsedIntelligenceInput, 'reviewStatus' | 'relations'> &
  Partial<Pick<ParsedIntelligenceInput, 'reviewStatus' | 'relations'>>;
export interface IntelligenceEvent extends IntelligenceInput {
  id: string;
  archiveKey: string;
  checksum: string;
  recordedAt: string;
}
export interface FusionAisRecord {
  recordId: string;
  messageId: string;
  vesselId: string;
  mmsi: string;
  occurredAt: string;
  longitude: number;
  latitude: number;
  speedOverGround: number | null;
  shipType: number | null;
  staticEvidence?: { recordId: string; raw: StaticObservation };
  raw: PositionObservation;
}
export interface FusionDataset {
  from: string;
  to: string;
  queriedAt: string;
  complete: true;
  ais: FusionAisRecord[];
  intelligence: IntelligenceEvent[];
}
export interface FusionReadyEvent {
  id: string;
  kind: 'ais' | 'intelligence';
  from: string;
  to: string;
  recordIds: string[];
  createdAt: string;
}
