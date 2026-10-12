<script setup lang="ts">
import type { AgentConversationState } from '../composables/useAgentConversation';
import type { AnalysisResult, Bbox } from '@ais/contracts';
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
}>();
const tab = defineModel<'chat' | 'push' | 'tasks'>('tab', { default: 'push' });
const expanded = ref(false);
const evidenceDialog = useTemplateRef<HTMLDialogElement>('evidenceDialog');
const expandTrigger = useTemplateRef<HTMLButtonElement>('expandTrigger');
async function openExpanded() {
  expanded.value = true;
  await nextTick();
  evidenceDialog.value?.showModal();
}
function closeExpanded() {
  evidenceDialog.value?.close();
  expanded.value = false;
  void nextTick(() => expandTrigger.value?.focus());
}
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
watch(
  () => props.evidence,
  (value) => {
    if (value) tab.value = 'push';
    else if (expanded.value) closeExpanded();
  },
);
</script>
<template>
  <aside class="chart-right chart-panel" aria-label="智能体协同" data-testid="chart-right-panel">
    <header class="chart-panel-heading">
      <div>
        <h2>智能体协同</h2>
        <small>INTELLIGENCE COLLABORATION</small>
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
      <ChartAgentPanel
        v-if="tab === 'chat'"
        :bbox="bbox"
        :state="agent"
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
        <div v-if="evidence" class="chart-evidence-container">
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
            @close="emit('closeEvidence')"
            @locate="emit('locate', $event)"
            @revision="emit('revision', $event)"
          />
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
    <dialog
      v-if="evidence"
      ref="evidenceDialog"
      class="chart-evidence-dialog chart-evidence-container"
      aria-label="结论证据放大阅读"
      @cancel.prevent="closeExpanded"
      @close="dialogClosed"
      @keydown="trapDialogTab"
    >
      <template v-if="expanded">
        <button class="chart-evidence-expand" autofocus @click="closeExpanded">
          <ChartIcon name="Minus" />返回紧凑视图
        </button>
        <AnalysisEvidence
          :result="evidence"
          @close="
            closeExpanded();
            emit('closeEvidence');
          "
          @locate="emit('locate', $event)"
          @revision="emit('revision', $event)"
        />
      </template>
    </dialog>
  </aside>
</template>
