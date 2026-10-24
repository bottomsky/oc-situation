<script setup lang="ts">
import type {
  AnalysisResult,
  AgentMapContext,
  Bbox,
  FocusTargetRef,
  IntelligenceGeometry,
} from '@ais/contracts';
import { RouteSchema, OperationalEventSchema } from '@ais/contracts';
import { createHandoffGeneration } from '../utils/operationalEvents';
import { focusBounds } from '../../../../packages/domain/agent-focus';
import type { ChartLayerVisibility, ChartMapControls } from '../types/chart';
import { readChartPreference, writeChartPreference } from '../utils/chartWorkspace';
import { chartLayoutDefaults } from '../utils/chartLayout';
import { defaultChartVisibility } from '../utils/chartLayers';
import { heatmapDateLabel } from '../utils/display';
import { commandPresentation } from '../utils/agentArtifacts';
import { provideChartDetailHost } from '../composables/useChartDetail';
const detailHost = provideChartDetailHost();
let workspace = reactive(useChartWorkspace());
const topics = reactive(useTopicResults());
const prediction = reactive(useReachability());
watch(
  () => workspace.leftTab,
  (tab) => {
    if (tab === 'prediction') void prediction.loadWatchlist();
  },
);
const selectedBusiness = ref<
  {
    kind: 'route' | 'event';
    id: string;
    revision: number;
    label: string;
    geometry: IntelligenceGeometry | null;
  }[]
>([]);
const selectedShips = ref<string[]>([]);
const handoffError = ref('');
const businessChoices = ref<{ kind: 'route' | 'event'; id: string; label: string }[]>([]);
const businessChoice = ref('');
async function loadBusinessChoices() {
  const current = handoffGeneration.begin();
  try {
    const [routes, events] = await Promise.all([
      api<{ items: unknown[] }>('/routes?limit=100&offset=0'),
      api<{ items: unknown[] }>('/operational-events?limit=100&offset=0'),
    ]);
    if (!current()) return;
    businessChoices.value = [
      ...routes.items.map((raw) => {
        const v = RouteSchema.parse(raw);
        return { kind: 'route' as const, id: v.id, label: v.name };
      }),
      ...events.items.map((raw) => {
        const v = OperationalEventSchema.parse(raw);
        return { kind: 'event' as const, id: v.id, label: v.title };
      }),
    ];
  } catch {
    if (current()) handoffError.value = '业务对象列表读取失败，请重试。';
  }
}
function addBusinessChoice() {
  const value = businessChoices.value.find((v) => `${v.kind}:${v.id}` === businessChoice.value);
  if (value) void businessHandoff(value.kind, value.id);
}
function addShip() {
  const id = workspace.detail?.mmsi;
  if (
    id &&
    !selectedShips.value.includes(id) &&
    selectedBusiness.value.length + selectedShips.value.length < 100
  )
    selectedShips.value.push(id);
}
function mapContext(): AgentMapContext {
  const shipType = Number(workspace.shipType);
  const mmsis = [...selectedShips.value].slice(0, 100 - selectedBusiness.value.length);
  return {
    bbox: [...currentMapBounds()],
    capturedAt: new Date().toISOString(),
    hours: workspace.hours,
    selectedMmsis: mmsis,
    selectedTargets: [
      ...mmsis.map((id): FocusTargetRef => ({ kind: 'vessel', id })),
      ...selectedBusiness.value.map(({ kind, id, revision }): FocusTargetRef => ({
        kind,
        id,
        revision,
      })),
    ],
    ...(agentDrawnRegion.value
      ? { region: { kind: 'bbox' as const, bbox: [...agentDrawnRegion.value] as Bbox } }
      : {}),
    ...(workspace.sourceId ? { sourceId: workspace.sourceId } : {}),
    ...(Number.isInteger(shipType) && shipType >= 1 && shipType <= 99 ? { shipType } : {}),
  };
}
const heatmap = reactive(useAisHeatmap());
const vesselTracks = reactive(useVesselTracks());
const vesselHighlights = reactive(useVesselHighlights(toRef(workspace, 'paused')));
const ui = useAgentUi();
const agent = reactive(
  useAgentConversation(
    mapContext,
    {
      begin: heatmap.beginAgent,
      accept: heatmap.acceptAgent,
      reset: heatmap.close,
    },
    ui.bind,
    ui.readConfig,
    { begin: vesselTracks.beginAgent, accept: vesselTracks.acceptAgent, reset: vesselTracks.reset },
  ),
);
const focus = reactive(useAgentFocus());
const focusCrowded = ref(false);
watch(
  () => agent.currentReply,
  (reply) => {
    focus.setScope(reply?.sessionId ?? null, reply?.taskId ?? null, reply?.inputRevision ?? 0);
    if (!reply || reply.readable === false) focus.reset();
    else if (
      agent.config?.spatialFocusEnabled !== false &&
      !reply.focusCommandDriven &&
      reply.focus &&
      !focus.artifactRef
    )
      focus.accept(reply.focus);
  },
  { flush: 'sync' },
);
const selectingHeatmapRegion = ref(false);
watch(
  () => agent.activeSession?.id ?? null,
  (id) => ui.setSession(id),
  { flush: 'sync' },
);
const heatmapRegion = ref<Bbox | null>(null);
function finishRegion(bbox: Bbox) {
  if (selectingHeatmapRegion.value) {
    heatmapRegion.value = [...bbox];
    selectingHeatmapRegion.value = false;
  } else finishAgentRegion(bbox);
}
const selectingAgentRegion = ref(false);
const agentDrawnRegion = ref<Bbox | null>(null);
function beginAgentRegion() {
  selectingHeatmapRegion.value = false;
  agentDrawnRegion.value = null;
  selectingAgentRegion.value = true;
}
function finishAgentRegion(bbox: Bbox) {
  agentDrawnRegion.value = bbox;
  selectingAgentRegion.value = false;
}
const rightTab = ref<'chat' | 'push' | 'tasks'>('chat');
function openAgent() {
  rightOpen.value = true;
  prepareAgentConversation();
}
function prepareAgentConversation() {
  rightTab.value = 'chat';
}
const agentDock = useTemplateRef<HTMLElement>('agentDock');
async function closeCurrentReply() {
  agent.dismissCurrentReply();
  await nextTick();
  const input = agentDock.value?.querySelector<HTMLTextAreaElement>('.composer-input');
  if (input && !input.disabled) input.focus({ preventScroll: true });
  else agentDock.value?.querySelector<HTMLButtonElement>('.composer-bot')?.focus();
}
async function openCurrentConversation() {
  const reply = agent.currentReply;
  if (!reply) return;
  openAgent();
  if (reply.taskId) await agent.loadTask(reply.taskId);
  await nextTick();
  if (agent.activeSession?.id !== reply.sessionId) return;
  const slot = workspaceElement.value?.querySelector<HTMLElement>('#chart-right-slot');
  const messageId = reply.assistant?.id ?? reply.userMessageId;
  const message = messageId
    ? slot?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
    : null;
  const target = message ?? slot?.querySelector<HTMLElement>('[data-testid="agent-panel"]');
  const scroll = target?.closest<HTMLElement>('.chart-panel-scroll');
  if (target && scroll) {
    scroll.scrollTop +=
      target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 12;
    target.focus({ preventScroll: true });
  }
}
const intelligence = reactive(useIntelligenceWorkspace());
const drawnGeometry = ref<unknown>();
const mapChoices = ref<string[]>([]);
async function selectIntelligence(id: string) {
  leftOpen.value = true;
  detailHost.open('intelligence', 'left');
  workspace.leftTab = 'intelligence';
  await intelligence.select(id);
}
async function locateIntelligence(id?: string) {
  if (id) await intelligence.add([id]);
  await nextTick();
  seaMap.value?.locateIntelligence(id);
}
function selectMapIntelligence(ids: string[]) {
  leftOpen.value = true;
  mapChoices.value = ids;
  if (ids[0]) void selectIntelligence(ids[0]);
}
const { session, api } = usePlatform();
const route = useRoute();
const seaMap = useTemplateRef<ChartMapControls>('seaMap');
const handoffGeneration = createHandoffGeneration();
async function businessHandoff(kind: 'route' | 'event', id: string, ask = false) {
  const current = handoffGeneration.begin(),
    camera = seaMap.value?.cameraIntent();
  handoffError.value = '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    handoffError.value = '业务对象标识无效。';
    return;
  }
  try {
    const raw = await api(
      `/${kind === 'route' ? 'routes' : 'operational-events'}/${encodeURIComponent(id)}`,
    );
    const value = kind === 'route' ? RouteSchema.parse(raw) : OperationalEventSchema.parse(raw);
    if (!current()) return;
    const object = {
      kind,
      id: value.id,
      revision: value.revision,
      label: 'name' in value ? value.name : value.title,
      geometry: value.geometry,
    };
    const index = selectedBusiness.value.findIndex((v) => v.id === value.id && v.kind === kind);
    if (index >= 0) selectedBusiness.value[index] = object;
    else if (selectedBusiness.value.length + selectedShips.value.length < 100)
      selectedBusiness.value.push(object);
    else {
      handoffError.value = '关注集合最多100个对象，请移除部分对象后添加。';
      return;
    }
    if (object.geometry) {
      if (camera) {
        const bbox = focusBounds([object.geometry]);
        if (bbox) camera({ mode: 'bounds', maxZoom: 11, bbox });
      } else seaMap.value?.focusGeometry(object.geometry);
    }
    if (ask) {
      agent.draft = `分析这${kind === 'route' ? '条航线' : '个事件'}：${object.label}`;
      openAgent();
    }
  } catch {
    if (current()) handoffError.value = '业务对象读取失败，请检查权限或刷新重试。';
  }
}
watch(
  () => [route.query.routeId, route.query.operationalEventId, seaMap.value] as const,
  ([routeId, eventId, map]) => {
    handoffGeneration.invalidate();
    if (!map) return;
    if (typeof eventId === 'string')
      void businessHandoff('event', eventId, route.query.askEvent === '1');
    else if (typeof routeId === 'string')
      void businessHandoff('route', routeId, route.query.askRoute === '1');
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  handoffGeneration.invalidate();
});
// Capture user intent before network work; a later camera action cancels its right to focus.
const loadTrack = workspace.loadTrack;
workspace.loadTrack = async () => {
  const focus = seaMap.value?.cameraIntent();
  const previous = workspace.track;
  await loadTrack();
  const point =
    workspace.track !== previous
      ? workspace.track?.segments.flatMap((s) => s.points)[0]
      : undefined;
  if (point) focus?.({ mode: 'point', center: [point.lon, point.lat], zoom: 7 });
};
function currentMapBounds(): Bbox {
  return seaMap.value?.currentBounds() ?? workspace.bbox;
}
const center = useTemplateRef<HTMLElement>('center');
const workspaceElement = useTemplateRef<HTMLElement>('workspaceElement');
const leftOpen = ref(false);
const rightOpen = ref(true);
watch(leftOpen, (open) => {
  if (!open && detailHost.active.value?.side === 'left') detailHost.close();
});
watch(rightOpen, (open) => {
  if (!open && detailHost.active.value?.side === 'right') detailHost.close();
});
watch(
  () => workspace.leftTab,
  (tab) => {
    if (tab !== 'intelligence') detailHost.close('intelligence');
    if (tab !== 'search') detailHost.close('vessel');
  },
);
const {
  layout,
  style: layoutStyle,
  defaults,
  change: resizePanel,
  persist: saveLayout,
} = useChartLayout({
  user: computed(() => session.value?.user.id),
  workspace: workspaceElement,
  center,
  leftOpen,
  rightOpen,
});
const layers = reactive<ChartLayerVisibility>({ ...defaultChartVisibility });
const fullscreen = ref(false);
useUiComponent('workspace.left', {
  read: () => uiProjection(leftOpen.value, ['open', 'close', 'tab'], { tab: workspace.leftTab }),
  execute: (op) => {
    leftOpen.value = op.action !== 'close';
    if (op.action === 'tab') workspace.leftTab = op.tab as typeof workspace.leftTab;
  },
});
useUiComponent('workspace.right', {
  read: () => uiProjection(rightOpen.value, ['open', 'close', 'tab'], { tab: rightTab.value }),
  execute: async (op) => {
    agentPanelChange = true;
    try {
      rightOpen.value = op.action !== 'close';
      if (op.action === 'tab') {
        rightTab.value = op.tab as typeof rightTab.value;
      }
      await nextTick();
    } finally {
      agentPanelChange = false;
    }
  },
});
for (const key of ['ais', 'tracks', 'evidence'] as const)
  useUiComponent(`chart.layers.${key}`, {
    read: () => uiProjection(layers[key], ['show', 'hide']),
    execute: (op) => {
      layers[key] = op.action === 'show';
    },
  });
useUiComponent('chart.heatmap', {
  read: () =>
    uiProjection(!!heatmap.result, ['close', 'show'], {
      visible: !!heatmap.result && heatmap.displayed,
      loading: heatmap.loading,
      interacting: selectingHeatmapRegion.value,
      revision: heatmap.closeRevision,
    }),
  execute: async (op, command) => {
    if (op.action === 'close') {
      selectingHeatmapRegion.value = false;
      heatmap.close();
    } else {
      const value = commandPresentation(
        command.presentation,
        command.artifactRef,
        heatmap.lastSnapshot,
      );
      if (!value) throw { code: 'UNAVAILABLE' };
      heatmap.showSnapshot(value);
      const deadline = Date.now() + 10000;
      while (!heatmap.displayed && heatmap.result && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await nextTick();
  },
});
useUiComponent('chart.vessel-tracks', {
  read: () =>
    uiProjection(!!vesselTracks.result, ['show', 'close'], {
      visible: !!vesselTracks.result && vesselTracks.displayed,
      loading: vesselTracks.loading,
      revision: vesselTracks.revision,
    }),
  execute: async (op, command) => {
    if (op.action === 'close') {
      vesselTracks.close();
      await nextTick();
      return;
    }
    const value = commandPresentation(
      command.tracksPresentation,
      command.artifactRef,
      vesselTracks.lastSnapshot,
    );
    if (!value || !vesselTracks.showSnapshot(value)) throw { code: 'UNAVAILABLE' };
    const snapshot = vesselTracks.result;
    const revision = vesselTracks.revision;
    const deadline = Date.now() + 10000;
    while (!vesselTracks.displayed && vesselTracks.revision === revision && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (vesselTracks.result !== snapshot || vesselTracks.revision !== revision)
      throw { code: 'STATE_CONFLICT' };
    if (!vesselTracks.displayed) throw { code: 'POSTCONDITION_FAILED' };
  },
});
useUiComponent('chart.heatmap.legend', { read: () => uiProjection(!!heatmap.result, []) });
useUiComponent('chart.vessel-highlights', {
  read: () =>
    uiProjection(!!vesselHighlights.groups.length, ['show', 'close'], {
      mounted: !!seaMap.value?.interactionState().ready,
      visible: !!vesselHighlights.groups.length && vesselHighlights.displayed,
      revision: vesselHighlights.revision,
      highlightGroups: vesselHighlights.groups,
      ...(vesselHighlights.evidence ? { highlightEvidence: vesselHighlights.evidence } : {}),
    }),
  execute: async (_operation, command) => {
    if (!command.highlightsPresentation || !command.artifactRef) throw { code: 'UNAVAILABLE' };
    vesselHighlights.apply(
      command.highlightsPresentation,
      command.artifactRef,
      command.taskId,
      command.id,
    );
    const revision = vesselHighlights.revision;
    const deadline = Date.now() + 10000;
    while (
      !vesselHighlights.displayed &&
      vesselHighlights.revision === revision &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (vesselHighlights.revision !== revision) throw { code: 'STATE_CONFLICT' };
    if (vesselHighlights.evidence?.artifactRef !== command.artifactRef)
      throw { code: 'POSTCONDITION_FAILED' };
  },
});
useUiComponent('chart.focus', {
  read: () =>
    uiProjection(!!focus.result, ['show', 'close', 'focus'], {
      mounted: !!seaMap.value?.interactionState().ready,
      visible: !!focus.result && focus.displayed,
      loading: !!focus.result && !focus.displayed,
      focused: !!focus.result && focus.displayed,
      ...(focus.result && focus.artifactRef && focus.displayed
        ? {
            focusEvidence: {
              artifactRef: focus.artifactRef,
              taskId: focus.result.taskId,
              version: focus.result.version,
              inputRevision: focus.result.inputRevision,
              displayStatus: focus.displayStatus,
            },
          }
        : {}),
    }),
  execute: async (operation, command) => {
    if (operation.action === 'close') {
      focus.dismiss();
      return;
    }
    if (
      !command.focusPresentation ||
      !command.artifactRef ||
      !agent.currentReply ||
      agent.currentReply.readable === false ||
      agent.currentReply.taskId !== command.taskId
    )
      throw { code: 'UNAVAILABLE' };
    if (!focus.accept(command.focusPresentation, command.artifactRef))
      throw { code: 'STATE_CONFLICT' };
    const result = focus.result,
      deadline = Date.now() + 10000;
    while (!focus.displayed && focus.result === result && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    if (focus.result !== result) throw { code: 'STATE_CONFLICT' };
    if (!focus.displayed) throw { code: 'POSTCONDITION_FAILED' };
  },
});
useUiComponent('agent.reply', {
  read: () => uiProjection(!!agent.currentReply, ['close', 'open'], { order: 10 }),
  execute: (op) => {
    if (op.action === 'close') agent.dismissCurrentReply();
    else agent.showCurrentReply();
  },
});
useUiComponent('chart.choices', {
  read: () => uiProjection(!!mapChoices.value.length, ['close'], { order: 30 }),
  execute: () => {
    mapChoices.value = [];
  },
});
const viewportRevision = ref(1);
watch(
  () => workspace.detail?.mmsi,
  () => {
    viewportRevision.value++;
  },
  { flush: 'sync' },
);
useUiComponent('chart.viewport', {
  read: () =>
    chartViewportSnapshot({
      map: seaMap.value?.interactionState(),
      cameraState: seaMap.value?.cameraState() ?? undefined,
      cameraEvidence: seaMap.value?.currentCamera() ?? undefined,
      target: workspace.detail?.latestPosition,
      selecting: selectingAgentRegion.value || selectingHeatmapRegion.value,
      dirty: !!drawnGeometry.value,
      revision: viewportRevision.value,
    }),
  execute: async (_operation, command) => {
    const target = workspace.detail?.latestPosition;
    const request =
      command.cameraPresentation?.request ??
      (target
        ? {
            mode: 'point' as const,
            center: [target.lon, target.lat] as [number, number],
            zoom: 10,
          }
        : undefined);
    if (!request || !seaMap.value) throw { code: 'UNAVAILABLE' };
    await seaMap.value.applyCamera({ ...request, commandId: command.id });
    await nextTick();
  },
});
function layer(key: keyof ChartLayerVisibility, enabled: boolean) {
  layers[key] = enabled;
}
function selectVessel(mmsi: string) {
  leftOpen.value = true;
  detailHost.open('vessel', 'left');
  void workspace.select(mmsi);
}
async function selectResult(result: AnalysisResult) {
  const focus = seaMap.value?.cameraIntent();
  rightOpen.value = true;
  detailHost.open('evidence', 'right');
  rightTab.value = 'push';
  await topics.select(result);
  if (topics.evidence?.id === result.id)
    focus?.({ mode: 'bounds', bbox: topics.evidence.bbox, maxZoom: 11 });
}
function locateResult(result: AnalysisResult) {
  topics.locate(result);
  void seaMap.value
    ?.applyCamera({ mode: 'bounds', bbox: result.bbox, maxZoom: 11 })
    .catch(() => undefined);
}
function reviseResult(result: AnalysisResult) {
  topics.revision(result);
  locateResult(result);
}
async function toggleFullscreen() {
  if (!center.value) return;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await center.value.requestFullscreen();
  } catch {
    workspace.error = '当前浏览器无法打开全屏，请使用浏览器全屏模式。';
  }
}
function updateFullscreen() {
  fullscreen.value = !!document.fullscreenElement;
}
function keydown(event: KeyboardEvent) {
  if (selectingHeatmapRegion.value) {
    if (event.key === 'Escape') selectingHeatmapRegion.value = false;
    return;
  }
  if (selectingAgentRegion.value) {
    if (event.key === 'Escape') selectingAgentRegion.value = false;
    return;
  }
  if (document.querySelector('dialog:modal')) return;
  const target = event.target as HTMLElement | null;
  if (
    target?.closest('input, textarea, select, [contenteditable="true"]') ||
    event.ctrlKey ||
    event.altKey ||
    event.metaKey
  )
    return;
  if (event.key === 'Home') {
    event.preventDefault();
    seaMap.value?.resetView();
  }
  if (event.key === '+' || event.key === '=') seaMap.value?.zoomIn();
  if (event.key === '-') seaMap.value?.zoomOut();
}
function restorePrefs() {
  if (!session.value) return;
  leftOpen.value = false;
  rightOpen.value = readChartPreference(
    localStorage,
    session.value.user.id,
    'right',
    window.innerWidth >= 1024,
  );
  if (route.query.q) leftOpen.value = true;
}
onMounted(() => {
  restorePrefs();
  if (typeof route.query.eventId === 'string') void selectIntelligence(route.query.eventId);
  else if (typeof route.query.intelligenceId === 'string')
    void selectIntelligence(route.query.intelligenceId);
  if (typeof route.query.objectId === 'string') {
    intelligence.filters.objectId = route.query.objectId;
    workspace.leftTab = 'intelligence';
    leftOpen.value = true;
    void intelligence.load();
  }
  document.addEventListener('fullscreenchange', updateFullscreen);
  document.addEventListener('keydown', keydown);
});
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', updateFullscreen);
  document.removeEventListener('keydown', keydown);
});
watch(
  () => session.value?.user.id,
  () => {
    if (import.meta.client) restorePrefs();
  },
);
let agentPanelChange = false;
watch(rightOpen, (right) => {
  if (agentPanelChange) return;
  if (!import.meta.client || !session.value) return;
  writeChartPreference(localStorage, session.value.user.id, 'right', right);
});
watch(
  () => [route.query.q, route.query.searchRevision],
  () => {
    if (route.query.q) leftOpen.value = true;
  },
);
</script>
<template>
  <section
    ref="workspaceElement"
    class="chart-workspace"
    :class="{ 'left-open': leftOpen, 'right-open': rightOpen }"
    :style="layoutStyle"
    data-testid="chart-workspace"
  >
    <div class="chart-mobile-toolbar">
      <button :aria-expanded="leftOpen" @click="leftOpen = !leftOpen">
        <ChartIcon name="Menu" />操作面板</button
      ><strong>全球船位观测</strong
      ><button :aria-expanded="rightOpen" @click="rightOpen = !rightOpen">
        <ChartIcon name="Radio" />智能协同
      </button>
    </div>
    <div
      v-if="leftOpen || rightOpen"
      class="chart-drawer-scrim"
      @click="
        leftOpen = false;
        rightOpen = false;
      "
    />
    <div v-if="agent.currentReply && focusCrowded" class="focus-space-notice" role="status">
      海图回复空间不足
      <button
        type="button"
        @click="
          leftOpen = false;
          rightOpen = false;
        "
      >
        收起侧栏查看
      </button>
    </div>
    <div v-show="leftOpen" id="chart-left-slot" class="chart-left-slot open">
      <ChartLeftPanel
        v-model:workspace="workspace"
        :layers="layers"
        @close="leftOpen = false"
        @select-vessel="selectVessel"
        @layer="layer"
        ><template #intelligence
          ><IntelligenceList
            v-model:state="intelligence"
            @select="selectIntelligence"
            @locate="locateIntelligence"
        /></template>
        <template #prediction
          ><ChartPredictionPanel
            :state="prediction"
            :selected-mmsi="workspace.detail?.mmsi"
            @locate="seaMap?.focusPrediction?.($event)"
        /></template>
        <template #history-tracks
          ><ChartVesselTracksPanel
            :state="vesselTracks"
            :current-bounds="currentMapBounds"
            :source-id="workspace.sourceId"
        /></template>
        <template #heatmap
          ><ChartHeatmapPanel
            :state="heatmap"
            :current-bounds="currentMapBounds"
            :bbox="workspace.bbox"
            :region="heatmapRegion"
            :drawing="selectingHeatmapRegion"
            :source-id="workspace.sourceId"
            :ship-type="workspace.shipType"
            @region="heatmapRegion = $event"
            @draw="
              selectingAgentRegion = false;
              selectingHeatmapRegion = true;
            "
            @stop="selectingHeatmapRegion = false"
        /></template>
      </ChartLeftPanel>
      <ChartResizeHandle
        v-if="layout.enabled.left"
        panel="left"
        label="调整操作面板宽度"
        controls="chart-left-slot"
        :value="layout.sizes.left"
        :min="layout.bounds.left.min"
        :max="layout.bounds.left.max"
        :default-value="chartLayoutDefaults.left"
        @change="resizePanel('left', $event)"
        @commit="saveLayout"
      />
    </div>
    <main ref="center" class="chart-center">
      <header class="chart-map-heading">
        <div>
          <ChartIcon name="Radar" />
          <h1>全球船位观测</h1>
          <small>MARITIME SITUATIONAL AWARENESS</small>
        </div>
        <div class="chart-map-actions">
          <button aria-label="放大海图" title="放大海图 (+)" @click="seaMap?.zoomIn()">
            <ChartIcon name="Plus" />
          </button>
          <button aria-label="缩小海图" title="缩小海图 (-)" @click="seaMap?.zoomOut()">
            <ChartIcon name="Minus" />
          </button>
          <button :disabled="workspace.busy" aria-label="刷新" @click="workspace.refresh">
            <ChartIcon name="RefreshCw" /></button
          ><button @click="workspace.paused = !workspace.paused">
            <ChartIcon :name="workspace.paused ? 'Play' : 'Pause'" />{{
              workspace.paused ? '恢复更新' : '暂停更新'
            }}</button
          ><button
            aria-label="重置海图视野"
            title="重置海图视野 (Home)"
            @click="seaMap?.resetView()"
          >
            <ChartIcon name="Home" /></button
          ><button :aria-label="fullscreen ? '退出海图全屏' : '海图全屏'" @click="toggleFullscreen">
            <ChartIcon name="Maximize" />
          </button>
        </div>
      </header>
      <div class="chart-map-stage">
        <ClientOnly
          ><SeaMap
            ref="seaMap"
            :data="workspace.data"
            :vessel-names="workspace.vesselNames"
            :query-bounds="workspace.queryBounds"
            @area-query="workspace.queryArea($event)"
            :prediction="
              prediction.visible && prediction.result?.prediction.status === 'ready'
                ? prediction.result.prediction
                : null
            "
            :prediction-minutes="prediction.minutes"
            :prediction-observation="prediction.visible ? prediction.inputObservation : null"
            :prediction-view="prediction.view"
            :prediction-levels="prediction.levels"
            :prediction-impacts="
              prediction.visible && !prediction.result?.stale ? prediction.result?.impacts : []
            "
            :selecting-region="selectingAgentRegion || selectingHeatmapRegion"
            @region-selected="finishRegion"
            @region-cancelled="
              selectingAgentRegion = false;
              selectingHeatmapRegion = false;
            "
            :vessel-tracks="vesselTracks.result"
            :vessel-highlights="vesselHighlights.targets"
            @vessel-highlights-displayed="vesselHighlights.markDisplayed"
            @vessel-tracks-displayed="
              if (vesselTracks.result === $event) vesselTracks.displayed = true;
            "
            :heatmap="heatmap.result"
            @heatmap-displayed="if (heatmap.result === $event) heatmap.displayed = true;"
            :track="workspace.track"
            :frame="workspace.track ? workspace.frame : null"
            :evidence="topics.mapEvidence"
            :layers="layers"
            :intelligence="intelligence.visiblePlot"
            :objects="intelligence.objects"
            :can-draw="session?.user.role !== 'viewer'"
            :intelligence-layers="intelligence.layerVisibility"
            :active-event-id="intelligence.activeId"
            @intelligence="selectMapIntelligence"
            @geometry="drawnGeometry = $event"
            @object="
              intelligence.filters.objectId = $event;
              workspace.leftTab = 'intelligence';
              leftOpen = true;
              intelligence.load();
            "
            @viewport="
              (bbox, zoom) => {
                workspace.viewport(bbox, zoom);
                intelligence.viewport(bbox);
              }
            "
            @select="selectVessel"
        /></ClientOnly>
        <ChartBusinessObjects
          :map="seaMap"
          :objects="selectedBusiness"
          @select="(kind, id) => businessHandoff(kind, id)"
        />
        <section class="business-selection" aria-label="人工关注集合">
          <strong>人工关注集合 · {{ selectedBusiness.length + selectedShips.length }} / 100</strong>
          <button @click="loadBusinessChoices">＋ 添加业务对象</button>
          <select
            v-if="businessChoices.length"
            v-model="businessChoice"
            aria-label="添加关注业务对象"
            @change="addBusinessChoice"
          >
            <option value="">选择航线或事件加入集合</option>
            <option
              v-for="item in businessChoices"
              :key="`${item.kind}:${item.id}`"
              :value="`${item.kind}:${item.id}`"
            >
              {{ item.kind === 'route' ? '航线' : '事件' }} · {{ item.label }}
            </option>
          </select>
          <button v-if="workspace.detail" @click="addShip">
            ＋ 当前船舶 {{ workspace.detail.mmsi }}
          </button>
          <button
            v-for="id in selectedShips"
            :key="id"
            @click="selectedShips = selectedShips.filter((v) => v !== id)"
          >
            船舶 {{ id }} ×
          </button>
          <button
            v-for="item in selectedBusiness"
            :key="`${item.kind}:${item.id}`"
            @click="selectedBusiness = selectedBusiness.filter((v) => v !== item)"
          >
            {{ item.kind === 'route' ? '航线' : '事件' }} {{ item.label }} · r{{ item.revision
            }}{{ item.geometry ? '' : ' · 未定位' }} ×
          </button>
          <button
            @click="
              selectedBusiness = [];
              selectedShips = [];
            "
          >
            清空关注
          </button>
          <p v-if="handoffError" role="alert">{{ handoffError }}</p>
        </section>
        <div v-if="mapChoices.length > 1" class="intelligence-map-choices">
          <strong>重叠情报 {{ mapChoices.length }} 条</strong
          ><button v-for="id in mapChoices" :key="id" @click="selectIntelligence(id)">
            {{ intelligence.plot.items.find((i) => i.eventId === id)?.title || id }}</button
          ><button @click="mapChoices = []">关闭</button>
        </div>
        <div class="chart-map-notices">
          <ChartVesselHighlights
            :groups="vesselHighlights.groups"
            :count="vesselHighlights.targets.length"
            :missing="vesselHighlights.missing"
            :updated-at="vesselHighlights.updatedAt"
            :error="vesselHighlights.error"
            :paused="workspace.paused"
            @clear-group="vesselHighlights.clearGroup"
            @clear-all="vesselHighlights.clearAll"
          />
          <section
            v-if="vesselTracks.result"
            class="vessel-tracks-legend"
            aria-label="历史航线图例"
            data-testid="vessel-tracks-legend"
          >
            <strong>历史航线 · {{ vesselTracks.result.returnedVessels }} 艘</strong>
            <span>{{ vesselTracks.displayed ? '海图已展示' : '等待地图绘制' }}</span>
            <span
              >{{ heatmapDateLabel(vesselTracks.result.query.from) }} ～
              {{ heatmapDateLabel(vesselTracks.result.query.to) }}</span
            >
            <span>按历史经过区域选船，展示时段完整可用航线；AIS 船型按当前资料。</span>
            <span v-if="vesselTracks.result.hasMoreVessels"
              >至少匹配
              {{ vesselTracks.result.matchedVesselsLowerBound }} 艘，已达展示数量上限。</span
            >
            <span v-if="vesselTracks.result.tracks.some((t) => t.sampled || t.truncated)"
              >部分航线已抽样或截断，详见人工面板。</span
            >
            <span v-if="!vesselTracks.result.tracks.length"
              >该条件下没有匹配观测；具体型号依赖已收录资料。</span
            >
            <button @click="vesselTracks.close">关闭历史航线</button>
          </section>
          <p v-if="vesselTracks.error" class="error" role="alert">{{ vesselTracks.error }}</p>
          <section
            v-if="heatmap.result"
            class="heatmap-legend"
            aria-label="热图统计图例"
            data-testid="heatmap-legend"
          >
            <strong>AIS 热力图 · 每格去重船数</strong>
            <span
              >{{ heatmap.displayed ? '海图已展示' : '计算完成，等待地图绘制' }} · 全区
              {{ heatmap.result.totalVessels }} 艘</span
            >
            <span
              >{{ heatmapDateLabel(heatmap.result.query.from) }} ～
              {{ heatmapDateLabel(heatmap.result.query.to) }}</span
            >
            <span>生成于 {{ heatmapDateLabel(heatmap.result.generatedAt) }}</span>
            <span
              >范围 {{ heatmap.result.query.bbox.map((n) => n.toFixed(2)).join('，') }} · 格宽
              {{ heatmap.result.grid.cellDegrees }}°</span
            >
            <span>色彩为平滑强度，非单位面积密度；点击网格查看实际船数。</span>
            <span v-if="heatmap.result.query.shipType"
              >船型 {{ heatmap.result.query.shipType }}（当前资料）</span
            >
            <span v-if="heatmap.result.query.sourceId"
              >来源 {{ heatmap.result.query.sourceId }}</span
            >
            <span v-if="!heatmap.result.cells.length">该范围和时段内无匹配观测</span>
            <button @click="heatmap.close">关闭热力图</button>
          </section>
          <p v-if="heatmap.error" class="error" role="alert">{{ heatmap.error }}</p>
          <FetchState :error="workspace.error" @retry="workspace.refresh" />
          <p v-if="workspace.liveError" class="error" role="status">
            {{ workspace.liveError }}
          </p>
          <p v-if="workspace.feedError" class="error" role="status">
            专题事件补取失败：{{ workspace.feedError }}
          </p>
          <p v-if="workspace.stale" class="chart-caution" role="status">
            船位已超过 15 秒未更新，显示上次成功结果。
          </p>
        </div>
        <ChartAgentInputDialog
          :current-bounds="currentMapBounds"
          :state="agent"
          :context="mapContext()"
          :drawing="selectingAgentRegion"
          :drawn-region="agentDrawnRegion"
          @draw="beginAgentRegion"
          @stop-drawing="selectingAgentRegion = false"
        />
        <AgentIntelligenceSourcesDialog :state="agent" @locate="seaMap?.focusGeometry($event)" />
        <ChartAgentFocusOverlay
          v-if="agent.currentReply"
          :key="agent.currentReply.createdAt"
          :map="seaMap"
          :reply="agent.currentReply"
          :focus="agent.config?.spatialFocusEnabled === false ? null : focus.result"
          :fleet="workspace.data"
          :layout-key="[leftOpen, rightOpen, layout.sizes.left, layout.sizes.right].join(':')"
          @displayed="(value, status) => focus.markDisplayed(value, status)"
          @crowded="focusCrowded = $event"
          @reference="agent.openSource"
          @close="closeCurrentReply"
          @open="openCurrentConversation"
        />
        <div ref="agentDock" class="chart-agent-dock">
          <ChartAgentComposer
            :state="agent"
            floating
            @open="openAgent"
            @submit="prepareAgentConversation"
          />
        </div>
        <div
          class="map-status"
          data-testid="map-snapshot-status"
          :data-loaded="workspace.data?.items.filter((v) => v.kind === 'point').length ?? 0"
          :data-complete="!!workspace.data && !workspace.data.truncated && !workspace.data.sampled"
        >
          <span class="status-dot" />{{
            workspace.data ? workspace.data.total.toLocaleString() : '—'
          }}
          艘船 · {{ workspace.busy ? '更新中' : workspace.paused ? '更新已暂停' : '持续更新'
          }}<span v-if="workspace.busy">
            · 快照 {{ workspace.snapshotProgress.loaded }} /
            {{ workspace.snapshotProgress.total }}</span
          ><span v-if="workspace.data?.truncated"> · 旧协议结果受限</span
          ><span v-else-if="workspace.data">
            · 完整单船
            {{
              workspace.data.items.filter((v) => v.kind === 'point').length.toLocaleString()
            }}</span
          >
          ><span> · UTC</span>
        </div>
        <button
          v-if="!leftOpen"
          class="chart-reopen-left"
          aria-label="打开人工操控面板"
          aria-controls="chart-left-slot"
          :aria-expanded="leftOpen"
          @click="leftOpen = true"
        >
          <ChartIcon name="Menu" />人工操控
        </button>
        <button
          v-if="!rightOpen && !agent.currentReply"
          class="chart-reopen-right"
          aria-label="打开协同面板"
          @click="rightOpen = true"
        >
          <ChartIcon name="Radio" />智能协同
        </button>
      </div>
    </main>
    <div v-show="rightOpen" id="chart-right-slot" class="chart-right-slot">
      <ChartResizeHandle
        v-if="layout.enabled.right"
        panel="right"
        label="调整协同面板宽度"
        controls="chart-right-slot"
        :value="layout.sizes.right"
        :min="layout.bounds.right.min"
        :max="layout.bounds.right.max"
        :default-value="defaults.right"
        @change="resizePanel('right', $event)"
        @commit="saveLayout"
      />
      <ChartRightPanel
        v-model:tab="rightTab"
        :agent="agent"
        @heatmap="heatmap.showSnapshot($event)"
        @tracks="vesselTracks.showSnapshot($event)"
        :bbox="workspace.bbox"
        :items="topics.items"
        :busy="topics.busy"
        :error="topics.error"
        :selecting="topics.selecting"
        :evidence="topics.evidence"
        :selected-id="topics.evidence?.id"
        @close="rightOpen = false"
        @select="selectResult"
        @retry="topics.load"
        @close-evidence="topics.close"
        @locate="locateResult"
        @revision="reviseResult"
        ><template #prediction
          ><ChartPredictionImpact
            v-if="prediction.result && workspace.leftTab === 'prediction'"
            :record="prediction.result"
            @evidence="selectIntelligence" /></template
      ></ChartRightPanel>
    </div>
    <ChartDetailFloat
      :open="detailHost.isOpen('intelligence')"
      side="left"
      title="情报证据"
      subtitle="INTELLIGENCE EVIDENCE"
      aria-label="情报证据面板"
      @close="detailHost.close('intelligence')"
    >
      <FetchState
        v-if="!intelligence.detail"
        :busy="!intelligence.error"
        :error="intelligence.error"
      />
      <IntelligenceDetail
        v-if="intelligence.detail"
        :detail="intelligence.detail"
        :panel-visible="detailHost.isOpen('intelligence')"
        :geometry="drawnGeometry"
        :can-draw="session?.user.role !== 'viewer'"
        @history="selectIntelligence"
        @draw="seaMap?.draw($event)"
        @edit-geometry="seaMap?.editGeometry($event)"
        @refresh="
          intelligence.select(intelligence.activeId, false);
          intelligence.refreshPlot();
        "
        @locate="locateIntelligence(intelligence.activeId)"
        @revise="navigateTo('/intelligence?revise=' + $event.id)"
      />
    </ChartDetailFloat>
    <ChartDetailFloat
      :open="detailHost.isOpen('vessel')"
      side="left"
      title="船舶详情"
      subtitle="VESSEL INFORMATION"
      @close="detailHost.close('vessel')"
    >
      <FetchState
        :busy="!workspace.detail && !workspace.detailError"
        :error="workspace.detailError"
      />
      <ChartVesselDetail
        v-if="workspace.detail"
        :detail="workspace.detail"
        @playback="
          workspace.leftTab = 'playback';
          detailHost.close('vessel');
        "
      />
    </ChartDetailFloat>
  </section>
</template>
<style scoped>
.focus-space-notice {
  position: fixed;
  top: calc(var(--console-header-height, 76px) + 8px);
  left: 8px;
  z-index: 45;
  display: flex;
  gap: 8px;
  align-items: center;
  max-width: calc(100vw - 80px);
  padding: 8px;
  border: 1px solid #38c9e9;
  border-radius: 6px;
  background: #092a3e;
  color: #b5edf6;
  font-size: 11px;
}
.focus-space-notice button {
  padding: 4px;
  border: 1px solid #337483;
  border-radius: 4px;
  color: #b5edf6;
  background: #123c4b;
  cursor: pointer;
}
.business-selection {
  position: absolute;
  left: 16px;
  top: 54px;
  z-index: 5;
  display: flex;
  max-width: 65%;
  gap: 6px;
  flex-wrap: wrap;
  padding: 10px;
  background: #092c38e8;
  border: 1px solid #3c7d85;
  border-radius: 8px;
  color: #c9e6e4;
  font-size: 12px;
}
.business-selection strong {
  width: 100%;
  letter-spacing: 1px;
}
.business-selection button {
  padding: 4px 8px;
  border: 1px solid #336370;
  border-radius: 4px;
  background: #164653;
  color: #c9ede8;
}
.business-selection p {
  color: #ffc7ae;
}
</style>

<style scoped>
.heatmap-legend,
.vessel-tracks-legend {
  display: grid;
  gap: 5px;
  padding: 10px;
  max-width: 420px;
  color: #d8effc;
  background: #09273ce8;
  border: 1px solid #31718b;
  font-size: 11px;
  pointer-events: auto;
}
.heatmap-legend strong::after {
  content: '';
  display: block;
  margin-top: 5px;
  height: 5px;
  background: linear-gradient(90deg, #206ca5, #23c5bc, #f2d666, #e56244);
}
.chart-workspace:not(.left-open) .chart-map-notices {
  top: 50px;
}
.chart-agent-dock {
  --reply-dock-bottom: 40px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  bottom: var(--reply-dock-bottom);
  max-height: calc(100% - var(--reply-dock-bottom) - 16px);
}
.chart-agent-dock > .chart-agent-composer {
  flex: 0 0 auto;
}
@container (max-width: 799px) {
  .chart-agent-dock {
    --reply-dock-bottom: clamp(40px, calc(100% - 200px), 132px);
  }
}
@media (max-height: 650px) {
  @container (max-width: 799px) {
    .chart-agent-dock {
      --reply-dock-bottom: 78px;
    }
    .chart-map-stage :deep(.direction-legend) {
      bottom: 46px;
      gap: 1px;
      padding: 3px 6px;
      font-size: 8px;
      line-height: 11px;
    }
    .chart-map-stage :deep(.map-note) {
      bottom: 28px;
      padding: 3px 6px;
      font-size: 8px;
      line-height: 10px;
    }
    .chart-map-stage :deep(.map-note span) {
      display: inline;
      margin-left: 5px;
      font-size: 8px;
    }
    .chart-map-stage > .map-status {
      padding: 3px 6px;
      font-size: 8px;
      line-height: 11px;
    }
  }
}
.intelligence-map-choices {
  position: absolute;
  top: 18px;
  left: 18px;
  z-index: 3;
  display: grid;
  gap: 6px;
  max-width: 300px;
  padding: 12px;
  background: #09273c;
  border: 1px solid #59bdcf;
}
.intelligence-map-choices button {
  text-align: left;
}
</style>
