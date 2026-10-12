import { z } from 'zod';
const TopicBboxSchema = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3], 'South must precede north');

export const TopicDefinitionIdSchema = z.enum(['port-restriction', 'area-low-speed-notice']);
export type TopicDefinitionId = z.infer<typeof TopicDefinitionIdSchema>;
export const TopicConfigSchema = z
  .strictObject({
    bbox: TopicBboxSchema,
    historyHours: z.number().int().min(1).max(168).default(24),
    windowMinutes: z.number().int().min(1).max(1440).default(60),
    lowSpeedKnots: z.number().min(0).max(20).default(3),
    minPositions: z.number().int().min(2).max(1000).default(3),
    scheduleSeconds: z.number().int().min(10).max(86400).default(60),
  })
  .refine((value) => value.windowMinutes <= value.historyHours * 60, 'Window exceeds history');
export type TopicConfig = z.infer<typeof TopicConfigSchema>;
export const CreateTopicInstanceSchema = z.strictObject({
  definitionId: TopicDefinitionIdSchema,
  name: z.string().trim().min(1).max(200),
  config: TopicConfigSchema,
  enabled: z.boolean().default(false),
});
export const TopicStateSchema = z.strictObject({ enabled: z.boolean() });
export interface TopicDefinition {
  id: TopicDefinitionId;
  name: string;
  version: string;
  description: string;
  requiredCapabilities: string[];
  available: boolean;
}
export interface TopicInstance {
  id: string;
  definitionId: TopicDefinitionId;
  name: string;
  config: TopicConfig;
  enabled: boolean;
  generation: number;
  status: 'disabled' | 'warming' | 'ready' | 'degraded';
  checkpoint: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
}
export interface TopicRun {
  id: string;
  instanceId: string;
  generation: number;
  trigger: 'warmup' | 'incremental' | 'scheduled' | 'manual';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  from: string;
  to: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
/** Immutable query snapshots: the original payload and identifiers survive source edits. */
export interface TopicAisEvidence {
  recordId: string;
  vesselId?: string;
  mmsi: string;
  occurredAt: string;
  longitude: number;
  latitude: number;
  speedOverGround: number | null;
  shipType: number | null;
  staticEvidence?: unknown;
  raw: unknown;
}
export interface TopicDocumentEvidence {
  reviewStatus?: string;
  id: string;
  sourceId: string;
  externalId: string;
  version: number;
  status: string;
  title: string;
  kind: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  bbox?: [number, number, number, number] | null;
  vesselTypes: number[];
  mmsis: string[];
  paragraphs: { id: string; text: string }[];
  archiveKey?: string | null;
  raw: unknown;
}
export interface TopicDataset {
  from: string;
  to: string;
  ais: TopicAisEvidence[];
  intelligence: TopicDocumentEvidence[];
  queriedAt: string;
  truncated?: boolean;
}
export interface EvidenceStep {
  id: string;
  rule: string;
  outcome: string;
  references: string[];
}
export interface AnalysisResult {
  id: string;
  instanceId: string;
  definitionId: TopicDefinitionId;
  definitionVersion: string;
  revision: number;
  status: 'active' | 'revised' | 'withdrawn';
  title: string;
  summary: string;
  mmsi: string;
  documentId: string;
  vesselId?: string;
  from: string;
  to: string;
  bbox: [number, number, number, number];
  confidence: 'rule-match' | 'observation';
  evidence: {
    ais: TopicAisEvidence[];
    documents: TopicDocumentEvidence[];
    steps: EvidenceStep[];
    limitations: string[];
    parameters: TopicConfig;
    queriedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}
export interface AnalysisFeedItem {
  cursor: string;
  type: 'analysis.updated';
  resultId: string;
  instanceId: string;
  revision: number;
  status: AnalysisResult['status'];
  createdAt: string;
}

export const AnalysisResultSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  instanceId: z.string().min(1),
  definitionId: TopicDefinitionIdSchema,
  definitionVersion: z.string().min(1).max(100),
  revision: z.number().int().positive(),
  status: z.enum(['active', 'revised', 'withdrawn']),
  title: z.string().min(1).max(500),
  summary: z.string().min(1).max(10000),
  mmsi: z.string().regex(/^[1-9]\d{8}$/),
  documentId: z.string().min(1),
  vesselId: z.string().optional(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  bbox: TopicBboxSchema,
  confidence: z.enum(['rule-match', 'observation']),
  evidence: z.object({
    ais: z
      .array(
        z
          .object({
            recordId: z.string().min(1),
            mmsi: z.string(),
            occurredAt: z.iso.datetime(),
            longitude: z.number().min(-180).max(180),
            latitude: z.number().min(-90).max(90),
            speedOverGround: z.number().nullable(),
            shipType: z.number().nullable(),
            staticEvidence: z.unknown().optional(),
            raw: z.unknown(),
          })
          .passthrough(),
      )
      .min(1)
      .max(20000),
    documents: z
      .array(
        z
          .object({
            id: z.string(),
            sourceId: z.string(),
            externalId: z.string(),
            version: z.number().int().positive(),
            status: z.string(),
            title: z.string(),
            kind: z.string(),
            effectiveFrom: z.iso.datetime(),
            effectiveTo: z.iso.datetime().nullable(),
            bbox: TopicBboxSchema.nullable().optional(),
            vesselTypes: z.array(z.number()),
            mmsis: z.array(z.string()),
            paragraphs: z.array(z.object({ id: z.string(), text: z.string() })),
            archiveKey: z.string().nullable().optional(),
            raw: z.unknown(),
          })
          .passthrough(),
      )
      .min(1)
      .max(100),
    steps: z
      .array(
        z.object({
          id: z.string(),
          rule: z.string(),
          outcome: z.string(),
          references: z.array(z.string()),
        }),
      )
      .min(1)
      .max(100),
    limitations: z.array(z.string()).min(1),
    parameters: TopicConfigSchema,
    queriedAt: z.iso.datetime(),
  }),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
