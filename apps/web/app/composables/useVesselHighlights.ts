import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import {
  AgentVesselHighlightsResultSchema,
  MAP_HIGHLIGHT_LIMIT,
  type AgentVesselHighlightsResult,
  type HighlightEvidence,
  type HighlightGroup,
} from '@ais/contracts';
import type { ChartVesselHighlight } from '../types/chart';

/** Page-local task groups. Position ticks do not alter command concurrency versions. */
export function useVesselHighlights(paused: Ref<boolean>) {
  const { api, session } = usePlatform();
  const groups = ref<HighlightGroup[]>([]);
  const targets = ref<ChartVesselHighlight[]>([]);
  const revision = ref(0);
  const evidence = ref<HighlightEvidence>();
  const error = ref('');
  const missing = ref<string[]>([]);
  const updatedAt = ref<string>();
  const displayed = ref(false);
  const tombstones = new Set<string>();
  const commands = new Set<string>();
  const groupMissing = new Map<string, string[]>();
  let refreshMissing: string[] = [];
  let pendingArtifact: string | undefined;
  let generation = 0;
  let controller: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const mmsis = computed(() => [...new Set(groups.value.flatMap((g) => g.mmsis))]);
  function invalidate() {
    controller?.abort();
    controller = undefined;
    generation++;
  }
  function semanticChange(artifact?: string) {
    invalidate();
    revision.value++;
    displayed.value = false;
    evidence.value = undefined;
    pendingArtifact = artifact;
  }
  function markDisplayed(snapshot: ChartVesselHighlight[]) {
    if (snapshot !== targets.value) return;
    displayed.value = true;
    if (pendingArtifact)
      evidence.value = {
        artifactRef: pendingArtifact,
        groups: groups.value.map((g) => ({ ...g, mmsis: [...g.mmsis] })),
      };
  }
  function remove(groupIds: string[], artifact?: string) {
    semanticChange(artifact);
    for (const id of groupIds) {
      tombstones.add(id);
      groupMissing.delete(id);
    }
    groups.value = groups.value.filter((g) => !groupIds.includes(g.groupId));
    const retained = new Set(mmsis.value);
    targets.value = targets.value.filter((t) => retained.has(t.mmsi));
    refreshMissing = refreshMissing.filter((mmsi) => retained.has(mmsi));
    missing.value = [...new Set([...groupMissing.values()].flat().concat(refreshMissing))];
    error.value = '';
  }
  function apply(
    input: AgentVesselHighlightsResult,
    artifactRef: string,
    taskId: string,
    commandId: string,
  ) {
    if (commands.has(commandId)) return;
    const parsed = AgentVesselHighlightsResultSchema.parse(input);
    if (parsed.operation === 'clear') {
      const ids =
        parsed.clear!.mode === 'all' ? groups.value.map((g) => g.groupId) : parsed.clear!.groupIds;
      remove(ids, artifactRef);
      commands.add(commandId);
      return;
    }
    if (tombstones.has(artifactRef))
      throw Object.assign(new Error('该高亮组已被清除'), { code: 'STATE_CONFLICT' });
    const incoming = [...new Set(parsed.vessels.map((v) => v.mmsi))];
    const nextGroups = [
      ...groups.value.filter((g) => g.groupId !== artifactRef),
      { groupId: artifactRef, taskId, mmsis: incoming },
    ];
    if (
      new Set(nextGroups.flatMap((g) => g.mmsis)).size > MAP_HIGHLIGHT_LIMIT ||
      nextGroups.length > 100
    )
      throw Object.assign(new Error('当前页高亮超过100艘，请先清除部分高亮或缩小范围'), {
        code: 'UNAVAILABLE',
      });
    const previous = new Map(targets.value.map((t) => [t.mmsi, t]));
    for (const vessel of parsed.vessels) {
      const before = previous.get(vessel.mmsi);
      previous.set(vessel.mmsi, {
        ...(before && Date.parse(before.observedAt) > Date.parse(vessel.observedAt)
          ? before
          : vessel),
        effectId: before?.effectId ?? artifactRef,
      });
    }
    semanticChange(artifactRef);
    groups.value = nextGroups;
    targets.value = [...previous.values()].filter((t) => mmsis.value.includes(t.mmsi));
    groupMissing.set(artifactRef, parsed.missingMmsis);
    missing.value = [...new Set([...groupMissing.values()].flat().concat(refreshMissing))];
    commands.add(commandId);
    error.value = '';
  }
  async function refresh() {
    if (disposed || paused.value || !visible.value || !mmsis.value.length || controller) return;
    const ids = [...mmsis.value];
    const turn = generation;
    const request = new AbortController();
    controller = request;
    try {
      const response = await api<{
        items: { mmsi: string; lon: number; lat: number; observedAt: string }[];
        missing: string[];
      }>(`/vessels/positions?mmsis=${ids.join(',')}`, { signal: request.signal });
      if (turn !== generation || request.signal.aborted) return;
      const fresh = new Map(response.items.map((item) => [item.mmsi, item]));
      const next = targets.value.map((target) => {
        const point = fresh.get(target.mmsi);
        if (!point) return target;
        const observedTime = Date.parse(point.observedAt);
        const previousTime = Date.parse(target.observedAt);
        if (!Number.isFinite(observedTime) || observedTime < previousTime) return target;
        if (point.lon === target.lon && point.lat === target.lat && observedTime === previousTime)
          return target;
        // Build only trusted position fields; retain the original animation identity.
        if (
          !Number.isFinite(point.lon) ||
          !Number.isFinite(point.lat) ||
          point.lon < -180 ||
          point.lon > 180 ||
          point.lat < -90 ||
          point.lat > 90
        )
          return target;
        return { ...target, lon: point.lon, lat: point.lat, observedAt: point.observedAt };
      });
      if (next.some((target, index) => target !== targets.value[index])) targets.value = next;
      refreshMissing = response.missing.filter((id) => ids.includes(id));
      missing.value = [...new Set([...groupMissing.values()].flat().concat(refreshMissing))];
      updatedAt.value = new Date().toISOString();
      error.value = '';
    } catch {
      if (turn === generation && !request.signal.aborted)
        error.value = '船位刷新失败，保留最后位置，稍后重试。';
    } finally {
      if (controller === request) controller = undefined;
    }
  }
  function schedule() {
    clearTimeout(timer);
    if (disposed || paused.value || !visible.value || !mmsis.value.length) return;
    timer = setTimeout(async () => {
      await refresh();
      schedule();
    }, 5000);
  }
  function clearGroup(groupId: string) {
    remove([groupId]);
  }
  function clearAll() {
    remove(groups.value.map((g) => g.groupId));
  }
  function reset() {
    clearAll();
    tombstones.clear();
    commands.clear();
    groupMissing.clear();
    refreshMissing = [];
    missing.value = [];
    updatedAt.value = undefined;
  }
  function visibilityChanged() {
    visible.value = document.visibilityState !== 'hidden';
  }
  if (typeof document !== 'undefined')
    document.addEventListener('visibilitychange', visibilityChanged);
  watch(
    [paused, visible, () => mmsis.value.join(',')],
    () => {
      if (paused.value || !visible.value || !mmsis.value.length) invalidate();
      schedule();
    },
    { flush: 'sync' },
  );
  watch(() => session.value?.user.id, reset, { flush: 'sync' });
  onScopeDispose(() => {
    disposed = true;
    clearTimeout(timer);
    reset();
    if (typeof document !== 'undefined')
      document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return {
    groups,
    targets,
    revision,
    evidence,
    displayed,
    error,
    missing,
    updatedAt,
    apply,
    refresh,
    markDisplayed,
    clearGroup,
    clearAll,
  };
}
