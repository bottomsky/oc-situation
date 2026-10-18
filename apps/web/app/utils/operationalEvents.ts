import type { OperationalEventFields } from '@ais/contracts';
export const eventStatusLabels = {
  active: '处理中',
  resolved: '已处置',
  archived: '已归档',
  merged: '已合并',
};
export const eventSeverityLabels = {
  unknown: '待定',
  low: '低',
  medium: '中',
  high: '高',
  critical: '紧急',
};
export function eventChartHref(id: string) {
  return `/?operationalEventId=${encodeURIComponent(id)}&askEvent=1`;
}
export function eventPatch<T extends Record<string, unknown>>(
  original: T,
  draft: T,
  releases: string[],
) {
  return Object.fromEntries(
    Object.entries(draft).filter(
      ([key, value]) =>
        !releases.includes(key) && JSON.stringify(value) !== JSON.stringify(original[key]),
    ),
  );
}
export function emptyEvent(): OperationalEventFields {
  return {
    title: '',
    summary: '',
    category: 'other',
    severity: 'unknown',
    occurredAt: null,
    geometry: null,
    linkedMmsis: [],
    linkedRouteIds: [],
  };
}
export function createHandoffGeneration() {
  let generation = 0;
  return {
    begin() {
      const turn = ++generation;
      return () => turn === generation;
    },
    invalidate() {
      ++generation;
    },
  };
}
