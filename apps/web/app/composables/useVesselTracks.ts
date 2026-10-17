import { onScopeDispose, ref, watch } from 'vue';
import {
  VesselTracksQuerySchema,
  VesselTracksResultSchema,
  validateVesselTracksWindow,
} from '@ais/contracts';
import type {
  AgentVesselTracksResult,
  VesselTracksQuery,
  VesselTracksResult,
} from '@ais/contracts';

export function useVesselTracks() {
  const { api, session } = usePlatform();
  const result = ref<VesselTracksResult | null>(null);
  const lastSnapshot = ref<VesselTracksResult | null>(null);
  const lockedQuery = ref<VesselTracksQuery | null>(null);
  const loading = ref(false);
  const displayed = ref(false);
  const error = ref('');
  const revision = ref(0);
  let generation = 0;
  let controller: AbortController | undefined;
  const seen = new Set<string>();
  function invalidate() {
    controller?.abort();
    controller = undefined;
    loading.value = false;
    return ++generation;
  }
  function cancel() {
    revision.value++;
    invalidate();
  }
  function close() {
    cancel();
    result.value = null;
    lockedQuery.value = null;
    displayed.value = false;
    error.value = '';
  }
  function reset() {
    close();
    lastSnapshot.value = null;
    seen.clear();
  }
  function apply(value: unknown) {
    const parsed = VesselTracksResultSchema.safeParse(value);
    if (!parsed.success) {
      error.value = '历史航线结果无效或超出展示上限，请缩小条件后重新查询。';
      return false;
    }
    result.value = parsed.data;
    lastSnapshot.value = parsed.data;
    lockedQuery.value = parsed.data.query;
    displayed.value = false;
    error.value = '';
    return true;
  }
  async function generate(input: VesselTracksQuery, now = new Date()) {
    revision.value++;
    const turn = invalidate();
    error.value = '';
    let snapshot: VesselTracksQuery;
    try {
      snapshot = VesselTracksQuerySchema.parse(input);
      validateVesselTracksWindow(snapshot, now);
    } catch {
      error.value =
        '请填写船舶选择条件，并选择近30天内、最长7天的有效时段；最多50艘且总点数预算不超过10000。';
      return;
    }
    lockedQuery.value = snapshot;
    loading.value = true;
    controller = new AbortController();
    try {
      const value = await api<VesselTracksResult>('/map/vessel-tracks/query', {
        method: 'POST',
        body: snapshot,
        signal: controller.signal,
        timeoutMs: 30000,
      });
      if (turn === generation) apply(value);
    } catch (e) {
      if (turn === generation)
        error.value =
          (e as { status?: number }).status === 413
            ? '历史航线数据超过查询上限，请缩小时间、范围或船舶条件。'
            : (e as Error).message;
    } finally {
      if (turn === generation) loading.value = false;
    }
  }
  function showSnapshot(value: VesselTracksResult | AgentVesselTracksResult) {
    revision.value++;
    invalidate();
    const {
      query,
      asOf,
      generatedAt,
      shipTypeBasis,
      selectionBasis,
      trackScope,
      returnedVessels,
      matchedVesselsLowerBound,
      hasMoreVessels,
      tracks,
    } = value;
    return apply({
      query,
      asOf,
      generatedAt,
      shipTypeBasis,
      selectionBasis,
      trackScope,
      returnedVessels,
      matchedVesselsLowerBound,
      hasMoreVessels,
      tracks,
    });
  }
  function acceptAgent(value: AgentVesselTracksResult, scope: string, token: number) {
    const key = `${session.value?.user.id}:${scope}:${value.inputRevision}:${value.version}`;
    if (token !== generation || seen.has(key)) return false;
    if (!showSnapshot(value)) return false;
    seen.add(key);
    return true;
  }
  watch(() => session.value?.user.id, reset, { flush: 'sync' });
  onScopeDispose(reset);
  return {
    result,
    lastSnapshot,
    lockedQuery,
    loading,
    displayed,
    error,
    revision,
    generate,
    cancel,
    close,
    reset,
    showSnapshot,
    beginAgent: () => generation,
    acceptAgent,
  };
}
