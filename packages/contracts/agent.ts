import { GeometrySchema } from './intelligence-spatial';
import { SpatialRegionSchema } from './spatial';
import { FocusTargetRefSchema } from './agent-focus';
import { VesselTracksSelectorSchema } from './vessel-tracks';
import { UiBindingSchema, UiResultSchema } from './agent-ui';
import { z } from 'zod';
import { MapCameraRequestSchema, HighlightClearSchema } from './agent-map';
import { DynamicSkillRefSchema } from './dynamic-skills';
import { TopicDefinitionIdSchema } from './topics';
import { IntelligenceSearchSpecSchema, IntelligenceTimeRangeSchema } from './intelligence-search';

const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3], 'South must precede north');
const Mmsis = z
  .array(z.string().regex(/^\d{9}$/))
  .max(100)
  .refine((items) => new Set(items).size === items.length, 'Duplicate vessels');
export const AgentSkillCandidatesSchema = z
  .array(
    z.strictObject({
      skillId: z.string().min(1).max(200),
      version: z.string().min(1).max(100),
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
    }),
  )
  .min(1)
  .max(20);
export const AgentIntentSchema = z.enum([
  'conversation',
  'vessel_list',
  'vessel_detail',
  'analysis',
  'explain',
  'unresolved',
  'intelligence_search',
  'ais_heatmap',
  'vessel_tracks',
  'vessel_highlights',
  'map_camera',
  'map_focus',
  'route_plan',
  'route_manage',
  'event_query',
  'event_manage',
  'ui_control',
  'skill',
]);
export type AgentIntent = z.infer<typeof AgentIntentSchema>;
export const AgentPurposeSchema = z.enum([
  'vessel_list',
  'vessel_detail',
  'port-restriction',
  'area-low-speed-notice',
  'intelligence_search',
  'ais_heatmap',
  'vessel_tracks',
]);
export type AgentPurpose = z.infer<typeof AgentPurposeSchema>;
export const AgentTimeRangeSchema = z
  .strictObject({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
  })
  .refine(
    (range) =>
      Date.parse(range.from) < Date.parse(range.to) &&
      Date.parse(range.to) - Date.parse(range.from) <= 168 * 3_600_000,
    'Invalid historical range',
  );
export const AgentFiltersSchema = z.strictObject({
  sourceId: z.string().min(1).max(200).optional(),
  shipType: z.number().int().min(1).max(99).optional(),
  hours: z.number().int().min(1).max(720).optional(),
});
export const VesselCircleRequestSchema = z.strictObject({
  mmsi: z.string().regex(/^[1-9]\d{8}$/),
  radiusMeters: z.number().min(100).max(2000000),
});
export type VesselCircleRequest = z.infer<typeof VesselCircleRequestSchema>;
export const AgentSelectionSchema = z.strictObject({
  vesselCircle: VesselCircleRequestSchema.optional(),
  region: SpatialRegionSchema.optional(),
  focusTargets: z.array(FocusTargetRefSchema).max(100).optional(),
  skillRef: DynamicSkillRefSchema.optional(),
  skillCandidates: AgentSkillCandidatesSchema.optional(),
  bbox: Bbox.optional(),
  mmsis: Mmsis.optional(),
  timeRange: AgentTimeRangeSchema.optional(),
  filters: AgentFiltersSchema.optional(),
  purpose: AgentPurposeSchema.optional(),
  intelligenceQuery: IntelligenceSearchSpecSchema.optional(),
  intelligenceTimeRange: IntelligenceTimeRangeSchema.optional(),
  intelligenceTimeUnclear: z.boolean().optional(),
  heatmapTimeUnclear: z.boolean().optional(),
  tracksTimeUnclear: z.boolean().optional(),
  vesselSelector: VesselTracksSelectorSchema.optional(),
  mapCamera: MapCameraRequestSchema.optional(),
  highlightClear: HighlightClearSchema.optional(),
  highlightAndFocus: z.boolean().optional(),
  mapTargetZoom: z.number().min(0).max(22).optional(),
  highlightTaskIndex: z.number().int().positive().max(100).optional(),
  highlightClearUnclear: z.boolean().optional(),
  intelligenceObjectUnclear: z.boolean().optional(),
  intelligenceObjectCandidates: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(200),
        name: z.string().min(1).max(300),
      }),
    )
    .max(20)
    .optional(),
});
export type AgentSelection = z.infer<typeof AgentSelectionSchema>;
export const AgentInputValuesSchema = AgentSelectionSchema.extend({
  historyHours: z.number().int().min(1).max(168).optional(),
}).refine(
  (input) => !(input.historyHours !== undefined && input.timeRange),
  'Use a relative preset or an absolute time range',
);
export type AgentInputValues = z.infer<typeof AgentInputValuesSchema>;
export const AgentMapContextSchema = AgentFiltersSchema.extend({
  selectedTargets: z.array(FocusTargetRefSchema).max(100).optional(),
  region: SpatialRegionSchema.optional(),
  bbox: Bbox,
  capturedAt: z.iso.datetime(),
  selectedMmsis: Mmsis.optional(),
});
export type AgentMapContext = z.infer<typeof AgentMapContextSchema>;
export const AgentInputFieldSchema = z.enum([
  'region',
  'vessels',
  'time',
  'goal',
  'topic',
  'vessel_selector',
  'skill',
]);
export type AgentInputField = z.infer<typeof AgentInputFieldSchema>;
export const AgentInputReasonSchema = z.enum([
  'missing_region',
  'missing_vessels',
  'missing_time',
  'missing_goal',
  'data_limit',
  'retention',
  'scope_changed',
  'missing_topic',
  'missing_vessel_selector',
  'ambiguous_skill',
]);
export type AgentInputReason = z.infer<typeof AgentInputReasonSchema>;
export const AgentInputSpecSchema = z.strictObject({
  fields: z
    .array(AgentInputFieldSchema)
    .min(1)
    .max(7)
    .refine((fields) => new Set(fields).size === fields.length, 'Duplicate input fields'),
  reason: AgentInputReasonSchema,
  skillCandidates: AgentSkillCandidatesSchema.optional(),
});
export type AgentInputSpec = z.infer<typeof AgentInputSpecSchema>;
export const AgentInputResponseSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('accept'),
    inputRevision: z.number().int().nonnegative(),
    values: AgentInputValuesSchema,
  }),
  z.strictObject({ action: z.literal('decline'), inputRevision: z.number().int().nonnegative() }),
]);
export type AgentInputResponse = z.infer<typeof AgentInputResponseSchema>;
export const AgentInputRequestSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  taskId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  pauseGeneration: z.number().int().nonnegative(),
  fields: z.array(AgentInputFieldSchema),
  reason: AgentInputReasonSchema,
  prefill: AgentSelectionSchema,
  status: z.enum(['pending', 'answered', 'cancelled', 'superseded']),
  response: AgentSelectionSchema.nullable(),
  createdAt: z.iso.datetime(),
  answeredAt: z.iso.datetime().nullable(),
});
export type AgentInputRequest = z.infer<typeof AgentInputRequestSchema>;
export const AgentVesselItemSchema = z.object({
  mmsi: z.string().regex(/^\d{9}$/),
  name: z.string().nullable(),
  imo: z.string().nullable(),
  shipType: z.number().nullable(),
  latestPosition: z
    .object({
      lat: z.number(),
      lon: z.number(),
      observedAt: z.iso.datetime(),
      sogKnots: z.number().nullable(),
      sourceId: z.string(),
    })
    .nullable(),
});
export type AgentVesselItem = z.infer<typeof AgentVesselItemSchema>;
export const AgentQueryResultSchema = z.object({
  regionAnchor: z
    .strictObject({
      mmsi: z.string().regex(/^[1-9]\d{8}$/),
      observedAt: z.iso.datetime(),
      sourceId: z.string().min(1).max(200),
    })
    .optional(),
  regionGeometry: GeometrySchema.optional(),
  kind: z.enum(['vessel_list', 'vessel_detail']),
  version: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  truncated: z.boolean(),
  items: z.array(AgentVesselItemSchema).max(100),
  asOf: z.iso.datetime(),
  selection: AgentSelectionSchema,
});
export type AgentQueryResult = z.infer<typeof AgentQueryResultSchema>;
export const AgentRetryInputSchema = z.strictObject({
  uiBinding: UiBindingSchema.optional(),
  skillVersionPolicy: z.enum(['original', 'latest']).optional(),
});
export const AgentMessageInputSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000),
  bbox: Bbox.optional(),
  historyHours: z.number().int().min(1).max(168).default(24),
  mapContext: AgentMapContextSchema.optional(),
  uiBinding: UiBindingSchema.optional(),
  skillRef: DynamicSkillRefSchema.optional(),
});
export type AgentMessageInput = z.infer<typeof AgentMessageInputSchema>;
export const AgentSessionInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(200).default('区域研判'),
});
export const AgentTaskStatusSchema = z.enum([
  'awaiting_input',
  'queued',
  'running',
  'waiting_result',
  'waiting_ui',
  'completed',
  'failed',
  'cancelled',
]);
export const AgentSessionSchema = z.object({
  id: z.uuid(),
  ownerId: z.uuid(),
  title: z.string(),
  createdAt: z.iso.datetime(),
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;
export const AgentMessageSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  taskId: z.uuid().nullable(),
  resultVersion: z.number().int().nonnegative().nullable().optional(),
  inputRevision: z.number().int().nonnegative().nullable().optional(),
  createdAt: z.iso.datetime(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export const AgentTaskSchema = z.object({
  skillRef: DynamicSkillRefSchema.nullable().optional(),
  skillVersionPolicy: z.enum(['original', 'latest']).optional(),
  uiBinding: UiBindingSchema.nullable().optional(),
  uiResult: UiResultSchema.nullable().optional(),
  id: z.uuid(),
  sessionId: z.uuid(),
  ownerId: z.uuid(),
  status: AgentTaskStatusSchema,
  goal: z.string(),
  bbox: Bbox.nullable(),
  historyHours: z.number(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  definitionId: TopicDefinitionIdSchema.nullable(),
  generation: z.number(),
  modelCalls: z.number(),
  toolCalls: z.number(),
  resultVersion: z.number(),
  summaryResultVersion: z.number().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  intent: AgentIntentSchema.optional(),
  selection: AgentSelectionSchema.optional(),
  inputRevision: z.number().int().nonnegative().optional(),
  resultInputRevision: z.number().int().nonnegative().nullable().optional(),
  summaryInputRevision: z.number().int().nonnegative().nullable().optional(),
  errorCode: z.string().nullable().optional(),
  retryOfTaskId: z.uuid().nullable().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export const AgentEventSchema = z.object({
  id: z.string(),
  sessionId: z.uuid(),
  taskId: z.uuid().nullable(),
  type: z.string(),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.iso.datetime(),
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export const AgentStepSchema = z.object({
  key: z.string(),
  name: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  createdAt: z.iso.datetime(),
});
export type AgentStep = z.infer<typeof AgentStepSchema>;
export const AgentEventsQuerySchema = z.strictObject({
  cursor: z
    .string()
    .regex(/^\d{1,18}$/)
    .default('0'),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
