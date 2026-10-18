import { z } from 'zod';
import { SkillBindingSchema, ToolExecutionIdentitySchema } from './agent-capabilities';
import { UiOperationSchema } from './agent-ui';

export const DynamicSkillArtifactKindSchema = z.enum([
  'map_focus',
  'route_plan',
  'route',
  'operational_events',
  'operational_event',
  'vessel_list',
  'vessel_detail',
  'ais_heatmap',
  'vessel_tracks',
  'intelligence_search',
  'analysis',
  'vessel_highlights',
  'map_camera',
]);
export type DynamicSkillArtifactKind = z.infer<typeof DynamicSkillArtifactKindSchema>;
const StepId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const DynamicSkillStepSchema = z.strictObject({
  id: StepId,
  toolId: z.string().min(1).max(100),
  input: z.record(z.string(), z.json()),
  artifactKind: DynamicSkillArtifactKindSchema.optional(),
  ui: UiOperationSchema.optional(),
});
export const DynamicSkillDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  name: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .max(64),
  description: z.string().trim().min(1).max(2000),
  body: z.string().trim().min(1).max(65_536),
  references: z
    .record(
      z.string().regex(/^references\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/),
      z.string().max(65_536),
    )
    .default({}),
  requiredInputs: z
    .array(z.enum(['region', 'vessels', 'time', 'goal', 'topic', 'vessel_selector']))
    .max(6)
    .default([]),
  toolIds: z.array(z.string().min(1).max(100)).min(1).max(32),
  steps: z.array(DynamicSkillStepSchema).min(1).max(16),
  expectedArtifacts: z
    .array(z.strictObject({ stepId: StepId, kind: DynamicSkillArtifactKindSchema }))
    .max(16)
    .default([]),
  requiredDisplays: z.array(StepId).max(16).default([]),
});
export type DynamicSkillDefinition = z.infer<typeof DynamicSkillDefinitionSchema>;
export const DynamicSkillRefSchema = z.strictObject({
  skillId: z.string().min(1).max(200),
  version: z.string().min(1).max(100).optional(),
});
export type DynamicSkillRef = z.infer<typeof DynamicSkillRefSchema>;
export const DynamicSkillVersionSchema = z.strictObject({
  ownerId: z.uuid(),
  binding: SkillBindingSchema,
  definition: DynamicSkillDefinitionSchema,
  source: z.enum(['agent', 'user']),
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
});
export type DynamicSkillVersion = z.infer<typeof DynamicSkillVersionSchema>;
export const DynamicSkillSummarySchema = z.strictObject({
  skillId: z.string(),
  name: z.string(),
  description: z.string(),
  toolIds: z.array(z.string()),
  enabled: z.boolean(),
  currentVersion: z.string().nullable(),
  source: z.enum(['agent', 'user']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DynamicSkillSummary = z.infer<typeof DynamicSkillSummarySchema>;
export const DynamicSkillCatalogSchema = z.strictObject({
  catalogRevision: z.number().int().nonnegative(),
  items: z.array(DynamicSkillSummarySchema),
});
export type DynamicSkillCatalog = z.infer<typeof DynamicSkillCatalogSchema>;
export const DynamicSkillDetailSchema = z.strictObject({
  catalogRevision: z.number().int().nonnegative(),
  skill: DynamicSkillSummarySchema,
  versions: z.array(DynamicSkillVersionSchema),
});
export const DynamicSkillMutationSchema = z.strictObject({
  operationId: z.uuid(),
  expectedCatalogRevision: z.number().int().nonnegative(),
});
export const PublishDynamicSkillSchema = DynamicSkillMutationSchema.extend({
  skillId: z.string().min(1).max(200).optional(),
  definition: DynamicSkillDefinitionSchema,
});
export type PublishDynamicSkill = z.infer<typeof PublishDynamicSkillSchema>;
export const SetDynamicSkillEnabledSchema = DynamicSkillMutationSchema.extend({
  enabled: z.boolean(),
});
export const RevokeDynamicSkillVersionSchema = DynamicSkillMutationSchema.extend({
  reason: z.string().trim().min(1).max(500),
});
export const AgentSkillFenceSchema = ToolExecutionIdentitySchema.extend({
  workerId: z.string().min(1).max(200),
});
export type AgentSkillFence = z.infer<typeof AgentSkillFenceSchema>;
export const TaskDynamicSkillBindingSchema = z.strictObject({
  ownerId: z.uuid(),
  taskId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  binding: SkillBindingSchema,
  toolCeiling: z.array(z.string()),
  boundAt: z.iso.datetime(),
});
export type TaskDynamicSkillBinding = z.infer<typeof TaskDynamicSkillBindingSchema>;
export const DynamicSkillArtifactSchema = z.strictObject({
  id: z.uuid(),
  ownerId: z.uuid(),
  taskId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  stepId: StepId,
  kind: DynamicSkillArtifactKindSchema,
  payload: z.json(),
  modelProjection: z.json(),
  createdAt: z.iso.datetime(),
});
export type DynamicSkillArtifact = z.infer<typeof DynamicSkillArtifactSchema>;
export const DynamicSkillCallSchema = z.strictObject({
  callId: z.uuid(),
  taskId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  stepId: StepId,
  toolId: z.string(),
  generation: z.number().int().nonnegative(),
  status: z.enum(['running', 'completed', 'failed', 'unknown', 'waiting_ui']),
  input: z.json(),
  localResult: z.json().nullable(),
  modelProjection: z.json().nullable(),
  artifactRefs: z.array(z.uuid()),
  errorCode: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type DynamicSkillCall = z.infer<typeof DynamicSkillCallSchema>;
export const DynamicSkillExecutionSchema = z.strictObject({
  taskBinding: TaskDynamicSkillBindingSchema.nullable(),
  version: DynamicSkillVersionSchema.nullable(),
  calls: z.array(DynamicSkillCallSchema),
  artifacts: z.array(DynamicSkillArtifactSchema),
  createdVersions: z.array(DynamicSkillVersionSchema),
});
export type DynamicSkillExecution = z.infer<typeof DynamicSkillExecutionSchema>;

/** Supplied by the trusted host registry, never by the candidate. */
export interface DynamicSkillToolDescriptor {
  id: string;
  artifactKinds: readonly string[];
  allowedPhases: readonly string[];
}

export type DynamicSkillErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'invalid_input'
  | 'fenced'
  | 'skill_disabled'
  | 'skill_revoked'
  | 'skill_changed'
  | 'configuration'
  | 'budget';
