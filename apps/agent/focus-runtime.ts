import { randomUUID } from 'node:crypto';
import {
  AgentFocusResultSchema,
  type AgentFocusResult,
  type FocusTargetRef,
  type FocusTargetSnapshot,
  FOCUS_TARGET_LIMIT,
} from '../../packages/contracts/agent-focus';
import { focusBounds } from '../../packages/domain/agent-focus';
import { UiStateSchema } from '../../packages/contracts/agent-ui';
import type { RuntimeContext, RuntimePorts, RuntimeOptions } from './runtime';

/** Geometry enters exclusively through current host snapshots or persisted object resolution. */
export async function focusFromContext(
  context: RuntimeContext,
  ports: RuntimePorts,
): Promise<AgentFocusResult> {
  const revision = context.task.inputRevision ?? 0;
  let query = context.queryResult?.inputRevision === revision ? context.queryResult : undefined;
  if (
    !query &&
    context.task.intent === 'map_focus' &&
    !context.task.selection?.focusTargets?.length &&
    (context.task.selection?.mmsis?.length || context.task.selection?.vesselSelector) &&
    ports.queryVessels
  ) {
    query = await ports.queryVessels('vessel_detail', {
      ...context.task.selection,
      bbox: undefined,
    });
    context.queryResult = query;
  }
  const tracks =
    context.tracksResult?.inputRevision === revision ||
    context.tracksResult?.inputRevision === undefined
      ? context.tracksResult
      : undefined;
  const refs: FocusTargetRef[] = context.task.selection?.focusTargets?.length
    ? context.task.selection.focusTargets
    : [
        ...(tracks?.tracks.map((t) => ({ kind: 'track' as const, id: t.mmsi })) ?? []),
        ...(query?.items.map((v) => ({ kind: 'vessel' as const, id: v.mmsi })) ?? []),
        ...(context.intelligenceResult?.inputRevision === revision
          ? context.intelligenceResult.evidence
              .filter((e) => e.kind === 'event')
              .map((e) => ({ kind: 'intelligence' as const, id: e.event.id }))
          : []),
        ...(context.results?.map((r) => ({ kind: 'vessel' as const, id: r.mmsi })) ?? []),
        ...(context.task.selection?.region ? [{ kind: 'region' as const, id: 'task-region' }] : []),
      ];
  const unique = [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
  const targets: FocusTargetSnapshot[] = [],
    missing: FocusTargetRef[] = [];
  for (const ref of unique.slice(0, FOCUS_TARGET_LIMIT)) {
    let snapshot: FocusTargetSnapshot | null = null;
    if (ref.kind === 'vessel') {
      const vessel = query?.items.find((v) => v.mmsi === ref.id);
      const p = vessel?.latestPosition;
      if (p)
        snapshot = {
          ref,
          label: vessel.name ?? ref.id,
          geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          observedAt: p.observedAt,
          source: p.sourceId ?? 'vessel-query',
        };
      else if (vessel) {
        missing.push(ref);
        continue;
      } else {
        const analysis = context.results?.find((r) => r.mmsi === ref.id);
        if (analysis?.evidence.ais.length)
          snapshot = {
            ref,
            label: analysis.title,
            geometry: {
              type: 'MultiPoint',
              coordinates: analysis.evidence.ais.map((a) => [a.longitude, a.latitude]),
            },
            observedAt: analysis.evidence.queriedAt,
            source: 'analysis-ais-evidence',
          };
      }
    }
    if (ref.kind === 'track') {
      const track =
        (!ref.sourceTaskId ||
          (ref.sourceTaskId === context.task.id && ref.revision !== undefined)) &&
        (ref.revision === undefined || ref.revision === tracks?.version)
          ? tracks?.tracks.find((t) => t.mmsi === ref.id)
          : undefined;
      if (track?.segments.length) {
        const lines = track.segments
          .filter((s) => s.points.length >= 2)
          .map((s) => s.points.map((p): [number, number] => [p.lon, p.lat]));
        const singles = track.segments
          .filter((s) => s.points.length === 1)
          .map((s): [number, number] => [s.points[0]!.lon, s.points[0]!.lat]);
        if (lines.length)
          snapshot = {
            ref,
            label: track.name ?? ref.id,
            geometry: {
              type: 'MultiLineString',
              coordinates: [...lines, ...singles.map((p) => [p, p])],
            },
            source: 'vessel-tracks',
          };
        else if (singles.length)
          snapshot = {
            ref,
            label: track.name ?? ref.id,
            geometry: { type: 'MultiPoint', coordinates: singles },
            source: 'vessel-tracks',
          };
      }
    }
    const resolved = snapshot ?? (await ports.resolveFocus?.(ref, context)) ?? null;
    if (Array.isArray(resolved)) targets.push(...resolved);
    else if (resolved) targets.push(resolved);
    else missing.push(ref);
  }
  const inferredTargets = !context.task.selection?.focusTargets?.length;
  const sourceOmittedCount = inferredTargets
    ? Math.max(0, (query?.total ?? 0) - (query?.items.length ?? 0)) +
      (tracks?.hasMoreVessels
        ? Math.max(1, tracks.matchedVesselsLowerBound - tracks.tracks.length)
        : 0)
    : 0;
  const omittedCount =
    Math.max(0, unique.length - FOCUS_TARGET_LIMIT) +
    Math.max(0, targets.length - FOCUS_TARGET_LIMIT) +
    (context.focusOmittedCount ?? 0) +
    sourceOmittedCount;
  const displayed = targets.slice(0, FOCUS_TARGET_LIMIT);
  return AgentFocusResultSchema.parse({
    kind: 'map_focus',
    version: 0,
    inputRevision: revision,
    sessionId: context.task.sessionId,
    taskId: context.task.id,
    targets: displayed,
    missing,
    ...(omittedCount ? { omittedCount } : {}),
    bbox: focusBounds(displayed.map((t) => t.geometry)),
    displayStatus: displayed.length
      ? missing.length || omittedCount
        ? 'partial'
        : 'complete'
      : 'unlocated',
    cameraPolicy: 'if-needed-once',
  });
}

export async function prepareTaskFocus(
  context: RuntimeContext,
  ports: RuntimePorts,
): Promise<AgentFocusResult | undefined> {
  if (!ports.resolveFocus && !ports.saveFocus) return;
  const result = await focusFromContext(context, ports);
  await ports.saveFocus?.(result);
  return result;
}

export function focusSummary(payload: AgentFocusResult, status = payload.displayStatus): string {
  const located = new Set(payload.targets.map((target) => `${target.ref.kind}:${target.ref.id}`))
    .size;
  const missing = new Set(payload.missing.map((ref) => `${ref.kind}:${ref.id}`)).size;
  const omitted = payload.omittedCount ? `另有 ${payload.omittedCount} 项超出本次呈现范围。` : '';
  return status === 'unlocated'
    ? `本轮 ${located + missing} 个对象未能在海图呈现，已保留未定位结果。${omitted}`
    : status === 'partial'
      ? `已处理 ${located + missing} 个关注对象，当前呈现部分位置。${missing ? `${missing} 个对象缺少位置。` : '部分空间要素尚未完整呈现。'}${omitted}`
      : `已关注 ${located} 个有位置对象。`;
}

export async function executeFocusSkill(
  context: RuntimeContext,
  ports: RuntimePorts,
  _options: RuntimeOptions,
) {
  try {
    const existing = context.steps.find((s) => s.key === 'map_map_focus')?.output as
      { artifactRef: string; payload: AgentFocusResult } | undefined;
    const saved = existing ?? {
      artifactRef: randomUUID(),
      payload: await focusFromContext(context, ports),
    };
    const payload = saved.payload;
    if (!payload.targets.length && !payload.missing.length)
      throw new Error('请提供对象 ID、船名、MMSI，或在海图中选中需要关注的对象或区域。');
    if (!(await ports.saveStep('map_map_focus', 'map-focus', saved))) return;
    await ports.saveFocus?.(payload);
    if (context.task.uiBinding && ports.mapUi) {
      const command = await ports.mapUi.command('map_map_focus');
      if (command?.status === 'succeeded') {
        const receiptStatus = UiStateSchema.safeParse(command.result).data?.components.find(
          (component) => component.id === 'chart.focus',
        )?.focusEvidence?.displayStatus;
        await ports.finish({
          status: 'completed',
          summary: focusSummary(payload, receiptStatus ?? payload.displayStatus),
        });
        return;
      }
      if (command && !['queued', 'claimed', 'executing'].includes(command.status))
        throw new Error(`ui_${command.status}`);
      if (!command)
        await ports.mapUi.queue('map_map_focus', saved.artifactRef, {
          componentId: 'chart.focus',
          action: 'show',
        });
      return;
    }
    await ports.finish({
      status: 'completed',
      summary: focusSummary(payload),
    });
  } catch (error) {
    await ports.finish({
      status: 'failed',
      errorCode: 'focus_failed',
      error: error instanceof Error ? error.message : '关注对象解析失败',
    });
  }
}
