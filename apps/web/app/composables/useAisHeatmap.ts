import { onScopeDispose, ref, watch } from 'vue';
import { HeatmapResultSchema, validateHeatmapQueryWindow } from '@ais/contracts';
import type { AgentHeatmapResult, HeatmapQuery, HeatmapResult } from '@ais/contracts';

export function useAisHeatmap() {
  const { api, session } = usePlatform();
  const result = ref<HeatmapResult | null>(null);
  const lastSnapshot = ref<HeatmapResult | null>(null);
  const closeRevision = ref(0);
  const lockedQuery = ref<HeatmapQuery | null>(null);
  const loading = ref(false);
  const error = ref('');
  const displayed = ref(false);
  const mode = ref<'current' | 'historical'>('current');
  const currentEnabled = ref(false);
  let generation = 0;
  let controller: AbortController | undefined;
  const seen = new Set<string>();
  function invalidate() {
    controller?.abort();
    loading.value = false;
    return ++generation;
  }
  function close() {
    closeRevision.value++;
    invalidate();
    result.value = null;
    lockedQuery.value = null;
    displayed.value = false;
    error.value = '';
    currentEnabled.value = false;
  }
  function selectMode(value: 'current' | 'historical') {
    invalidate();
    mode.value = value;
    currentEnabled.value = false;
    displayed.value = false;
    error.value = '';
  }
  function showCurrent() {
    selectMode('current');
    currentEnabled.value = true;
  }
  function apply(value: unknown) {
    const parsed = HeatmapResultSchema.safeParse(value);
    if (!parsed.success) {
      error.value = '热图结果超出展示上限或范围数据无效，请缩小范围后重试。';
      return false;
    }
    result.value = parsed.data;
    mode.value = 'historical';
    currentEnabled.value = false;
    lastSnapshot.value = parsed.data;
    lockedQuery.value = parsed.data.query;
    displayed.value = false;
    error.value = '';
    return true;
  }
  async function generate(input: HeatmapQuery, now = new Date()) {
    mode.value = 'historical';
    currentEnabled.value = false;
    const turn = invalidate();
    error.value = '';
    const snapshot = JSON.parse(JSON.stringify(input)) as HeatmapQuery;
    try {
      validateHeatmapQueryWindow(snapshot, now);
    } catch {
      error.value = '请选择最近 30 天内的有效时间范围，单次最长 7 天，结束时间不能晚于现在。';
      return;
    }
    lockedQuery.value = snapshot;
    loading.value = true;
    controller = new AbortController();
    const params = new URLSearchParams({
      bbox: snapshot.bbox.join(','),
      from: snapshot.from,
      to: snapshot.to,
    });
    if (snapshot.sourceId) params.set('sourceId', snapshot.sourceId);
    if (snapshot.shipType !== undefined) params.set('shipType', String(snapshot.shipType));
    if (snapshot.mmsis?.length) params.set('mmsis', snapshot.mmsis.join(','));
    try {
      const value = await api<HeatmapResult>(`/map/heatmap?${params}`, {
        signal: controller.signal,
        timeoutMs: 30000,
      });
      if (turn === generation) apply(value);
    } catch (e) {
      if (turn === generation)
        error.value =
          (e as { status?: number }).status === 413
            ? '数据超过热图计算上限，请缩小区域、时间或船舶范围后重试。'
            : (e as Error).message;
    } finally {
      if (turn === generation) loading.value = false;
    }
  }
  function beginAgent() {
    return invalidate();
  }
  function acceptAgent(value: AgentHeatmapResult, scope: string, token: number) {
    const key = `${session.value?.user.id}:${scope}:${value.inputRevision}:${value.version}`;
    if (token !== generation || seen.has(key)) return false;
    const { kind: _kind, version: _version, inputRevision: _revision, ...snapshot } = value;
    if (!apply(snapshot)) return false;
    seen.add(key);
    return true;
  }
  function showSnapshot(value: HeatmapResult) {
    invalidate();
    const { query, grid, cells, totalVessels, generatedAt, metric, shipTypeBasis } = value;
    return apply({ query, grid, cells, totalVessels, generatedAt, metric, shipTypeBasis });
  }
  watch(
    () => session.value?.user.id,
    () => {
      close();
      seen.clear();
      lastSnapshot.value = null;
    },
    { flush: 'sync' },
  );
  onScopeDispose(close);
  return {
    result,
    lastSnapshot,
    closeRevision,
    lockedQuery,
    loading,
    error,
    displayed,
    mode,
    currentEnabled,
    selectMode,
    showCurrent,
    generate,
    close,
    cancel: invalidate,
    beginAgent,
    acceptAgent,
    showSnapshot,
  };
}
