<script setup lang="ts">
import type { AnalysisResult } from '@ais/contracts';
import type { ChartLayerVisibility, ChartMapControls } from '../types/chart';
import { readChartPreference, writeChartPreference } from '../utils/chartWorkspace';
import { chartLayoutDefaults } from '../utils/chartLayout';
import { defaultChartVisibility } from '../utils/chartLayers';
let workspace = reactive(useChartWorkspace());
const topics = reactive(useTopicResults());
const agent = reactive(useAgentConversation());
const rightTab = ref<'chat' | 'push' | 'tasks'>('chat');
const rightContent = ref<'collaboration' | 'intelligence'>('collaboration');
function openAgent() {
  rightOpen.value = true;
  prepareAgentConversation();
}
function prepareAgentConversation() {
  rightTab.value = 'chat';
  rightContent.value = 'collaboration';
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
  rightOpen.value = true;
  rightContent.value = 'intelligence';
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
const { session } = usePlatform();
const route = useRoute();
const seaMap = useTemplateRef<ChartMapControls>('seaMap');
const center = useTemplateRef<HTMLElement>('center');
const workspaceElement = useTemplateRef<HTMLElement>('workspaceElement');
const leftOpen = ref(true);
const rightOpen = ref(true);
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
function layer(key: keyof ChartLayerVisibility, enabled: boolean) {
  layers[key] = enabled;
}
function selectVessel(mmsi: string) {
  leftOpen.value = true;
  void workspace.select(mmsi);
}
function selectResult(result: AnalysisResult) {
  rightOpen.value = true;
  rightContent.value = 'collaboration';
  rightTab.value = 'push';
  void topics.select(result);
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
  leftOpen.value = readChartPreference(
    localStorage,
    session.value.user.id,
    'left',
    window.innerWidth >= 1440,
  );
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
watch([leftOpen, rightOpen], ([left, right]) => {
  if (!import.meta.client || !session.value) return;
  writeChartPreference(localStorage, session.value.user.id, 'left', left);
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
    <div id="chart-left-slot" class="chart-left-slot" :class="{ open: leftOpen }">
      <ChartLeftPanel
        v-if="leftOpen"
        v-model:workspace="workspace"
        :layers="layers"
        @close="leftOpen = false"
        @layer="layer"
        ><template #intelligence
          ><IntelligenceList
            v-model:state="intelligence"
            @select="selectIntelligence"
            @locate="locateIntelligence" /></template
      ></ChartLeftPanel>
      <nav v-else class="chart-collapsed-rail" aria-label="操作面板快捷入口">
        <button aria-label="展开操作面板" @click="leftOpen = true"><ChartIcon name="Menu" /></button
        ><button
          aria-label="打开船舶搜索"
          @click="
            leftOpen = true;
            workspace.leftTab = 'search';
          "
        >
          <ChartIcon name="Search" /></button
        ><button
          aria-label="打开图层控制"
          @click="
            leftOpen = true;
            workspace.leftTab = 'layers';
          "
        >
          <ChartIcon name="Layers" /></button
        ><button
          aria-label="打开时间回放"
          @click="
            leftOpen = true;
            workspace.leftTab = 'playback';
          "
        >
          <ChartIcon name="History" />
        </button>
      </nav>
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
        <div v-if="mapChoices.length > 1" class="intelligence-map-choices">
          <strong>重叠情报 {{ mapChoices.length }} 条</strong
          ><button v-for="id in mapChoices" :key="id" @click="selectIntelligence(id)">
            {{ intelligence.plot.items.find((i) => i.eventId === id)?.title || id }}</button
          ><button @click="mapChoices = []">关闭</button>
        </div>
        <div class="chart-map-notices">
          <FetchState :error="workspace.error" @retry="workspace.refresh" />
          <p v-if="workspace.liveError" class="error" role="status">
            专题事件补取失败：{{ workspace.liveError }}
          </p>
          <p v-if="workspace.stale" class="chart-caution" role="status">
            船位已超过 15 秒未更新，显示上次成功结果。
          </p>
        </div>
        <div ref="agentDock" class="chart-agent-dock">
          <ChartAgentReplyCard
            v-if="agent.currentReply"
            :reply="agent.currentReply"
            @close="closeCurrentReply"
            @open="openCurrentConversation"
          />
          <ChartAgentComposer
            :state="agent"
            floating
            @open="openAgent"
            @submit="prepareAgentConversation"
          />
        </div>
        <div class="map-status">
          <span class="status-dot" />{{
            workspace.data ? workspace.data.total.toLocaleString() : '—'
          }}
          艘船 · {{ workspace.busy ? '更新中' : workspace.paused ? '更新已暂停' : '持续更新'
          }}<span v-if="workspace.data?.truncated"> · 已达 5,000 元素上限，请放大视窗</span
          ><span> · UTC</span>
        </div>
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
    <div v-if="rightOpen" id="chart-right-slot" class="chart-right-slot">
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
      <aside
        v-if="intelligence.detail && rightContent === 'intelligence'"
        class="chart-right chart-panel"
        aria-label="情报证据面板"
      >
        <header class="chart-panel-heading">
          <div>
            <h2>情报证据</h2>
            <small>INTELLIGENCE EVIDENCE</small>
          </div>
          <button @click="rightOpen = false" aria-label="折叠情报详情">×</button>
        </header>
        <div class="chart-panel-scroll">
          <IntelligenceDetail
            :detail="intelligence.detail"
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
        </div>
      </aside>
      <ChartRightPanel
        v-else
        v-model:tab="rightTab"
        :agent="agent"
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
        @locate="topics.locate"
        @revision="topics.revision"
      />
    </div>
  </section>
</template>

<style scoped>
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
