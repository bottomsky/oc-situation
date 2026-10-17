import { inject, provide, ref, type InjectionKey } from 'vue';

export type ChartDetailKind =
  'intelligence' | 'vessel' | 'evidence' | 'sources' | 'task' | 'history';
export type ChartDetailSide = 'left' | 'right';

export function createChartDetailHost() {
  const active = ref<{ kind: ChartDetailKind; side: ChartDetailSide } | null>(null);
  return {
    active,
    open(kind: ChartDetailKind, side: ChartDetailSide) {
      active.value = { kind, side };
    },
    close(kind?: ChartDetailKind) {
      if (!kind || active.value?.kind === kind) active.value = null;
    },
    isOpen(kind: ChartDetailKind) {
      return active.value?.kind === kind;
    },
  };
}

type ChartDetailHost = ReturnType<typeof createChartDetailHost>;
const chartDetailHostKey: InjectionKey<ChartDetailHost> = Symbol('chart-detail-host');

export function provideChartDetailHost() {
  const host = createChartDetailHost();
  provide(chartDetailHostKey, host);
  return host;
}

/** Standalone pages retain their existing detail presentation when no chart host is present. */
export function useChartDetailHost() {
  return inject(chartDetailHostKey, null);
}
