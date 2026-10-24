import type { AgentFocusResult, AgentTask, FocusTargetRef } from '@ais/contracts';
import type { ReplyObjectViewModel } from '../types/agentReply';

export const replyObjectLabels: Record<FocusTargetRef['kind'], string> = {
  vessel: '船舶',
  track: '航迹',
  route: '航线',
  event: '事件',
  intelligence: '情报',
  region: '区域',
};
export const replyObjectIcons: Record<FocusTargetRef['kind'], string> = {
  vessel: 'Ship',
  track: 'History',
  route: 'Compass',
  event: 'Radio',
  intelligence: 'ClipboardList',
  region: 'Radar',
};

export function replyObjectKey(ref: FocusTargetRef): string {
  return JSON.stringify([ref.kind, ref.id, ref.revision ?? null, ref.sourceTaskId ?? null]);
}

/** Group real task references; missing and omitted objects have different meanings. */
export function buildReplyObjects(focus: AgentFocusResult | null): ReplyObjectViewModel[] {
  const objects = new Map<string, ReplyObjectViewModel>();
  const geometrySignatures = new Map<string, Set<string>>();
  for (const target of focus?.targets ?? []) {
    const key = replyObjectKey(target.ref);
    const signature = JSON.stringify(target.geometry);
    const existing = objects.get(key);
    if (existing) {
      const signatures = geometrySignatures.get(key)!;
      if (!signatures.has(signature)) {
        existing.geometries.push(target.geometry);
        signatures.add(signature);
      }
      continue;
    }
    geometrySignatures.set(key, new Set([signature]));
    objects.set(key, {
      key,
      ref: { ...target.ref },
      label: target.label.trim() || `${replyObjectLabels[target.ref.kind]} ${target.ref.id}`,
      geometries: [target.geometry],
      located: true,
      ...(target.observedAt ? { observedAt: target.observedAt } : {}),
      ...(target.source ? { source: target.source } : {}),
    });
  }
  for (const ref of focus?.missing ?? []) {
    const key = replyObjectKey(ref);
    if (!objects.has(key))
      objects.set(key, {
        key,
        ref: { ...ref },
        label: `${replyObjectLabels[ref.kind]} ${ref.id}`,
        geometries: [],
        located: false,
      });
  }
  return [...objects.values()];
}

export function replyBusinessType(
  intent: AgentTask['intent'],
  objects: ReplyObjectViewModel[],
): string {
  const kinds = new Set(objects.map((object) => object.ref.kind));
  if (kinds.size > 1) return '多对象研判';
  const explicit: Partial<Record<NonNullable<AgentTask['intent']>, string>> = {
    vessel_list: '船舶分析',
    vessel_detail: '船舶分析',
    vessel_highlights: '船舶分析',
    vessel_tracks: '航迹分析',
    intelligence_search: '情报解读',
    ais_heatmap: '热力分析',
    route_plan: '航线研判',
    route_manage: '航线研判',
    event_query: '事件研判',
    event_manage: '事件研判',
  };
  if (intent && explicit[intent]) return explicit[intent]!;
  const byKind: Record<FocusTargetRef['kind'], string> = {
    vessel: '船舶分析',
    track: '航迹分析',
    intelligence: '情报解读',
    route: '航线研判',
    event: '事件研判',
    region: '区域态势',
  };
  const only = [...kinds][0];
  return only ? byKind[only] : '智能分析';
}

export function replyObjectsPage(
  objects: ReplyObjectViewModel[],
  query: string,
  kind: FocusTargetRef['kind'] | 'all',
  requestedPage = 1,
) {
  const needle = query.trim().toLocaleLowerCase();
  const matching = objects.filter(
    (object) =>
      (kind === 'all' || object.ref.kind === kind) &&
      (!needle ||
        object.label.toLocaleLowerCase().includes(needle) ||
        object.ref.id.toLocaleLowerCase().includes(needle)),
  );
  const pages = Math.max(1, Math.ceil(matching.length / 50));
  const page = Math.min(
    pages,
    Math.max(1, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 1),
  );
  return { items: matching.slice((page - 1) * 50, page * 50), total: matching.length, page, pages };
}

interface ReplyTooltipRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
/** Position the teleported name inside the map's visible clipping bounds. */
export function placeReplyObjectTooltip(
  bounds: ReplyTooltipRect,
  anchor: ReplyTooltipRect,
  size: { width: number; height: number },
) {
  const maxWidth = Math.max(0, bounds.right - bounds.left - 24);
  const maxHeight = Math.max(0, bounds.bottom - bounds.top - 24);
  const width = Math.min(size.width, maxWidth),
    height = Math.min(size.height, maxHeight);
  const left = Math.max(bounds.left + 12, Math.min(anchor.left, bounds.right - 12 - width));
  const above = anchor.top - height - 8;
  const preferredTop = above >= bounds.top + 12 ? above : anchor.bottom + 8;
  const top = Math.max(bounds.top + 12, Math.min(preferredTop, bounds.bottom - 12 - height));
  return { left, top, maxWidth, maxHeight };
}
