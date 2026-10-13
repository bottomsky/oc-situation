<script setup lang="ts">
import type { AgentMessage } from '@ais/contracts';
const props = defineProps<{ message: AgentMessage & { resultVersion?: number | null } }>();
const emit = defineEmits<{
  reference: [reference: string, taskId: string, resultVersion: number];
}>();
const parts = computed(() => props.message.content.split(/(\[I[1-9]\d{0,3}\])/g));
function select(part: string) {
  if (props.message.taskId && props.message.resultVersion != null)
    emit('reference', part.slice(1, -1), props.message.taskId, props.message.resultVersion);
}
</script>
<template>
  <span class="agent-message-text"
    ><template v-for="(part, index) in parts" :key="index"
      ><button
        v-if="
          message.role === 'assistant' &&
          /^\[I[1-9]\d{0,3}\]$/.test(part) &&
          message.taskId &&
          message.resultVersion != null
        "
        type="button"
        class="intelligence-reference"
        :aria-label="`查看情报来源 ${part}`"
        @click="select(part)"
      >
        {{ part }}</button
      ><span
        v-else-if="message.role === 'assistant' && /^\[I[1-9]\d{0,3}\]$/.test(part)"
        title="该历史引用未保存结果版本，无法定位来源"
        >{{ part }}（版本未记录）</span
      ><template v-else>{{ part }}</template></template
    ></span
  >
</template>
<style scoped>
.agent-message-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.intelligence-reference {
  display: inline;
  color: #6cdeee;
  font: inherit;
  padding: 0 2px;
  border: 0;
  background: transparent;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.intelligence-reference:focus-visible {
  outline: 2px solid #67dcee;
}
</style>
