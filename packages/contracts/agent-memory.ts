import { z } from 'zod';
import { FocusTargetRefSchema } from './agent-focus';

const Revision = z.number().int().nonnegative();
export const AgentMemoryValueSchema = z.custom<z.infer<ReturnType<typeof z.json>>>((value) => {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const bounded = (item: unknown, depth: number): boolean => {
    if (++nodes > 10000 || depth > 16) return false;
    if (item === null || typeof item === 'boolean') return true;
    if (typeof item === 'string') return item.length <= 16384;
    if (typeof item === 'number') return Number.isFinite(item);
    if (typeof item !== 'object' || seen.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    seen.add(item);
    return Object.values(item).every((entry) => bounded(entry, depth + 1));
  };
  return bounded(value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= 16384;
}, 'Memory must be JSON within 16 KiB and depth 16');
const Json = AgentMemoryValueSchema;
export const AgentMemorySourceSchema = z.strictObject({
  taskId: z.uuid().optional(),
  messageId: z.uuid().optional(),
  description: z.string().max(1000).optional(),
});
export const AgentMemoryReferenceSchema = z.strictObject({
  refType: z.string().min(1).max(100),
  refId: z.string().min(1).max(500),
  label: z.string().max(500).optional(),
});
export const AgentMemoryObjectSetSchema = z.strictObject({
  id: z.string().min(1).max(200),
  label: z.string().min(1).max(500),
  kind: z.enum(['vessels', 'references']),
  turnSeq: Revision,
  members: z
    .array(
      z.discriminatedUnion('kind', [
        z.strictObject({ kind: z.literal('vessel'), mmsi: z.string().regex(/^[1-9]\d{8}$/) }),
        AgentMemoryReferenceSchema.extend({ kind: z.literal('reference') }),
      ]),
    )
    .max(100000),
  targets: z.array(FocusTargetRefSchema).max(100000).optional(),
  source: AgentMemorySourceSchema,
  querySucceeded: z.boolean().optional(),
  uiSucceeded: z.boolean().optional(),
});
export const AgentSessionMemoryWriteSchema = z.strictObject({
  expectedRevision: Revision,
  turnSeq: Revision,
  expectedGeneration: Revision.optional(),
  expectedAccountGeneration: Revision.optional(),
  objectSets: z.array(AgentMemoryObjectSetSchema).max(32).optional(),
  conditions: z
    .record(z.string().max(200), Json)
    .refine(
      (value) =>
        Object.keys(value).length <= 128 &&
        new TextEncoder().encode(JSON.stringify(value)).byteLength <= 65536,
      'Conditions exceed memory budget',
    )
    .optional(),
  references: z.array(AgentMemoryReferenceSchema).max(1000).optional(),
  summary: z.string().max(12000).optional(),
});
export const AgentMemorySettingsUpdateSchema = z.strictObject({
  operationId: z.uuid(),
  expectedRevision: Revision,
  readEnabled: z.boolean(),
  proposalsEnabled: z.boolean(),
});
export const AgentAccountMemoryMutationSchema = z
  .strictObject({
    operationId: z.uuid(),
    expectedRevision: Revision,
    expectedGeneration: Revision.optional(),
    action: z.enum(['remember', 'propose', 'accept', 'reject', 'delete', 'clear']),
    entryId: z.uuid().optional(),
    category: z.string().min(1).max(100).optional(),
    key: z.string().min(1).max(200).optional(),
    value: Json.optional(),
    source: AgentMemorySourceSchema.optional(),
  })
  .superRefine((input, ctx) => {
    if (
      ['remember', 'propose'].includes(input.action) &&
      (!input.category || !input.key || input.value === undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Memory writes require category, key and value' });
    if (['accept', 'reject', 'delete'].includes(input.action) && !input.entryId)
      ctx.addIssue({ code: 'custom', message: 'Entry action requires entryId' });
    if (input.action === 'propose' && input.expectedGeneration === undefined)
      ctx.addIssue({ code: 'custom', message: 'Automatic extraction requires a generation fence' });
  });
export const AgentSessionMemoryResetSchema = z.strictObject({
  operationId: z.uuid(),
  expectedRevision: Revision,
});
export type AgentMemorySource = z.infer<typeof AgentMemorySourceSchema>;
export type AgentMemoryReference = z.infer<typeof AgentMemoryReferenceSchema>;
export type AgentMemoryObjectSet = z.infer<typeof AgentMemoryObjectSetSchema>;
export type AgentSessionMemoryWrite = z.infer<typeof AgentSessionMemoryWriteSchema>;
export type AgentAccountMemoryMutation = z.infer<typeof AgentAccountMemoryMutationSchema>;
export type AgentMemorySettingsUpdate = z.infer<typeof AgentMemorySettingsUpdateSchema>;
export interface AgentMemorySettings {
  readEnabled: boolean;
  proposalsEnabled: boolean;
  generation: number;
  revision: number;
}
export interface AgentSessionMemory {
  sessionId: string;
  revision: number;
  turnSeq: number;
  generation: number;
  objectSets: AgentMemoryObjectSet[];
  conditions: Record<string, z.infer<typeof Json>>;
  references: AgentMemoryReference[];
  summary: string;
  updatedAt: string;
}
export interface AgentAccountMemoryEntry {
  id: string;
  category: string;
  key: string;
  value: z.infer<typeof Json>;
  status: 'active' | 'proposed';
  source: AgentMemorySource;
  revision: number;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
export interface AgentAccountMemoryState {
  revision: number;
  entries: AgentAccountMemoryEntry[];
}
export interface AgentMemoryTurn {
  messageId?: string;
  role: 'user' | 'assistant';
  content: string;
  taskId: string | null;
}
export interface AgentMemorySnapshot {
  taskId: string;
  inputRevision: number;
  turnSeq: number;
  settingsGeneration: number;
  accountRevision: number;
  sessionRevision: number;
  sessionGeneration: number;
  settings: AgentMemorySettings;
  session: AgentSessionMemory | null;
  account: AgentAccountMemoryEntry[];
  recentTurns: AgentMemoryTurn[];
}
