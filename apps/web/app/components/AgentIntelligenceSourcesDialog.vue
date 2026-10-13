<script setup lang="ts">
import type { AgentConversationState } from '../composables/useAgentConversation';
import type { IntelligenceGeometry } from '@ais/contracts';
const props = defineProps<{ state: AgentConversationState }>();
const emit = defineEmits<{ locate: [geometry: IntelligenceGeometry] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
let returnFocus: HTMLElement | null = null;
watch(
  () => props.state.sourceOpen,
  async (open) => {
    if (open) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      await nextTick();
      if (props.state.sourceOpen && !dialog.value?.open) dialog.value?.showModal();
    } else {
      dialog.value?.close();
      returnFocus?.focus({ preventScroll: true });
    }
  },
);
function locate(geometry: IntelligenceGeometry) {
  props.state.closeSource();
  emit('locate', geometry);
}
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog
    ref="dialog"
    class="intelligence-sources-dialog"
    aria-label="查看情报引用"
    @cancel.prevent="state.closeSource"
    @keydown.stop
    @wheel.stop
  >
    <header>
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
  </dialog>
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
