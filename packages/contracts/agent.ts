import { z } from 'zod';
import { TopicDefinitionIdSchema } from './topics';

const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[1] <= b[3], 'South must precede north');
export const AgentMessageInputSchema = z.strictObject({
  content: z.string().trim().min(1).max(4000),
  bbox: Bbox.optional(),
  historyHours: z.number().int().min(1).max(168).default(24),
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
  createdAt: z.iso.datetime(),
});
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export const AgentTaskSchema = z.object({
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
