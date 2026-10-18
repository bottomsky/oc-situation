import { z } from 'zod';
import { GeometrySchema } from './intelligence-spatial';
import { SpatialBboxSchema, SpatialRegionSchema } from './spatial';
export const FOCUS_TARGET_LIMIT = 100;
export const FocusTargetRefSchema = z.strictObject({
  kind: z.enum(['vessel', 'track', 'route', 'event', 'intelligence', 'region']),
  id: z.string().min(1).max(200),
  revision: z.number().int().nonnegative().optional(),
  sourceTaskId: z.uuid().optional(),
});
export type FocusTargetRef = z.infer<typeof FocusTargetRefSchema>;
export const FocusTargetSnapshotSchema = z.strictObject({
  ref: FocusTargetRefSchema,
  label: z.string().max(1000),
  geometry: GeometrySchema,
  observedAt: z.iso.datetime().optional(),
  source: z.string().max(300).optional(),
  region: SpatialRegionSchema.optional(),
});
export const AgentFocusResultSchema = z
  .strictObject({
    kind: z.literal('map_focus'),
    version: z.number().int().nonnegative(),
    inputRevision: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    targets: z.array(FocusTargetSnapshotSchema).max(FOCUS_TARGET_LIMIT),
    missing: z.array(FocusTargetRefSchema).max(10000),
    omittedCount: z.number().int().nonnegative().optional(),
    bbox: SpatialBboxSchema.nullable(),
    displayStatus: z.enum(['complete', 'partial', 'unlocated']),
    cameraPolicy: z.literal('if-needed-once'),
  })
  .refine(
    (v) =>
      v.displayStatus === 'complete'
        ? v.targets.length > 0 && v.missing.length === 0 && !v.omittedCount
        : v.displayStatus === 'partial'
          ? v.targets.length > 0 && (v.missing.length > 0 || !!v.omittedCount)
          : v.targets.length === 0,
    'Display status must match located objects',
  );
export type AgentFocusResult = z.infer<typeof AgentFocusResultSchema>;
export type FocusTargetSnapshot = z.infer<typeof FocusTargetSnapshotSchema>;
