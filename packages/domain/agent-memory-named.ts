import { z } from 'zod';
import type { AgentMessageInput, AgentSelection } from '../contracts/agent';
import { AgentSelectionSchema } from '../contracts/agent';
import { SpatialRegionSchema } from '../contracts/spatial';
import { FocusTargetRefSchema } from '../contracts/agent-focus';
import type { AgentAccountMemoryEntry } from '../contracts/agent-memory';
import { parseCircleSelection } from './agent-focus';
import type { ReferentMemory } from './agent-memory';

const NamedRegion = z.object({ kind: z.literal('named_region'), region: SpatialRegionSchema });
const NamedTargets = z.object({
  kind: z.literal('named_targets'),
  targets: z.array(FocusTargetRefSchema).min(1).max(100000),
});
export const NamedAgentMemorySchema = z.discriminatedUnion('kind', [NamedRegion, NamedTargets]);
export const isNamedMemoryInstruction = (content: string) =>
  /(?:区域|范围|船舶|船队|船只|目标|对象|这批|那批).*(?:叫|名为|命名为)/.test(content);

/** Persist host-owned geometry and identities under a name explicitly chosen by this user. */
export function namedMemoryFromInstruction(
  content: string,
  input: AgentMessageInput,
  memory?: ReferentMemory | null,
) {
  const match = content.match(
    /^(.*?)(?:叫|名为|命名为)\s*[“「"']?([^”」"'，,。；;]{1,100})[”」"']?$/,
  );
  if (!match || !isNamedMemoryInstruction(content)) return null;
  const key = match[2]!.trim();
  if (!key) return null;
  const previous = AgentSelectionSchema.safeParse(memory?.conditions.selection).data;
  if (/区域|范围/.test(match[1]!)) {
    const circle = parseCircleSelection(match[1]!);
    const region =
      circle?.region ??
      input.mapContext?.region ??
      (input.bbox ? { kind: 'bbox' as const, bbox: input.bbox } : undefined) ??
      (/这个|刚才|上述|上次|选中/.test(content)
        ? (previous?.region ??
          (previous?.bbox ? { kind: 'bbox' as const, bbox: previous.bbox } : undefined))
        : undefined) ??
      (input.mapContext?.bbox ? { kind: 'bbox' as const, bbox: input.mapContext.bbox } : undefined);
    const parsed = NamedRegion.safeParse({ kind: 'named_region', region });
    return parsed.success ? { category: 'named_region', key, value: parsed.data } : null;
  }
  const explicit = [...content.matchAll(/(?<!\d)([1-9]\d{8})(?!\d)/g)].map((match) => match[1]!);
  const selected = input.mapContext?.selectedTargets?.length
    ? input.mapContext.selectedTargets
    : input.mapContext?.selectedMmsis?.map((id) => ({ kind: 'vessel' as const, id }));
  const latest = Math.max(-1, ...(memory?.objectSets ?? []).map((set) => set.turnSeq));
  const sets = memory?.objectSets.filter((set) => set.turnSeq === latest) ?? [];
  const targets = explicit.length
    ? explicit.map((id) => ({ kind: 'vessel' as const, id }))
    : selected?.length
      ? selected
      : sets.length === 1
        ? (sets[0]!.targets ??
          sets[0]!.members.flatMap((member) =>
            member.kind === 'vessel' ? [{ kind: 'vessel' as const, id: member.mmsi }] : [],
          ))
        : [];
  const parsed = NamedTargets.safeParse({ kind: 'named_targets', targets });
  return parsed.success ? { category: 'named_targets', key, value: parsed.data } : null;
}

/** Account object recall requires a literal explicit name, never a bare deictic action. */
export function resolveNamedMemory(
  goal: string,
  selection: AgentSelection,
  entries: AgentAccountMemoryEntry[],
) {
  const named = entries
    .filter(
      (entry) => entry.status === 'active' && entry.key.length > 0 && goal.includes(entry.key),
    )
    .flatMap((entry) => {
      const parsed = NamedAgentMemorySchema.safeParse(entry.value);
      return parsed.success ? [{ entry, value: parsed.data }] : [];
    });
  if (!named.length) return { selection, ambiguous: false, matched: false, tooMany: false };
  if (named.length > 1) return { selection, ambiguous: true, matched: true, tooMany: false };
  const value = named[0]!.value;
  if (value.kind === 'named_region')
    return {
      selection: {
        ...selection,
        region: value.region,
        bbox: value.region.kind === 'bbox' ? value.region.bbox : undefined,
        vesselCircle: undefined,
      },
      ambiguous: false,
      matched: true,
      tooMany: false,
    };
  if (/(?<!\d)[1-9]\d{8}(?!\d)/.test(goal))
    return { selection, ambiguous: false, matched: false, tooMany: false };
  if (value.targets.length > 100)
    return { selection, ambiguous: false, matched: true, tooMany: true };
  const mmsis = value.targets.filter((ref) => ref.kind === 'vessel').map((ref) => ref.id);
  return {
    selection: {
      ...selection,
      focusTargets: value.targets,
      ...(mmsis.length ? { mmsis, vesselSelector: { mmsis } } : {}),
    },
    ambiguous: false,
    matched: true,
    tooMany: false,
  };
}
