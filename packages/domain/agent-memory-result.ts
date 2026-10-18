import type { AgentTask, AgentQueryResult } from '../contracts/agent';
import type { AgentMemoryObjectSet, AgentMemoryReference } from '../contracts/agent-memory';
import type { FocusTargetRef } from '../contracts/agent-focus';
import type { AgentFocusResult } from '../contracts/agent-focus';
import type { AgentVesselTracksResult } from '../contracts/vessel-tracks';
import type { AgentIntelligenceResult } from '../contracts/intelligence-search';

interface MemoryResultContext {
  task: AgentTask;
  steps: { key: string; output: unknown }[];
  queryResult?: AgentQueryResult | null;
  tracksResult?: AgentVesselTracksResult | null;
  intelligenceResult?: AgentIntelligenceResult | null;
  results?: { mmsi: string }[];
  focusResult?: AgentFocusResult | null;
  artifacts?: { kind: string; payload: unknown }[];
}
const object = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Identity is extracted locally from persisted host results; model prose is never an authority. */
export function memoryObjectsFromTask(
  context: MemoryResultContext,
  turnSeq: number,
  uiSucceeded: boolean,
) {
  const objectSets: AgentMemoryObjectSet[] = [];
  const references: AgentMemoryReference[] = [];
  const { task } = context;
  if (
    task.selection?.highlightClear ||
    task.selection?.highlightTaskIndex ||
    task.selection?.highlightClearUnclear
  )
    return { objectSets, references };
  const addSet = (label: string, refs: FocusTargetRef[], suffix: string, vesselSet = false) => {
    const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
    objectSets.push({
      id: `${task.id}:${task.inputRevision ?? 0}:${suffix}`,
      label,
      kind: vesselSet ? 'vessels' : 'references',
      turnSeq,
      members: unique.map((ref) =>
        ref.kind === 'vessel' || ref.kind === 'track'
          ? { kind: 'vessel' as const, mmsi: ref.id }
          : { kind: 'reference' as const, refType: ref.kind, refId: ref.id },
      ),
      targets: unique,
      source: { taskId: task.id },
      querySucceeded: true,
      uiSucceeded,
    });
  };
  const snapshot = context.steps.findLast((step) => step.key === 'map_vessel_snapshot')?.output as
    AgentQueryResult | undefined;
  const query =
    snapshot?.inputRevision === (task.inputRevision ?? 0) ? snapshot : context.queryResult;
  if (query) {
    references.push({
      refType: 'query_result',
      refId: `${task.id}:${query.version}`,
      label:
        query.truncated || query.total !== query.items.length
          ? `展示${query.items.length}项／匹配${query.total}项，集合未完整保存`
          : `完整查询集合${query.total}项`,
    });
    if (!query.truncated && query.total === query.items.length)
      addSet(
        '最近查询的船舶集合',
        query.items.map((item) => ({ kind: 'vessel', id: item.mmsi })),
        'vessels',
        true,
      );
  } else if (context.tracksResult && !context.tracksResult.hasMoreVessels) {
    addSet(
      '最近查询的轨迹船舶',
      context.tracksResult.tracks.map((track) => ({
        kind: 'track',
        id: track.mmsi,
        sourceTaskId: task.id,
        revision: context.tracksResult!.version,
      })),
      'tracks',
      true,
    );
  } else if (task.intent === 'analysis' && task.resultVersion > 0 && context.results) {
    // Evidence matches describe the exact returned analysis set, independent of display limits.
    addSet(
      '最近分析命中的船舶',
      context.results.map((result) => ({ kind: 'vessel', id: result.mmsi })),
      'analysis',
      true,
    );
  }
  const result = context.intelligenceResult;
  if (result) {
    references.push({
      refType: 'intelligence_result',
      refId: `${task.id}:${result.version}`,
      label: result.truncated ? '情报展示集合' : '完整情报集合',
    });
    if (!result.truncated)
      addSet(
        '最近检索的情报',
        result.evidence.flatMap((item) =>
          item.kind === 'event' ? [{ kind: 'intelligence' as const, id: item.event.id }] : [],
        ),
        'intelligence',
      );
  }
  const payloads = [
    ...context.steps.map((step) => object(step.output)?.payload),
    ...(context.artifacts ?? []).map((artifact) => artifact.payload),
  ];
  const business: FocusTargetRef[] = [];
  for (const value of payloads) {
    const payload = object(value);
    if (!payload) continue;
    const kind = payload.kind;
    if (!['route', 'route_plan', 'operational_event', 'operational_events'].includes(String(kind)))
      continue;
    const candidates = [
      payload.route,
      payload.plan,
      payload.event,
      ...(Array.isArray(payload.routes) ? payload.routes : []),
      ...(Array.isArray(payload.items) ? payload.items : []),
    ];
    for (const item of candidates) {
      const row = object(item);
      if (typeof row?.id !== 'string') continue;
      business.push({
        kind: String(kind).startsWith('operational_event') ? 'event' : 'route',
        id: row.id,
        ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
      });
    }
  }
  if (business.length) addSet('最近业务对象', business, 'business');
  if (!objectSets.length && !query && !result) {
    const focused =
      object(context.focusResult) ??
      payloads.map(object).findLast((payload) => payload?.kind === 'map_focus');
    if (Array.isArray(focused?.targets)) {
      const targets = [
        ...focused.targets,
        ...(Array.isArray(focused.missing) ? focused.missing.map((ref) => ({ ref })) : []),
      ].flatMap((target) => {
        const ref = object(object(target)?.ref);
        return ref && typeof ref.id === 'string' && typeof ref.kind === 'string'
          ? [ref as FocusTargetRef]
          : [];
      });
      if (targets.length)
        addSet(
          '最近关注的对象',
          targets,
          'focus',
          targets.every((ref) => ref.kind === 'vessel'),
        );
    }
  }
  // The same object may be represented by both a step and an artifact; deduplicate by identity.
  return { objectSets, references };
}
