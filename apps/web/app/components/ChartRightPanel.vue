<script setup lang="ts">
import type { AgentConversationState } from '../composables/useAgentConversation';
import { useChartDetailHost } from '../composables/useChartDetail';
import type {
  AnalysisResult,
  Bbox,
  AgentHeatmapResult,
  AgentVesselTracksResult,
} from '@ais/contracts';
const props = defineProps<{
  items: AnalysisResult[];
  busy: boolean;
  error: string;
  selecting: string;
  evidence: AnalysisResult | null;
  selectedId?: string;
  bbox: Bbox;
  agent: AgentConversationState;
}>();
const emit = defineEmits<{
  close: [];
  select: [result: AnalysisResult];
  retry: [];
  closeEvidence: [];
  locate: [result: AnalysisResult];
  revision: [result: AnalysisResult];
  heatmap: [result: AgentHeatmapResult];
  tracks: [result: AgentVesselTracksResult];
}>();
const detailHost = useChartDetailHost();
const evidenceVisible = computed(() => detailHost?.isOpen('evidence') ?? !!props.evidence);
const evidenceContent = useTemplateRef<HTMLElement>('evidenceContent');
function closeEvidence() {
  detailHost?.close('evidence');
  emit('closeEvidence');
}
const tab = defineModel<'chat' | 'push' | 'tasks'>('tab', { default: 'push' });
watch(tab, (value) => {
  if (value !== 'push') detailHost?.close('evidence');
  if (value !== 'chat') {
    detailHost?.close('sources');
    detailHost?.close('history');
  }
});
const expanded = ref(false);
const evidenceDialog = useTemplateRef<HTMLDialogElement>('evidenceDialog');
const expandTrigger = useTemplateRef<HTMLButtonElement>('expandTrigger');
async function openExpanded() {
  expanded.value = true;
  await nextTick();
  evidenceDialog.value?.showModal();
}
function closeExpanded(restoreFocus = true) {
  evidenceDialog.value?.close();
  expanded.value = false;
  if (restoreFocus) void nextTick(() => expandTrigger.value?.focus());
}
useUiComponent('chart.evidence', {
  read: () =>
    uiProjection(expanded.value || (!!props.evidence && evidenceVisible.value), ['close'], {
      order: 60,
      loading: !!props.selecting,
      focused:
        !!evidenceDialog.value?.contains(import.meta.client ? document.activeElement : null) ||
        !!evidenceContent.value?.contains(import.meta.client ? document.activeElement : null),
    }),
  execute: () => {
    if (expanded.value) closeExpanded(false);
    closeEvidence();
  },
});
function dialogClosed() {
  if (expanded.value) closeExpanded();
}
function trapDialogTab(event: KeyboardEvent) {
  if (event.key !== 'Tab' || !evidenceDialog.value?.open) return;
  const dialog = evidenceDialog.value;
  const focusable = [
    ...dialog.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, summary, [tabindex]',
    ),
  ].filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled') || !element.getClientRects().length)
      return false;
    const closedDetails = element.closest('details:not([open])');
    return !closedDetails || closedDetails.querySelector(':scope > summary') === element;
  });
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active) || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (
    !event.shiftKey &&
    (active === last || !dialog.contains(active) || active === dialog)
  ) {
    event.preventDefault();
    first.focus();
  }
}
onBeforeUnmount(() => evidenceDialog.value?.close());
watch(evidenceVisible, (visible) => {
  if (!visible && expanded.value) closeExpanded(false);
});
watch(
  () => props.evidence,
  (value) => {
    if (!value && expanded.value) closeExpanded();
  },
);
</script>
<template>
  <aside class="chart-right chart-panel" aria-label="智能体协同" data-testid="chart-right-panel">
    <header class="chart-panel-heading">
      <div class="collaboration-heading">
        <span class="collaboration-mark"><ChartIcon name="Bot" :size="24" /></span>
        <div>
          <h2>智能体协同</h2>
          <small>INTELLIGENCE COLLABORATION</small>
        </div>
      </div>
      <button aria-label="关闭协同面板" @click="emit('close')">×</button>
    </header>
    <div class="chart-tabs" role="tablist" aria-label="协同功能">
      <button role="tab" :aria-selected="tab === 'chat'" @click="tab = 'chat'">
        <ChartIcon name="MessageCircle" />AI 对话</button
      ><button role="tab" :aria-selected="tab === 'push'" @click="tab = 'push'">
        <ChartIcon name="Radio" />主动推送<span v-if="items.length" class="chart-count">{{
          items.length
        }}</span></button
      ><button role="tab" :aria-selected="tab === 'tasks'" @click="tab = 'tasks'">
        <ChartIcon name="ClipboardList" />任务中心
      </button>
    </div>
    <div class="chart-panel-scroll">
      <slot name="prediction" />
      <ChartAgentPanel
        v-if="tab === 'chat'"
        :bbox="bbox"
        :state="agent"
        @heatmap="emit('heatmap', $event)"
        @tracks="emit('tracks', $event)"
        @locate="emit('locate', $event)"
      />
      <template v-if="tab === 'push'"
        ><div class="chart-agent-intro">
          <ChartIcon name="Radar" />
          <div>
            <strong>持续专题分析</strong>
            <p>船位观测与公告原文关联 · 规则结果需人工复核</p>
          </div>
        </div>
        <FusionEvents
          :items="items"
          :busy="busy"
          :error="error"
          :selecting="selecting"
          :selected-id="selectedId"
          @select="emit('select', $event)"
          @retry="emit('retry')"
      /></template>
      <ChartTaskCenter v-if="tab === 'tasks'" />
    </div>
    <footer class="chart-right-footer">
      <span class="status-dot" />按真实数据生成专题结果 · UTC
    </footer>
    <ChartDetailFloat
      :open="!!evidence && evidenceVisible"
      side="right"
      title="结论证据"
      subtitle="ANALYSIS EVIDENCE"
      @close="closeEvidence"
    >
      <div v-if="evidence" ref="evidenceContent" class="chart-evidence-container">
        <button
          ref="expandTrigger"
          class="chart-evidence-expand"
          :aria-expanded="expanded"
          @click="openExpanded"
        >
          <ChartIcon name="Maximize" />放大阅读证据</button
        ><AnalysisEvidence
          v-if="!expanded"
          :result="evidence"
          @close="closeEvidence()"
          @locate="emit('locate', $event)"
          @revision="emit('revision', $event)"
        />
      </div>
    </ChartDetailFloat>
    <dialog
      v-if="evidence"
      ref="evidenceDialog"
      class="chart-evidence-dialog chart-evidence-container"
      aria-label="结论证据放大阅读"
      @cancel.prevent="closeExpanded()"
      @close="dialogClosed"
      @keydown="trapDialogTab"
    >
      <template v-if="expanded">
        <button class="chart-evidence-expand" autofocus @click="closeExpanded()">
          <ChartIcon name="Minus" />返回紧凑视图
        </button>
        <AnalysisEvidence
          :result="evidence"
          @close="
            closeExpanded();
            closeEvidence();
          "
          @locate="emit('locate', $event)"
          @revision="emit('revision', $event)"
        />
      </template>
    </dialog>
  </aside>
</template>

<style scoped>
.chart-right {
  container-type: inline-size;
  background: radial-gradient(ellipse at 90% 0%, #0b355040, transparent 35%), #061824;
}
.chart-panel-heading {
  min-height: 69px;
  border-bottom: 1px solid #16405a;
  background: linear-gradient(110deg, #09283bba, #06172455);
}
.collaboration-heading {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}
.collaboration-mark {
  display: grid;
  place-items: center;
  width: 31px;
  height: 35px;
  flex-shrink: 0;
  color: #5edbff;
  border-left: 2px solid #20c4e9;
}
.chart-panel-heading h2 {
  padding-left: 0;
  border-left: 0;
  font-size: 18px;
}
.chart-panel-heading small {
  padding-left: 0;
  font-size: 7px;
  letter-spacing: 1.2px;
}
.chart-tabs {
  gap: 5px;
  padding: 8px 8px 10px;
}
.chart-tabs > button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-height: 40px;
  border-radius: 6px;
  background: #061a29;
  border-color: #23465a;
}
.chart-tabs > button > svg {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
}
.chart-tabs > button[aria-selected='true'] {
  background: linear-gradient(125deg, #075376, #07344d);
  border-color: #20c8f4;
  box-shadow:
    inset 0 -2px 0 #20c8f4,
    0 0 12px #14b5d416;
}
.chart-tabs > button:focus-visible {
  outline: 2px solid #6de8ff;
  outline-offset: 2px;
}
.chart-panel-scroll {
  margin: 0 6px;
  padding-inline: 3px;
  border: 1px solid #163c51;
  border-bottom: 0;
  border-radius: 12px 12px 0 0;
  background: linear-gradient(160deg, #071f2e80, #03121c40);
}
.chart-right-footer {
  color: #6596ab;
  border-top-color: #18394c;
}
@container (max-width: 290px) {
  .chart-tabs > button {
    gap: 3px;
    font-size: 10px;
  }
  .chart-tabs > button > svg {
    width: 14px;
    height: 14px;
  }
}
</style>
