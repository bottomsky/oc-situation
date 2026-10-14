import { z } from 'zod';
import {
  SkillBindingSchema,
  ToolExecutionIdentitySchema,
  type SkillBinding,
  type ToolExecutionIdentity,
} from '../../../packages/contracts/agent-capabilities';
import type { SkillCatalog } from './catalog';
import { assertActive, type CapabilityPorts, type ToolExecutionContext } from './executor';
import { CapabilityError } from './errors';

export interface SkillSessionOptions {
  identity: ToolExecutionIdentity;
  steps: readonly { key: string; output: unknown }[];
  maxToolCalls?: number;
  signal?: AbortSignal;
}
const receiptSchema = z.strictObject({
  kind: z.enum(['skill_activation', 'skill_reference']),
  binding: SkillBindingSchema,
  identity: ToolExecutionIdentitySchema,
  referencePath: z.string().optional(),
});

/** A session is scoped to one host task/revision. Steps are persisted by fenced host ports. */
export class SkillSession {
  readonly #context: ToolExecutionContext;
  readonly #steps = new Map<string, unknown>();
  readonly #pending = new Map<string, Promise<void>>();
  readonly #activated = new Set<string>();
  constructor(
    readonly catalog: SkillCatalog,
    readonly ports: CapabilityPorts,
    readonly options: SkillSessionOptions,
  ) {
    const identity = ToolExecutionIdentitySchema.safeParse(options.identity);
    if (!identity.success) throw new CapabilityError('invalid_input', 'execution identity');
    this.#context = Object.freeze({
      identity: Object.freeze(identity.data),
      signal: options.signal,
      phase: 'skill',
    });
    for (const step of options.steps) this.#steps.set(step.key, step.output);
  }
  get binding(): SkillBinding | undefined {
    const id = this.#activated.values().next().value as string | undefined;
    return id ? this.catalog.get(id).binding : undefined;
  }
  async activate(skillId: string): Promise<{ binding: Readonly<SkillBinding>; body: string }> {
    const skill = this.catalog.get(skillId);
    await this.#record('skill_activation', skill.binding);
    this.#activated.add(skillId);
    return Object.freeze({ binding: skill.binding, body: skill.body });
  }
  async readReference(skillId: string, referencePath: string): Promise<string> {
    if (!this.#activated.has(skillId)) throw new CapabilityError('skill_not_active');
    const skill = this.catalog.get(skillId);
    if (!Object.hasOwn(skill.references, referencePath))
      throw new CapabilityError('invalid_input', 'unapproved reference');
    await this.#record('skill_reference', skill.binding, referencePath);
    return skill.references[referencePath]!;
  }
  async #record(
    kind: 'skill_activation' | 'skill_reference',
    binding: Readonly<SkillBinding>,
    referencePath?: string,
  ): Promise<void> {
    const key = `skill:${this.#context.identity.inputRevision}:${binding.skillId}:${kind === 'skill_activation' ? 'activate' : referencePath}`;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const action = this.#recordOnce(key, kind, binding, referencePath);
    this.#pending.set(key, action);
    try {
      await action;
    } finally {
      this.#pending.delete(key);
    }
  }
  async #recordOnce(
    key: string,
    kind: 'skill_activation' | 'skill_reference',
    binding: Readonly<SkillBinding>,
    referencePath?: string,
  ): Promise<void> {
    const previous = this.#steps.get(key);
    if (previous !== undefined) {
      const receipt = receiptSchema.safeParse(previous);
      if (
        !receipt.success ||
        receipt.data.kind !== kind ||
        receipt.data.referencePath !== referencePath ||
        receipt.data.identity.ownerId !== this.#context.identity.ownerId ||
        receipt.data.identity.taskId !== this.#context.identity.taskId ||
        receipt.data.identity.inputRevision !== this.#context.identity.inputRevision ||
        receipt.data.binding.skillId !== binding.skillId
      )
        throw new CapabilityError('configuration', 'invalid skill receipt');
      this.catalog.assertBinding(receipt.data.binding);
      await assertActive(this.ports, this.#context);
      return;
    }
    await assertActive(this.ports, this.#context);
    if (!(await this.ports.reserve('tool', this.options.maxToolCalls ?? 24)))
      throw new CapabilityError('budget');
    const receipt = {
      kind,
      binding,
      identity: this.#context.identity,
      ...(referencePath ? { referencePath } : {}),
    };
    await assertActive(this.ports, this.#context);
    if (
      !(await this.ports.saveStep(
        key,
        kind === 'skill_activation' ? '激活可信技能' : '读取技能参考',
        receipt,
      ))
    )
      throw new CapabilityError('fenced');
    this.#steps.set(key, receipt);
  }
}
