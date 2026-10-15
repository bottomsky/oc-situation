import type { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  ToolExecutionIdentitySchema,
  type ToolExecutionIdentity,
} from '../../../packages/contracts/agent-capabilities';
import { CapabilityError } from './errors';
import type { CapabilityRoutingMetadata } from './metadata';

export interface CapabilityPorts {
  active(identity: ToolExecutionIdentity): Promise<boolean>;
  reserve(kind: 'tool', maximum: number): Promise<boolean>;
  saveStep(key: string, name: string, output: unknown): Promise<boolean>;
}
export interface ToolExecutionContext {
  readonly identity: Readonly<ToolExecutionIdentity>;
  readonly phase: string;
  readonly signal?: AbortSignal;
}
export interface ToolDefinition<Input = unknown, Output = unknown, Projection = unknown> {
  readonly id: string;
  readonly description: string;
  readonly allowedPhases: readonly string[];
  readonly inputSchema: z.ZodType<Input>;
  readonly outputSchema: z.ZodType<Output>;
  readonly handler: (input: Input, context: ToolExecutionContext) => Promise<Output>;
  readonly project: (output: Output) => Projection;
}
export interface RegisteredTool {
  readonly id: string;
  readonly description: string;
  readonly allowedPhases: readonly string[];
  readonly inputSchema: z.ZodType;
  readonly outputSchema: z.ZodType;
  readonly handler: (input: unknown, context: ToolExecutionContext) => Promise<unknown>;
  readonly project: (output: unknown) => unknown;
}
/** Erases the heterogeneous registry boundary after preserving handler/schema inference. */
export function defineTool<I, O, P>(definition: ToolDefinition<I, O, P>): RegisteredTool {
  return Object.freeze({
    ...definition,
    allowedPhases: Object.freeze([...definition.allowedPhases]),
    handler: (input: unknown, context: ToolExecutionContext) =>
      definition.handler(input as I, context),
    project: (output: unknown) => definition.project(output as O),
  });
}
export interface CapabilityDefinition extends CapabilityRoutingMetadata {
  readonly id: string;
  readonly description: string;
  readonly skillId?: string;
  readonly legacy?: boolean;
  readonly tools: readonly RegisteredTool[];
}
export class CapabilityRegistry {
  readonly #capabilities = new Map<string, CapabilityDefinition>();
  constructor(definitions: readonly CapabilityDefinition[]) {
    const toolIds = new Set<string>();
    for (const definition of definitions) {
      if (!definition.id || !definition.description || this.#capabilities.has(definition.id))
        throw new CapabilityError('configuration', 'duplicate or invalid capability');
      for (const tool of definition.tools) {
        if (!tool.id || !tool.description || !tool.allowedPhases.length || toolIds.has(tool.id))
          throw new CapabilityError('configuration', 'duplicate or invalid tool');
        toolIds.add(tool.id);
      }
      this.#capabilities.set(
        definition.id,
        Object.freeze({
          ...definition,
          intents: Object.freeze([...definition.intents]),
          requiredInputs: Object.freeze(
            Object.fromEntries(
              Object.entries(definition.requiredInputs).map(([intent, fields]) => [
                intent,
                Object.freeze([...fields]),
              ]),
            ),
          ),
          tools: Object.freeze([...definition.tools]),
        }),
      );
    }
    Object.freeze(this);
  }
  list(): readonly CapabilityDefinition[] {
    return Object.freeze([...this.#capabilities.values()]);
  }
  getTool(capabilityId: string, toolId: string): RegisteredTool {
    const capability = this.#capabilities.get(capabilityId);
    if (capability && !capability.available)
      throw new CapabilityError('configuration', 'capability unavailable');
    const tool = capability?.tools.find((entry) => entry.id === toolId);
    if (!tool) throw new CapabilityError('configuration', 'unknown capability tool');
    return tool;
  }
}
export async function assertActive(
  ports: CapabilityPorts,
  context: ToolExecutionContext,
): Promise<void> {
  if (context.signal?.aborted || !(await ports.active(context.identity)) || context.signal?.aborted)
    throw new CapabilityError('fenced');
}
export class CapabilityExecutor {
  constructor(
    readonly registry: CapabilityRegistry,
    readonly ports: CapabilityPorts,
    readonly options: { maxToolCalls?: number } = {},
  ) {}
  async execute(
    request: ToolExecutionContext & { capabilityId: string; toolId: string; input: unknown },
  ): Promise<{ local: unknown; model: unknown }> {
    const identity = ToolExecutionIdentitySchema.safeParse(request.identity);
    if (!identity.success) throw new CapabilityError('invalid_input', 'execution identity');
    const tool = this.registry.getTool(request.capabilityId, request.toolId);
    if (!tool.allowedPhases.includes(request.phase)) throw new CapabilityError('invalid_phase');
    const parsed = tool.inputSchema.safeParse(request.input);
    if (!parsed.success) throw new CapabilityError('invalid_input');
    const context = Object.freeze({
      identity: Object.freeze(identity.data),
      phase: request.phase,
      signal: request.signal,
    });
    await assertActive(this.ports, context);
    if (!(await this.ports.reserve('tool', this.options.maxToolCalls ?? 24)))
      throw new CapabilityError('budget');
    const output = tool.outputSchema.safeParse(await tool.handler(parsed.data, context));
    if (!output.success) throw new CapabilityError('invalid_output');
    const model = tool.project(output.data);
    await assertActive(this.ports, context);
    const key = `capability:${context.identity.inputRevision}:${context.identity.generation}:${randomUUID()}:${tool.id}`;
    if (
      !(await this.ports.saveStep(key, tool.id, {
        capabilityId: request.capabilityId,
        toolId: tool.id,
        displayName: tool.description,
        identity: context.identity,
        phase: context.phase,
        completed: true,
      }))
    )
      throw new CapabilityError('fenced');
    return { local: output.data, model };
  }
}
