import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import type {
  SkillBinding,
  SkillCapabilityMetadata,
} from '../../../packages/contracts/agent-capabilities';
import { CapabilityError } from './errors';

declare const __AGENT_SKILLS_BUNDLED__: boolean;

export interface SkillToolBinding {
  readonly skillId: string;
  readonly version: string;
  readonly adapterVersion: string;
  readonly toolIds: readonly string[];
  readonly referencePaths: readonly string[];
}
export interface LoadedSkill {
  readonly metadata: Readonly<SkillCapabilityMetadata>;
  readonly binding: Readonly<SkillBinding>;
  readonly body: string;
  readonly references: Readonly<Record<string, string>>;
}
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const metadataSchema = z.strictObject({
  name: nameSchema,
  description: z.string().trim().min(1).max(1024),
  license: z.string().optional(),
  compatibility: z.string().min(1).max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
});
const referencePattern = /^references\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/;

export function defaultSkillRoot(): string {
  return fileURLToPath(
    new URL(
      typeof __AGENT_SKILLS_BUNDLED__ !== 'undefined' && __AGENT_SKILLS_BUNDLED__
        ? './skills/'
        : '../skills/',
      import.meta.url,
    ),
  );
}

function invalid(detail: string): never {
  throw new CapabilityError('configuration', detail);
}
async function within(root: string, path: string): Promise<string> {
  const actual = await realpath(path);
  const offset = relative(root, actual);
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset))
    invalid('skill path boundary');
  return actual;
}
async function readBounded(root: string, path: string, maximum: number): Promise<string> {
  const actual = await within(root, path);
  const info = await stat(actual);
  if (!info.isFile() || info.size > maximum) invalid('skill file size or type');
  const bytes = await readFile(actual);
  if (bytes.byteLength > maximum) invalid('skill file size');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid('skill invalid UTF-8');
  }
}

export class SkillCatalog {
  readonly #skills: ReadonlyMap<string, LoadedSkill>;
  constructor(skills: readonly LoadedSkill[]) {
    this.#skills = new Map(skills.map((skill) => [skill.metadata.skillId, skill]));
    Object.freeze(this);
  }
  list(): readonly Readonly<SkillCapabilityMetadata>[] {
    return Object.freeze([...this.#skills.values()].map((skill) => skill.metadata));
  }
  get(skillId: string): LoadedSkill {
    const skill = this.#skills.get(skillId);
    if (!skill) invalid('unknown skill');
    return skill;
  }
  assertBinding(binding: SkillBinding): LoadedSkill {
    const skill = this.#skills.get(binding.skillId);
    if (
      !skill ||
      skill.binding.version !== binding.version ||
      skill.binding.adapterVersion !== binding.adapterVersion ||
      skill.binding.contentHash !== binding.contentHash
    ) {
      throw new CapabilityError('skill_changed');
    }
    return skill;
  }
}

/** Only the host supplies root/bindings; model arguments never become filesystem paths. */
export async function loadSkillCatalog(options: {
  root?: string;
  bindings: readonly SkillToolBinding[];
  maxFileBytes?: number;
  maxTotalBytes?: number;
}): Promise<SkillCatalog> {
  const root = await realpath(options.root ?? defaultSkillRoot());
  const maximum = options.maxFileBytes ?? 64 * 1024;
  const totalMaximum = options.maxTotalBytes ?? 512 * 1024;
  const bindings = new Map<string, SkillToolBinding>();
  for (const binding of options.bindings) {
    if (
      !nameSchema.safeParse(binding.skillId).success ||
      !binding.version ||
      !binding.adapterVersion
    )
      invalid('invalid skill binding');
    if (bindings.has(binding.skillId)) invalid('duplicate skill binding');
    if (
      new Set(binding.toolIds).size !== binding.toolIds.length ||
      !binding.toolIds.length ||
      binding.toolIds.some((id) => !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)?$/.test(id))
    )
      invalid('invalid tool binding');
    if (
      new Set(binding.referencePaths).size !== binding.referencePaths.length ||
      binding.referencePaths.some((path) => !referencePattern.test(path))
    )
      invalid('invalid reference whitelist');
    bindings.set(binding.skillId, binding);
  }
  const skills: LoadedSkill[] = [];
  const names = new Set<string>();
  let totalBytes = 0;
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const directory = await within(root, join(root, entry.name));
    if (!(await stat(directory)).isDirectory()) invalid('unsupported skill root entry');
    const binding = bindings.get(entry.name);
    if (!binding) invalid('unbound skill directory');
    const content = await readBounded(directory, join(directory, 'SKILL.md'), maximum);
    const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
    if (!frontmatter) invalid('invalid skill frontmatter');
    const document = parseDocument(frontmatter[1]!, { uniqueKeys: true });
    if (document.errors.length) invalid('invalid YAML frontmatter');
    let raw: unknown;
    try {
      raw = document.toJS({ maxAliasCount: 20 });
    } catch {
      return invalid('invalid YAML aliases');
    }
    const metadata = metadataSchema.safeParse(raw);
    if (!metadata.success) invalid('invalid skill metadata');
    if (metadata.data.name !== entry.name) invalid('skill directory name mismatch');
    if (names.has(metadata.data.name)) invalid('duplicate skill name');
    names.add(metadata.data.name);
    const declaredTools = metadata.data['allowed-tools']?.trim().split(/\s+/).filter(Boolean) ?? [
      ...binding.toolIds,
    ];
    if (
      !declaredTools.length ||
      new Set(declaredTools).size !== declaredTools.length ||
      declaredTools.some((tool) => !binding.toolIds.includes(tool))
    )
      invalid('skill tool binding mismatch');
    if (!frontmatter[2]?.trim()) invalid('invalid empty skill body');
    const references: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const actual = await within(directory, join(directory, child.name));
      if (child.name === 'SKILL.md') continue;
      if (child.name !== 'references' || !(await stat(actual)).isDirectory())
        invalid('unsupported skill file');
      for (const reference of await readdir(actual)) {
        const path = `references/${reference}`;
        if (!referencePattern.test(path) || !binding.referencePaths.includes(path))
          invalid('unapproved reference');
        references[path] = await readBounded(directory, join(actual, reference), maximum);
      }
    }
    for (const path of binding.referencePaths)
      if (!Object.hasOwn(references, path)) invalid('missing reference');
    totalBytes +=
      Buffer.byteLength(content) +
      Object.values(references).reduce((sum, value) => sum + Buffer.byteLength(value), 0);
    if (totalBytes > totalMaximum) invalid('skill total size');
    const contentHash = createHash('sha256')
      .update(
        JSON.stringify({
          content,
          references: Object.entries(references).sort(([a], [b]) => a.localeCompare(b)),
          adapterVersion: binding.adapterVersion,
          version: binding.version,
          toolIds: [...binding.toolIds].sort(),
        }),
      )
      .digest('hex');
    skills.push(
      Object.freeze({
        metadata: Object.freeze({
          skillId: binding.skillId,
          version: binding.version,
          description: metadata.data.description,
          toolIds: Object.freeze([...declaredTools]) as unknown as string[],
        }),
        binding: Object.freeze({
          skillId: binding.skillId,
          version: binding.version,
          contentHash,
          adapterVersion: binding.adapterVersion,
        }),
        body: frontmatter[2],
        references: Object.freeze(references),
      }),
    );
  }
  if (skills.length !== bindings.size) invalid('missing bound skill directory');
  return new SkillCatalog(skills);
}
