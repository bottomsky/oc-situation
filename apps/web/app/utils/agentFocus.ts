import {
  AgentFocusResultSchema,
  type AgentFocusResult,
  type FocusTargetSnapshot,
  type FocusTargetRef,
} from '../../../../packages/contracts/agent-focus';
import type {
  AgentTask,
  AgentQueryResult,
  AgentVesselTracksResult,
  AgentIntelligenceResult,
} from '@ais/contracts';
import { focusBounds } from '../../../../packages/domain/agent-focus';
interface FocusTaskData {
  task: Pick<AgentTask, 'id' | 'sessionId' | 'resultVersion' | 'inputRevision'> & {
    selection?: unknown;
  };
  focusResult?: unknown;
  artifacts?: { kind: string; payload: unknown }[];
  queryResult?:
    | (Pick<AgentQueryResult, 'kind' | 'version' | 'inputRevision' | 'items'> &
        Partial<Pick<AgentQueryResult, 'selection' | 'regionGeometry' | 'total' | 'truncated'>>)
    | null;
  tracksResult?: AgentVesselTracksResult | null;
  intelligenceResult?: AgentIntelligenceResult | null;
}
/** Adapt only server results of this task revision; viewport and open details are never targets. */
export function focusFromTask(data: FocusTaskData): AgentFocusResult | null {
  const { task } = data,
    revision = task.inputRevision ?? 0;
  const explicit = [
    data.focusResult,
    ...(data.artifacts ?? []).filter((a) => a.kind === 'map_focus').map((a) => a.payload),
  ];
  for (const value of explicit) {
    const p = AgentFocusResultSchema.safeParse(value);
    if (
      p.success &&
      p.data.taskId === task.id &&
      p.data.sessionId === task.sessionId &&
      p.data.inputRevision === revision &&
      (p.data.targets.length > 0 || p.data.missing.length > 0 || (p.data.omittedCount ?? 0) > 0)
    )
      return p.data;
  }
  const targets: FocusTargetSnapshot[] = [],
    missing: FocusTargetRef[] = [];
  const current = (v: { inputRevision: number; version: number } | null | undefined) =>
    v && v.inputRevision === revision && v.version === task.resultVersion;
  if (current(data.queryResult))
    for (const item of data.queryResult!.items) {
      const ref = { kind: 'vessel' as const, id: item.mmsi };
      if (item.latestPosition)
        targets.push({
          ref,
          label: item.name ?? item.mmsi,
          geometry: {
            type: 'Point',
            coordinates: [item.latestPosition.lon, item.latestPosition.lat],
          },
          observedAt: item.latestPosition.observedAt,
          source: item.latestPosition.sourceId,
        });
      else missing.push(ref);
    }
  if (current(data.tracksResult))
    for (const track of data.tracksResult!.tracks) {
      const lines = track.segments
        .filter((s) => s.points.length > 1)
        .map((s) => s.points.map((p) => [p.lon, p.lat] as [number, number]));
      const ref = {
        kind: 'track' as const,
        id: track.mmsi,
        revision: task.resultVersion,
        sourceTaskId: task.id,
      };
      if (lines.length)
        targets.push({
          ref,
          label: track.name ?? track.mmsi,
          geometry: { type: 'MultiLineString', coordinates: lines },
          observedAt: data.tracksResult!.asOf,
        });
      else missing.push(ref);
    }
  if (current(data.intelligenceResult))
    for (const item of data.intelligenceResult!.evidence) {
      if (item.kind !== 'event') continue;
      const event = item.event;
      const ref = { kind: 'intelligence' as const, id: event.id, revision: event.version };
      if (event.geometry)
        targets.push({
          ref,
          label: event.title,
          geometry: event.geometry,
          observedAt: event.observedAt,
          source: event.sourceId,
        });
      else missing.push(ref);
    }
  const query = data.queryResult;
  if (current(query) && query?.regionGeometry && query.selection?.region)
    targets.unshift({
      ref: { kind: 'region', id: `${task.id}:region`, revision },
      label:
        query.selection.region.kind === 'circle'
          ? `方圆 ${query.selection.region.radiusMeters / 1000} 公里`
          : '查询区域',
      geometry: query.regionGeometry,
      region: query.selection.region,
    });
  const queriedOmittedCount = current(query)
    ? Math.max(0, (query?.total ?? query?.items.length ?? 0) - (query?.items.length ?? 0))
    : 0;
  if (!targets.length && !missing.length) return null;
  const omittedCount = queriedOmittedCount + Math.max(0, targets.length - 100);
  const located = targets.slice(0, 100);
  return {
    kind: 'map_focus',
    version: task.resultVersion,
    inputRevision: revision,
    sessionId: task.sessionId,
    taskId: task.id,
    targets: located,
    missing,
    omittedCount,
    bbox: focusBounds(located.map((t) => t.geometry)),
    displayStatus: located.length
      ? missing.length || omittedCount
        ? 'partial'
        : 'complete'
      : 'unlocated',
    cameraPolicy: 'if-needed-once',
  };
}
