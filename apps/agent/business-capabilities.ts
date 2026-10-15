import {
  CapabilityExecutor,
  CapabilityRegistry,
  SkillSession,
  loadBuiltinSkillCatalog,
  getBuiltinCapabilityMetadata,
  type RegisteredTool,
  type SkillCatalog,
} from './capabilities';
import type { RuntimeContext, RuntimeOptions, RuntimePorts } from './runtime';

let builtinCatalog: Promise<SkillCatalog> | undefined;
/** One immutable, validated snapshot per worker process. */
export function getBusinessSkillCatalog(): Promise<SkillCatalog> {
  return (builtinCatalog ??= loadBuiltinSkillCatalog());
}

export async function validateRestoredSkill(
  skillId: string,
  context: RuntimeContext,
  ports: RuntimePorts,
  options: RuntimeOptions,
): Promise<void> {
  // Existing receipts validate without charging again; a retry binds the current snapshot.
  await bindBusinessCapability(skillId, context, ports, options);
}

export async function bindBusinessCapability(
  skillId: string,
  context: RuntimeContext,
  ports: RuntimePorts,
  options: RuntimeOptions,
) {
  const catalog = options.skillCatalog ?? (await getBusinessSkillCatalog());
  const identity = {
    ownerId: context.task.ownerId,
    taskId: context.task.id,
    inputRevision: context.task.inputRevision ?? 0,
    generation: context.task.generation,
  };
  const adapted = {
    active: () => ports.active(),
    reserve: (kind: 'tool', maximum: number) => ports.reserve(kind, maximum),
    saveStep: ports.saveStep.bind(ports),
  };
  const session = new SkillSession(catalog, adapted, {
    identity,
    steps: context.steps,
    maxToolCalls: options.maxToolCalls,
    signal: options.signal,
  });
  const activated = await session.activate(skillId);
  const metadata = catalog.get(skillId).metadata;
  return {
    ...activated,
    session,
    allowedTools: metadata.toolIds,
    executor(tools: readonly RegisteredTool[]) {
      const registry = new CapabilityRegistry([
        {
          id: skillId,
          ...getBuiltinCapabilityMetadata(skillId),
          skillId,
          description: metadata.description,
          tools: tools.filter((tool) => metadata.toolIds.includes(tool.id)),
        },
      ]);
      const executor = new CapabilityExecutor(registry, adapted, {
        maxToolCalls: options.maxToolCalls,
      });
      return (toolId: string, phase: string, input: unknown) =>
        executor.execute({
          capabilityId: skillId,
          toolId,
          phase,
          identity,
          input,
          signal: options.signal,
        });
    },
  };
}
