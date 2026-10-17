<script setup lang="ts">
import type { AgentConversationState } from '../composables/useAgentConversation';
import type { IntelligenceGeometry } from '@ais/contracts';
import ChartDetailFloat from './ChartDetailFloat.vue';
import { useChartDetailHost } from '../composables/useChartDetail';
const props = defineProps<{ state: AgentConversationState }>();
const emit = defineEmits<{ locate: [geometry: IntelligenceGeometry] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const sourceContent = useTemplateRef<HTMLElement>('sourceContent');
const detailHost = useChartDetailHost();
let returnFocus: HTMLElement | null = null;
watch(
  () => props.state.sourceOpen,
  async (open) => {
    if (open) {
      if (!detailHost && import.meta.client)
        returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (detailHost) {
        detailHost.open('sources', 'right');
        return;
      }
      await nextTick();
      if (props.state.sourceOpen && !dialog.value?.open) dialog.value?.showModal();
    } else {
      if (!detailHost) dialog.value?.close();
      detailHost?.close('sources');
      if (!detailHost) returnFocus?.focus({ preventScroll: true });
    }
  },
  { immediate: true },
);
watch(
  () => detailHost?.active.value,
  (active, previous) => {
    if (previous?.kind === 'sources' && active?.kind !== 'sources' && props.state.sourceOpen)
      props.state.closeSource();
  },
);
useUiComponent('agent.sources', {
  read: () =>
    uiProjection(props.state.sourceOpen, ['close'], {
      order: 70,
      loading: props.state.sourceBusy,
      focused: !!sourceContent.value?.contains(import.meta.client ? document.activeElement : null),
    }),
  execute: () => props.state.closeSource(),
});
function locate(geometry: IntelligenceGeometry) {
  props.state.closeSource();
  emit('locate', geometry);
}
onBeforeUnmount(() => {
  if (!detailHost) dialog.value?.close();
});
</script>
<template>
  <component
    :is="detailHost ? ChartDetailFloat : 'dialog'"
    ref="dialog"
    :class="{ 'intelligence-sources-dialog': !detailHost }"
    :open="detailHost ? detailHost.isOpen('sources') : undefined"
    side="right"
    title="情报引用"
    subtitle="INTELLIGENCE SOURCES"
    anchor-id="chart-right-slot"
    data-detail-kind="sources"
    aria-label="查看情报引用"
    @close="state.closeSource"
    @cancel.prevent="state.closeSource"
    @keydown.stop
    @wheel.stop
  >
    <section ref="sourceContent">
      <header v-if="!detailHost">
        <h2>情报引用</h2>
        <button type="button" @click="state.closeSource">关闭来源卡</button>
      </header>
      <p v-if="state.sourceBusy" role="status">正在核对来源引用…</p>
      <p v-if="state.sourceError" role="alert">{{ state.sourceError }}</p>
      <p v-if="state.sourceScopeNote">{{ state.sourceScopeNote }}</p>
      <IntelligenceSourceCard
        v-if="state.sourceEvidence"
        :evidence="state.sourceEvidence"
        :source-health="state.sourceHealth"
        @locate="locate"
      />
    </section>
  </component>
</template>
<style scoped>
.intelligence-sources-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(780px, calc(100vw - 28px));
  max-height: 85vh;
  overflow: auto;
  padding: 20px;
  color: #d8effc;
  background: #082436;
  border: 1px solid #38bdd7;
  border-radius: 12px;
}
.intelligence-sources-dialog::backdrop {
  background: rgb(0 12 24 / 65%);
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
h2 {
  font-size: 18px;
  margin: 0;
}
</style>
