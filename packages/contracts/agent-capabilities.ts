import { z } from 'zod';

const Id = z.string().min(1).max(200);
const Version = z.string().min(1).max(100);

/** Pins the reviewed skill content and the trusted implementation that executes it. */
export const SkillBindingSchema = z.strictObject({
  skillId: Id,
  version: Version,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  adapterVersion: Version,
});
export type SkillBinding = z.infer<typeof SkillBindingSchema>;

/** Populated by the runtime from persisted ownership and task state. */
export const ToolExecutionIdentitySchema = z.strictObject({
  ownerId: z.uuid(),
  taskId: z.uuid(),
  inputRevision: z.number().int().nonnegative(),
  generation: z.number().int().nonnegative(),
});
export type ToolExecutionIdentity = z.infer<typeof ToolExecutionIdentitySchema>;

export const SkillCapabilityMetadataSchema = z.strictObject({
  skillId: Id,
  version: Version,
  description: z.string().min(1).max(2000),
  toolIds: z
    .array(Id)
    .max(32)
    .refine((items) => new Set(items).size === items.length, 'Duplicate tools'),
});
export type SkillCapabilityMetadata = z.infer<typeof SkillCapabilityMetadataSchema>;
