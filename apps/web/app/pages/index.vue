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
import {
  readChartPreference,
  writeChartPreference,
  createChartReportPreference,
  removeManualFocusObject,
} from '../utils/chartWorkspace';
import { chartLayoutDefaults } from '../utils/chartLayout';
import { defaultChartVisibility } from '../utils/chartLayers';
import { heatmapDateLabel } from '../utils/display';
import { commandPresentation } from '../utils/agentArtifacts';
import {
  createReplyObjectState,
  createReplyObjectLocation,
  createReplyDetailReader,
  replyObjectFocus,
  provideChartDetailHost,
} from '../composables/useChartDetail';
import { buildReplyObjects } from '../utils/replyObjects';
import type { ReplyObjectViewModel } from '../types/agentReply';
import { replyDockClearance } from '../utils/chartDetailPosition';
import { isChartElementVisible } from '../utils/chartVisibility';
import {
  chartEffectKey,
  createChartEffectProjection,
  mergeChartEffectTargets,
  useChartEffects,
  resultSelectionGeometries,
  chartEffectVisualViewport,
  chartFocusEffectsReady,
} from '../composables/useChartEffects';
import { cameraOverlayRects } from '../utils/mapCamera';
import { createLiveFocusPresentation } from '../utils/liveFocus';
import { resolveVesselDirection } from '../utils/vesselMarkers';
import type {
  MapAttentionRequest,
  MapEffectBounds,
  MapEffectFrame,
  MapEffectTarget,
} from '../types/mapEffects';
const chartEffects = useChartEffects();
const effectHiddenKeys = ref<string[]>([]);
const effectMutedKeys = ref<string[]>([]);
const effectViewport = shallowRef<MapEffectBounds | null>(null);
const acknowledgedMapEffects = shallowRef<MapEffectTarget[] | null>(null);
const effectFrame = shallowRef<MapEffectFrame | null>(null);
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
const businessLoading = ref(false);
async function loadBusinessChoices() {
  const current = handoffGeneration.begin();
  businessLoading.value = true;
  handoffError.value = '';
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
  } finally {
    if (current()) businessLoading.value = false;
  }
}
function addBusinessChoice(choice: string) {
  const value = businessChoices.value.find((v) => `${v.kind}:${v.id}` === choice);
  if (value) void businessHandoff(value.kind, value.id);
}
function addShip() {
  const id = workspace.detail?.mmsi;
  if (!id || selectedShips.value.includes(id)) return;
  if (selectedBusiness.value.length + selectedShips.value.length >= 100) {
    handoffError.value = '关注集合最多100个对象，请移除部分对象后添加。';
    return;
  }
  handoffError.value = '';
  selectedShips.value.push(id);
}
function removeBusiness(object: { kind: 'route' | 'event'; id: string }) {
  selectedBusiness.value = removeManualFocusObject(
    selectedBusiness.value,
    object,
    handoffGeneration.invalidate,
  );
  businessLoading.value = false;
  handoffError.value = '';
}
function clearManualFocus() {
  handoffGeneration.invalidate();
  selectedBusiness.value = [];
  selectedShips.value = [];
  businessLoading.value = false;
  handoffError.value = '';
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
const replyDockBaseline = useTemplateRef<HTMLElement>('replyDockBaseline');
const compactToolsTarget = useTemplateRef<HTMLElement>('compactToolsTarget');
const compactFooter = ref(false);
const replySourceClearance = ref(0);
let dockObserver: ResizeObserver | undefined;
let dockMeasureFrame: number | undefined;
const observedDockElements = new Set<Element>();
function measureReplyDock() {
  dockMeasureFrame = undefined;
  const dock = agentDock.value;
  const stage = dock?.closest<HTMLElement>('.chart-map-stage');
  for (const element of observedDockElements)
    if (
      !element.isConnected ||
      (element !== stage && element !== dock && !stage?.contains(element))
    ) {
      dockObserver?.unobserve(element);
      observedDockElements.delete(element);
    }
  if (!dock || !stage || !replyDockBaseline.value) return;
  const notes = [
    ...stage.querySelectorAll<HTMLElement>(
      '[data-testid="chart-source-note"], [data-testid="direction-legend"], .maplibregl-ctrl-attrib, .maplibregl-ctrl-scale',
    ),
  ].filter((element) => isChartElementVisible(element));
  for (const element of [stage, dock, ...notes])
    if (!observedDockElements.has(element)) {
      dockObserver?.observe(element);
      observedDockElements.add(element);
    }
  const clearance = Math.ceil(
    replyDockClearance(
      stage.getBoundingClientRect().bottom,
      dock.getBoundingClientRect(),
      notes.map((note) => note.getBoundingClientRect()),
      Number.parseFloat(getComputedStyle(replyDockBaseline.value).bottom),
    ),
  );
  if (clearance !== replySourceClearance.value) replySourceClearance.value = clearance;
}
function scheduleReplyDock() {
  if (dockMeasureFrame === undefined) dockMeasureFrame = requestAnimationFrame(measureReplyDock);
}
watch(compactFooter, scheduleReplyDock, { flush: 'post' });
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
  replyObjectsState.panelOpen = false;
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
  clearReplySelection();
  const current = chartEffects.select({
    kind: 'intelligence',
    id,
    geometries: intelligence.visiblePlot.features
      .filter((feature) => feature.properties.eventId === id)
      .map((feature) => feature.geometry),
  });
  leftOpen.value = true;
  detailHost.open('intelligence', 'left');
  workspace.leftTab = 'intelligence';
  if (intelligence.activeId === id && intelligence.detail?.event.id === id)
    await intelligence.add([id]);
  else await intelligence.select(id);
  if (current())
    chartEffects.updateSelected(
      current,
      intelligence.visiblePlot.features
        .filter((feature) => feature.properties.eventId === id)
        .map((feature) => feature.geometry),
      intelligence.detail?.event.id === id ? intelligence.detail.event.version : undefined,
    );
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
const reportPreference = createChartReportPreference(
  {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
  (hours) => {
    workspace.hours = hours;
  },
);
watch(
  () => session.value?.user.id ?? null,
  (id) => {
    if (import.meta.client) reportPreference.restore(id);
  },
  { immediate: true, flush: 'sync' },
);
watch(
  () => workspace.hours,
  (hours) => {
    if (import.meta.client) reportPreference.persist(hours);
  },
  { flush: 'sync' },
);
const replyFocusMetadata = computed(() => replyObjectFocus(agent.currentReply, focus.result));
const replyObjects = computed(() => buildReplyObjects(replyFocusMetadata.value));
const replyObjectLocation = createReplyObjectLocation();
watch(
  () => [replyFocusMetadata.value, workspace.data] as const,
  ([result, fleet]) => {
    replyObjectLocation.update(
      agent.currentReply?.readable === false ? null : (result ?? null),
      fleet?.items ?? [],
    );
  },
  { immediate: true, flush: 'sync' },
);
const replyKey = computed(() =>
  [
    session.value?.user.id,
    agent.currentReply?.sessionId,
    agent.currentReply?.taskId ?? agent.currentReply?.createdAt,
    agent.currentReply?.inputRevision,
  ].join(':'),
);
const replyDetail = reactive(createReplyDetailReader());
const replyObjectsState = reactive(
  createReplyObjectState(() => {
    if (replyObjectsState.selected) {
      workspace.resetDetail();
      intelligence.resetDetail();
      replyDetail.reset();
      if (['vessel', 'intelligence'].includes(detailHost.active.value?.kind ?? ''))
        detailHost.close();
    }
  }),
);
let objectsTrigger: HTMLElement | null = null;
let objectTrigger: HTMLElement | null = null;
watch(
  replyKey,
  (key) => {
    replyObjectsState.setScope(key);
    replyDetail.reset();
  },
  { immediate: true, flush: 'sync' },
);
watch(replyObjects, (objects) => {
  if (
    replyObjectsState.selected &&
    !objects.some((object) => object.key === replyObjectsState.selected?.key)
  )
    clearReplySelection();
});
function openReplyObjects() {
  objectsTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  replyObjectsState.panelOpen = true;
  if (detailHost.active.value?.side === 'right') detailHost.close();
}
function restoreReplyFocus(target: HTMLElement | null) {
  if (
    target?.isConnected &&
    target.getClientRects().length &&
    getComputedStyle(target).visibility !== 'hidden'
  ) {
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  }
  return false;
}
async function closeReplyObjects() {
  const scope = replyKey.value;
  replyObjectsState.panelOpen = false;
  await nextTick();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  if (replyObjectsState.panelOpen || replyKey.value !== scope) return;
  const replacement =
    workspaceElement.value?.querySelector<HTMLElement>('.reply-objects-more') ?? null;
  if (!restoreReplyFocus(objectsTrigger?.isConnected ? objectsTrigger : replacement)) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (!replyObjectsState.panelOpen && replyKey.value === scope) restoreReplyFocus(replacement);
  }
}
async function closeReplyDetail() {
  const trigger = replyObjectsState.selected ? objectTrigger : null;
  detailHost.close();
  await nextTick();
  restoreReplyFocus(trigger);
}
async function selectReplyObject(object: ReplyObjectViewModel) {
  const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (trigger?.closest('.reply-object-name, .reply-object-detail') || !objectTrigger?.isConnected)
    objectTrigger = trigger;
  replyObjectsState.select(object);
  chartEffects.select({
    kind: object.ref.kind,
    id: object.ref.id,
    revision: object.ref.revision,
    geometries: object.geometries,
    observedAt: object.observedAt,
    icon: object.ref.kind === 'vessel' ? 'vessel' : 'alert',
  });
  replyDetail.reset();
  if (object.ref.kind === 'vessel') {
    const reading = replyDetail.read(object.ref.id, async (id) => {
      await workspace.select(id);
      return workspace.detailError;
    });
    detailHost.open('vessel', 'left');
    await reading;
  } else if (object.ref.kind === 'intelligence') {
    workspace.leftTab = 'intelligence';
    const reading = readReplyIntelligence(object.ref.id);
    detailHost.open('intelligence', 'left');
    await reading;
  } else {
    if (!replyObjectsState.panelOpen) openReplyObjects();
  }
}
function readReplyIntelligence(id: string) {
  return replyDetail.read(id, async (target) => {
    await intelligence.select(target, false);
    return intelligence.error;
  });
}
function locateReplyObject(object: ReplyObjectViewModel) {
  const bbox = replyObjectLocation.bounds(object);
  if (!bbox) return;
  seaMap.value?.cameraIntent({ reserveReply: true })({ mode: 'bounds', bbox, maxZoom: 10 });
}
function refreshIntelligenceDetail() {
  if (replyObjectsState.selected?.ref.kind === 'intelligence') void replyDetail.retry();
  else {
    void intelligence.select(intelligence.activeId, false);
    void intelligence.refreshPlot();
  }
}
function openReplyBusiness(object: ReplyObjectViewModel) {
  if (object.ref.kind === 'route' || object.ref.kind === 'event')
    void navigateTo(
      `/${object.ref.kind === 'route' ? 'routes' : 'events'}?id=${encodeURIComponent(object.ref.id)}`,
    );
}
function clearReplySelection() {
  if (replyObjectsState.selected) {
    workspace.resetDetail();
    intelligence.resetDetail();
    if (['vessel', 'intelligence'].includes(detailHost.active.value?.kind ?? ''))
      detailHost.close();
  }
  replyObjectsState.clearSelection();
  replyDetail.reset();
}
const route = useRoute();
const seaMap = useTemplateRef<ChartMapControls>('seaMap');
const effectsMap = computed(() =>
  seaMap.value ? createChartEffectProjection(seaMap.value, readEffectViewport) : null,
);
function readEffectViewport(view: MapEffectBounds | null) {
  const canvas = workspaceElement.value?.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
  if (!canvas) return view;
  const overlays = cameraOverlayRects<HTMLElement>(
    document.querySelectorAll<HTMLElement>('.chart-detail-float'),
    {
      fullscreen: document.fullscreenElement,
      visible: (element) => isChartElementVisible(element),
    },
  );
  return chartEffectVisualViewport(view, canvas.getBoundingClientRect(), overlays);
}
watch(effectsMap, (_value, previous) => previous?.disposeEffectProjection());
onBeforeUnmount(() => effectsMap.value?.disposeEffectProjection());
const liveEffectFocus = createLiveFocusPresentation();
const effectFocusPresentation = computed(() =>
  liveEffectFocus(
    agent.currentReply && agent.config?.spatialFocusEnabled !== false ? focus.result : null,
    workspace.data?.items ?? [],
  ),
);
const focusEffectTargets = computed<MapEffectTarget[]>(() =>
  (effectFocusPresentation.value?.targets ?? []).map((target) => {
    const point = (workspace.data?.items ?? []).find(
      (point) => point.kind === 'point' && point.mmsi === target.ref.id,
    );
    const direction = resolveVesselDirection(point?.kind === 'point' ? point : {});
    return {
      key: chartEffectKey(target.ref.kind, target.ref.id, target.ref.revision),
      kind: target.ref.kind,
      id: target.ref.id,
      revision: target.ref.revision,
      geometries: [target.geometry],
      icon:
        target.ref.kind === 'vessel'
          ? direction.directionSource === 'unknown'
            ? 'unknown'
            : 'vessel'
          : 'alert',
      observedAt: target.observedAt,
      bearing: direction.bearing,
    };
  }),
);
const effectAnchor = computed(() => {
  const bounds = effectFocusPresentation.value?.bbox;
  return bounds ? (bounds[0] + bounds[2] + (bounds[0] > bounds[2] ? 360 : 0)) / 2 : undefined;
});
const manualEffectTargets = computed<MapEffectTarget[]>(() =>
  vesselHighlights.targets.map((target) => ({
    key: chartEffectKey('vessel', target.mmsi),
    kind: 'vessel',
    id: target.mmsi,
    geometries: [{ type: 'Point', coordinates: [target.lon, target.lat] }],
    observedAt: target.observedAt,
    bearing: resolveVesselDirection(target).bearing,
    icon: resolveVesselDirection(target).directionSource === 'unknown' ? 'unknown' : 'vessel',
    effectId: target.effectId,
  })),
);
const mapEffectTargets = computed(() =>
  mergeChartEffectTargets([...manualEffectTargets.value, ...focusEffectTargets.value]),
);
const focusEffectsReady = computed(() =>
  chartFocusEffectsReady(
    focusEffectTargets.value,
    mapEffectTargets.value,
    acknowledgedMapEffects.value,
  ),
);
const effectRequests = computed<MapAttentionRequest[]>(() => {
  const batches = new Map<string, MapEffectTarget[]>();
  for (const target of manualEffectTargets.value) {
    const id = target.effectId!;
    batches.set(id, [...(batches.get(id) ?? []), target]);
  }
  const requests: MapAttentionRequest[] = [...batches].map(([id, targets]) => ({
    id,
    targets,
    icon: 'vessel',
  }));
  const value = focus.result;
  if (value && focus.displayed && agent.currentReply)
    requests.push({
      id: `focus:${value.sessionId}:${value.taskId}:${value.inputRevision}:${value.version}`,
      targets: focusEffectTargets.value,
      icon: focusEffectTargets.value.every((target) => target.key.startsWith('vessel:'))
        ? 'vessel'
        : 'alert',
    });
  return [...requests, ...chartEffects.attentionRequests.value];
});
function refreshSelectedVesselPosition() {
  chartEffects.updateVessels([
    ...(workspace.data?.items ?? []).filter((point) => point.kind === 'point'),
    ...vesselHighlights.targets,
    ...(workspace.detail?.latestPosition
      ? [{ ...workspace.detail.latestPosition, mmsi: workspace.detail.mmsi }]
      : []),
  ]);
}
watch(
  () => [workspace.data, workspace.detail?.latestPosition, vesselHighlights.targets] as const,
  refreshSelectedVesselPosition,
  { immediate: true, flush: 'sync' },
);
watch(() => chartEffects.selected.value?.key, refreshSelectedVesselPosition, { flush: 'sync' });
watch(
  () => agent.currentReply?.createdAt ?? null,
  () => {
    effectViewport.value = null;
  },
);
watch(seaMap, scheduleReplyDock, { flush: 'post' });
const handoffGeneration = createHandoffGeneration();
watch(
  () => session.value?.user.id ?? null,
  (id) => {
    chartEffects.reset();
    clearManualFocus();
    businessChoices.value = [];
    detailHost.close();
    workspace.resetAccount(Boolean(id));
  },
  { flush: 'sync' },
);
async function businessHandoff(kind: 'route' | 'event', id: string, ask = false) {
  const current = handoffGeneration.begin(),
    camera = seaMap.value?.cameraIntent();
  const existing = selectedBusiness.value.find(
    (object) => object.kind === kind && object.id === id,
  );
  const selectionCurrent = chartEffects.select({
    kind,
    id,
    revision: existing?.revision,
    geometries: existing?.geometry ? [existing.geometry] : [],
  });
  businessLoading.value = false;
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
    chartEffects.updateSelected(
      selectionCurrent,
      object.geometry ? [object.geometry] : [],
      object.revision,
    );
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
  const id = workspace.detail?.mmsi;
  const selectionCurrent = id
    ? chartEffects.select({
        kind: 'track',
        id,
        revision: `${workspace.from}:${workspace.to}`,
        geometries: [],
      })
    : null;
  await loadTrack();
  if (
    selectionCurrent &&
    workspace.track &&
    workspace.track !== previous &&
    workspace.track.mmsi === id
  ) {
    const coordinates = workspace.track.segments
      .map((segment) => segment.points.map((point): [number, number] => [point.lon, point.lat]))
      .filter((line) => line.length >= 2);
    chartEffects.updateSelected(
      selectionCurrent,
      coordinates.length ? [{ type: 'MultiLineString', coordinates }] : [],
    );
  }
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
watch(
  () => [
    detailHost.active.value,
    leftOpen.value,
    rightOpen.value,
    replyObjectsState.panelOpen,
    replySourceClearance.value,
    compactFooter.value,
    layout.value.sizes.left,
    layout.value.sizes.right,
    fullscreen.value,
  ],
  () => seaMap.value?.requestFocusRender(),
  { flush: 'post' },
);
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
    uiProjection(
      heatmap.currentEnabled || (heatmap.mode === 'historical' && !!heatmap.result),
      ['close', 'show'],
      {
        visible:
          (heatmap.currentEnabled && layers.ais !== false) ||
          (heatmap.mode === 'historical' && !!heatmap.result && heatmap.displayed),
        loading: heatmap.loading,
        interacting: selectingHeatmapRegion.value,
        revision: heatmap.closeRevision,
      },
    ),
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
useUiComponent('chart.heatmap.legend', {
  read: () =>
    uiProjection(heatmap.currentEnabled || (heatmap.mode === 'historical' && !!heatmap.result), []),
});
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
  clearReplySelection();
  chartEffects.select({ kind: 'vessel', id: mmsi, geometries: [], icon: 'vessel' });
  leftOpen.value = true;
  detailHost.open('vessel', 'left');
  void workspace.select(mmsi);
}
function selectSituationVessel(mmsi: string) {
  selectVessel(mmsi);
  workspace.leftTab = 'situation';
}
const vesselActionError = ref('');
watch(
  () => workspace.detail?.mmsi,
  () => {
    vesselActionError.value = '';
  },
);
function locateDetailVessel() {
  const position = workspace.detail?.latestPosition;
  if (
    !position ||
    !Number.isFinite(position.lon) ||
    !Number.isFinite(position.lat) ||
    position.lon < -180 ||
    position.lon > 180 ||
    position.lat < -90 ||
    position.lat > 90
  )
    return;
  seaMap.value?.cameraIntent()({ mode: 'point', center: [position.lon, position.lat], zoom: 10 });
}
function predictDetailVessel() {
  const mmsi = workspace.detail?.mmsi;
  if (prediction.busy || !mmsi || !/^[1-9]\d{8}$/.test(mmsi)) return;
  leftOpen.value = true;
  workspace.leftTab = 'prediction';
  prediction.setMmsi(mmsi);
  void prediction.run();
}
function toggleDetailVesselHighlight() {
  const detail = workspace.detail;
  if (!detail) return;
  vesselActionError.value = '';
  if (vesselHighlights.manualMmsis.includes(detail.mmsi)) {
    vesselHighlights.clearManual(detail.mmsi);
    return;
  }
  const position = detail.latestPosition;
  if (!position) return;
  try {
    vesselHighlights.addManual({
      mmsi: detail.mmsi,
      name: detail.staticFields.name || null,
      lon: position.lon,
      lat: position.lat,
      observedAt: position.observedAt,
      headingDegrees: position.headingDegrees,
      cogDegrees: position.cogDegrees,
    });
  } catch (error) {
    vesselActionError.value = error instanceof Error ? error.message : '船舶高亮失败';
  }
}
async function selectResult(result: AnalysisResult) {
  clearReplySelection();
  const current = chartEffects.select({
    kind: 'result',
    id: result.id,
    revision: result.revision,
    geometries: resultSelectionGeometries(result),
    icon: 'alert',
  });
  const focus = seaMap.value?.cameraIntent();
  rightOpen.value = true;
  detailHost.open('evidence', 'right');
  rightTab.value = 'push';
  await topics.select(result);
  if (topics.evidence?.id === result.id)
    chartEffects.updateSelected(
      current,
      resultSelectionGeometries(topics.evidence),
      topics.evidence.revision,
    );
  if (topics.evidence?.id === result.id)
    focus?.({ mode: 'bounds', bbox: topics.evidence.bbox, maxZoom: 11 });
}
function selectMapEffect(target: {
  kind: string;
  id: string;
  revision?: number | string;
  geometries: IntelligenceGeometry[];
}) {
  clearReplySelection();
  chartEffects.select(target);
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
  if (document.querySelector('dialog:modal')) return;
  if (event.key === 'Escape') {
    if (detailHost.active.value) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeReplyDetail();
      return;
    }
    if (replyObjectsState.panelOpen) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeReplyObjects();
      return;
    }
    if (agent.currentReply && !selectingHeatmapRegion.value && !selectingAgentRegion.value) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void closeCurrentReply();
      return;
    }
  }
  if (selectingHeatmapRegion.value) {
    if (event.key === 'Escape') {
      selectingHeatmapRegion.value = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    return;
  }
  if (selectingAgentRegion.value) {
    if (event.key === 'Escape') {
      selectingAgentRegion.value = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
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
  if (
    event.key === 'Escape' &&
    event.eventPhase !== Event.CAPTURING_PHASE &&
    !event.defaultPrevented &&
    !seaMap.value?.interactionState().drawing
  )
    chartEffects.clearSelection();
  if (event.key === 'Home') {
    event.preventDefault();
    seaMap.value?.resetView();
  }
  if (event.key === '+' || event.key === '=') seaMap.value?.zoomIn();
  if (event.key === '-') seaMap.value?.zoomOut();
}
function captureEscape(event: KeyboardEvent) {
  if (event.key === 'Escape') keydown(event);
}
function bubbleKeydown(event: KeyboardEvent) {
  keydown(event);
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
  dockObserver = new ResizeObserver(scheduleReplyDock);
  scheduleReplyDock();
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
  document.addEventListener('fullscreenchange', scheduleReplyDock);
  document.addEventListener('toggle', scheduleReplyDock, true);
  window.addEventListener('resize', scheduleReplyDock);
  document.addEventListener('keydown', captureEscape, true);
  document.addEventListener('keydown', bubbleKeydown);
});
onBeforeUnmount(() => {
  dockObserver?.disconnect();
  observedDockElements.clear();
  if (dockMeasureFrame !== undefined) cancelAnimationFrame(dockMeasureFrame);
  document.removeEventListener('fullscreenchange', updateFullscreen);
  document.removeEventListener('fullscreenchange', scheduleReplyDock);
  document.removeEventListener('toggle', scheduleReplyDock, true);
  window.removeEventListener('resize', scheduleReplyDock);
  document.removeEventListener('keydown', captureEscape, true);
  document.removeEventListener('keydown', bubbleKeydown);
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
    :class="{ 'left-open': leftOpen, 'right-open': rightOpen && !replyObjectsState.panelOpen }"
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
        ><template #situation
          ><ChartMaritimeSituationPanel
            :hours="workspace.hours"
            :loaded-count="workspace.data?.items.length ?? 0"
            :loading="workspace.busy"
            :paused="workspace.paused"
            :selected-ships="selectedShips"
            :vessel-names="workspace.vesselNames"
            :selected-business="selectedBusiness"
            :current-mmsi="workspace.detail?.mmsi"
            :business-choices="businessChoices"
            :business-loading="businessLoading"
            :error="handoffError"
            @apply-hours="workspace.hours = $event"
            @add-current-ship="addShip"
            @remove-ship="selectedShips = selectedShips.filter((id) => id !== $event)"
            @select-ship="selectSituationVessel"
            @load-business="loadBusinessChoices"
            @add-business="addBusinessChoice"
            @remove-business="removeBusiness"
            @clear="clearManualFocus"
        /></template>
        <template #intelligence
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
      <header class="chart-map-heading" :class="{ 'compact-footer': compactFooter }">
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
        <div ref="compactToolsTarget" class="chart-compact-tools" v-show="compactFooter" />
        <div id="chart-compact-map-status" v-show="compactFooter" />
      </header>
      <div class="chart-map-stage" :class="{ 'compact-footer': compactFooter }">
        <ClientOnly
          ><SeaMap
            ref="seaMap"
            @compact-footer="compactFooter = $event"
            :compact-tools-target="compactToolsTarget"
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
            :map-effects="mapEffectTargets"
            :effect-hidden-keys="effectHiddenKeys"
            :effect-muted-keys="effectMutedKeys"
            @blank="chartEffects.clearSelection"
            @effect-select="selectMapEffect"
            @vessel-highlights-displayed="vesselHighlights.markDisplayed"
            @map-effects-displayed="acknowledgedMapEffects = $event"
            @vessel-tracks-displayed="
              if (vesselTracks.result === $event) vesselTracks.displayed = true;
            "
            :heatmap="heatmap.mode === 'historical' ? heatmap.result : null"
            :current-density="heatmap.currentEnabled"
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
              chartEffects.select({
                kind: 'object',
                id: $event,
                geometries: intelligence.objects
                  .filter((object) => object.id === $event)
                  .flatMap((object) => (object.geometry ? [object.geometry] : [])),
              });
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
          :map="effectsMap"
          :objects="selectedBusiness"
          @select="(kind, id) => businessHandoff(kind, id)"
        />
        <ChartMapEffects
          :key="session?.user.id ?? 'anonymous'"
          :map="effectsMap"
          :selected="chartEffects.selected.value"
          :targets="mapEffectTargets"
          :requests="effectRequests"
          :viewport="effectViewport"
          :anchor-longitude="effectAnchor"
          @hidden="effectHiddenKeys = $event"
          @muted="effectMutedKeys = $event"
          @frame="effectFrame = $event"
          @settled="chartEffects.cancelAttention($event)"
        />
        <div v-if="mapChoices.length > 1" class="intelligence-map-choices">
          <strong>重叠情报 {{ mapChoices.length }} 条</strong
          ><button v-for="id in mapChoices" :key="id" @click="selectIntelligence(id)">
            {{ intelligence.plot.items.find((i) => i.eventId === id)?.title || id }}</button
          ><button @click="mapChoices = []">关闭</button>
        </div>
        <div class="chart-map-notices">
          <ChartVesselHighlights
            :groups="vesselHighlights.groups"
            :manual-mmsis="vesselHighlights.manualMmsis"
            :count="vesselHighlights.targets.length"
            :missing="vesselHighlights.missing"
            :updated-at="vesselHighlights.updatedAt"
            :error="vesselHighlights.error"
            :paused="workspace.paused"
            @clear-group="vesselHighlights.clearGroup"
            @clear-manual="vesselHighlights.clearManual"
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
            v-if="heatmap.currentEnabled"
            class="heatmap-legend"
            aria-label="当前船位密度图例"
            data-testid="current-density-legend"
          >
            <strong>当前显示船位密度</strong>
            <span
              >复用当前单船图层 ·
              {{ workspace.data?.items.filter((item) => item.kind === 'point').length ?? 0 }}
              艘</span
            >
            <span>每船权重 1；低密度 → 高密度，颜色为相对平滑强度。</span>
            <span
              >遵循地图最近
              {{ workspace.hours }} 小时观测、来源及船型筛选；加载进度与完整状态见地图状态栏。</span
            >
            <span v-if="layers.ais === false">单船图层已关闭，密度层同步隐藏。</span>
            <button @click="heatmap.close">关闭热力图</button>
          </section>
          <section
            v-if="heatmap.mode === 'historical' && heatmap.result"
            class="heatmap-legend"
            aria-label="热图统计图例"
            data-testid="heatmap-legend"
          >
            <strong>历史时段网格统计 · 每格去重船数</strong>
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
            <span
              >历史范围内去重船数，与当前船位时间口径不同；蓝 1 · 青 10 · 黄 50 · 红 ≥100
              艘，点击网格查看实际船数。</span
            >
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
          :map="effectsMap"
          :reply="agent.currentReply"
          :objects="replyObjects"
          :omitted-count="replyFocusMetadata?.omittedCount"
          :focus="agent.config?.spatialFocusEnabled === false ? null : focus.result"
          :fleet="workspace.data"
          :effect-frame="effectFrame"
          :effects-ready="focusEffectsReady"
          @viewport="effectViewport = $event"
          :layout-key="
            [
              leftOpen,
              rightOpen,
              replyObjectsState.panelOpen,
              replySourceClearance,
              compactFooter,
              layout.sizes.left,
              layout.sizes.right,
            ].join(':')
          "
          @displayed="(value, status) => focus.markDisplayed(value, status)"
          @crowded="focusCrowded = $event"
          @reference="agent.openSource"
          @object="selectReplyObject"
          @objects="openReplyObjects"
          @close="closeCurrentReply"
          @open="openCurrentConversation"
        />
        <span ref="replyDockBaseline" class="reply-dock-baseline" aria-hidden="true" />
        <div
          ref="agentDock"
          class="chart-agent-dock"
          :style="{ '--reply-source-clearance': replySourceClearance + 'px' }"
        >
          <ChartAgentComposer
            :state="agent"
            floating
            @open="openAgent"
            @submit="prepareAgentConversation"
          />
        </div>
        <Teleport to="#chart-compact-map-status" :disabled="!compactFooter" defer>
          <div
            class="map-status"
            data-testid="map-snapshot-status"
            :data-loaded="workspace.data?.items.filter((v) => v.kind === 'point').length ?? 0"
            :data-complete="
              !!workspace.data && !workspace.data.truncated && !workspace.data.sampled
            "
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
        </Teleport>
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
    <div
      v-show="rightOpen && !replyObjectsState.panelOpen"
      :inert="replyObjectsState.panelOpen"
      id="chart-right-slot"
      class="chart-right-slot"
    >
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
    <ChartAgentObjectsPanel
      :open="replyObjectsState.panelOpen"
      :objects="replyObjects"
      :omitted-count="replyFocusMetadata?.omittedCount"
      :reply-key="replyKey"
      :selected-key="replyObjectsState.selected?.key"
      @close="closeReplyObjects"
      @object="selectReplyObject"
      @locate="locateReplyObject"
      @business="openReplyBusiness"
    />
    <ChartDetailFloat
      :open="detailHost.isOpen('intelligence')"
      :layer="replyObjectsState.selected ? 70 : undefined"
      side="left"
      title="情报证据"
      subtitle="INTELLIGENCE EVIDENCE"
      aria-label="情报证据面板"
      @close="closeReplyDetail"
    >
      <p
        v-if="replyObjectsState.selected?.ref.kind === 'intelligence'"
        class="reply-object-snapshot"
        data-testid="reply-object-snapshot"
      >
        回复引用：{{ replyObjectsState.selected.label }} · 快照
        {{ replyObjectsState.selected.observedAt ?? '时间未提供' }} · 版本
        {{ replyObjectsState.selected.ref.revision ?? '未提供' }} <br />当前读取详情：{{
          intelligence.detail?.event.version ?? '加载中'
        }}
        版；引用快照与当前详情分别保留。
      </p>
      <FetchState
        v-if="!intelligence.detail"
        :busy="replyObjectsState.selected ? replyDetail.busy : !intelligence.error"
        :error="replyObjectsState.selected ? replyDetail.error : intelligence.error"
        @retry="
          replyObjectsState.selected
            ? replyDetail.retry()
            : intelligence.select(intelligence.activeId, false)
        "
      />
      <IntelligenceDetail
        v-if="intelligence.detail"
        :detail="intelligence.detail"
        :panel-visible="detailHost.isOpen('intelligence')"
        :geometry="drawnGeometry"
        :can-draw="session?.user.role !== 'viewer'"
        @history="
          replyObjectsState.selected ? readReplyIntelligence($event) : selectIntelligence($event)
        "
        @draw="seaMap?.draw($event)"
        @edit-geometry="seaMap?.editGeometry($event)"
        @refresh="refreshIntelligenceDetail"
        @locate="locateIntelligence(intelligence.activeId)"
        @revise="navigateTo('/intelligence?revise=' + $event.id)"
      />
    </ChartDetailFloat>
    <ChartDetailFloat
      :open="detailHost.isOpen('vessel')"
      :layer="replyObjectsState.selected ? 70 : undefined"
      side="left"
      title="船舶详情"
      subtitle="VESSEL INFORMATION"
      @close="closeReplyDetail"
    >
      <p
        v-if="replyObjectsState.selected?.ref.kind === 'vessel'"
        class="reply-object-snapshot"
        data-testid="reply-object-snapshot"
      >
        回复引用：{{ replyObjectsState.selected.label }} · 快照
        {{ replyObjectsState.selected.observedAt ?? '时间未提供' }} · 版本
        {{ replyObjectsState.selected.ref.revision ?? '未提供' }}
        <br />下方为当前读取的船舶资料，位置时间以详情观测为准。
      </p>
      <FetchState
        :busy="
          replyObjectsState.selected
            ? replyDetail.busy
            : !workspace.detail && !workspace.detailError
        "
        :error="replyObjectsState.selected ? replyDetail.error : workspace.detailError"
        @retry="replyObjectsState.selected && replyDetail.retry()"
      />
      <ChartVesselDetail
        v-if="workspace.detail"
        :detail="workspace.detail"
        :prediction-busy="prediction.busy"
        :highlighted="vesselHighlights.manualMmsis.includes(workspace.detail.mmsi)"
        :action-error="vesselActionError"
        @locate="locateDetailVessel"
        @predict="predictDetailVessel"
        @highlight="toggleDetailVesselHighlight"
        @playback="
          workspace.leftTab = 'playback';
          detailHost.close('vessel');
        "
      />
    </ChartDetailFloat>
  </section>
</template>
<style scoped>
.reply-object-snapshot {
  padding: 10px 12px;
  margin: 0 0 12px;
  background: #0d3043;
  border-left: 2px solid #36c8e6;
  color: #b9dce9;
  font-size: 12px;
  line-height: 1.6;
}
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
.chart-agent-dock,
.reply-dock-baseline {
  --reply-dock-bottom: 40px;
}
.reply-dock-baseline {
  position: absolute;
  bottom: var(--reply-dock-bottom);
  width: 0;
  height: 0;
  visibility: hidden;
  pointer-events: none;
}
.chart-agent-dock {
  display: flex;
  flex-direction: column;
  gap: 12px;
  bottom: max(var(--reply-dock-bottom), var(--reply-source-clearance, 0px));
  max-height: calc(100% - max(var(--reply-dock-bottom), var(--reply-source-clearance, 0px)) - 16px);
}
.chart-agent-dock > .chart-agent-composer {
  flex: 0 0 auto;
}
@container (max-width: 799px) {
  .chart-agent-dock,
  .reply-dock-baseline {
    --reply-dock-bottom: clamp(40px, calc(100% - 200px), 132px);
  }
}
@media (max-height: 650px) {
  @container (max-width: 799px) {
    .chart-agent-dock,
    .reply-dock-baseline {
      --reply-dock-bottom: 78px;
    }
    .chart-map-stage:not(.compact-footer) :deep(.direction-legend) {
      bottom: 46px;
      gap: 1px;
      padding: 3px 6px;
      font-size: 8px;
      line-height: 11px;
    }
    .chart-map-stage:not(.compact-footer) :deep(.map-note) {
      bottom: 28px;
      padding: 3px 6px;
      font-size: 8px;
      line-height: 10px;
    }
    .chart-map-stage:not(.compact-footer) :deep(.map-note span) {
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
.chart-map-heading.compact-footer {
  flex-wrap: nowrap;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scrollbar-width: thin;
}
.chart-map-heading.compact-footer > div,
.chart-map-heading.compact-footer .chart-map-actions {
  flex: 0 0 auto;
  width: auto;
}
.chart-compact-tools {
  display: flex;
  align-items: center;
}
#chart-compact-map-status {
  white-space: nowrap;
}
#chart-compact-map-status > .map-status {
  position: static;
  max-width: 100%;
  padding: 0;
  border: 0;
  background: none;
  font-size: 9px;
  line-height: 12px;
}
.chart-map-stage.compact-footer .chart-agent-dock,
.chart-map-stage.compact-footer .reply-dock-baseline {
  --reply-dock-bottom: 28px;
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
