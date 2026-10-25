<script setup lang="ts">
import type { HighlightGroup } from '@ais/contracts';
defineProps<{
  groups: HighlightGroup[];
  manualMmsis?: string[];
  count: number;
  missing: string[];
  updatedAt?: string;
  error: string;
  paused: boolean;
}>();
defineEmits<{ clearGroup: [groupId: string]; clearManual: [mmsi: string]; clearAll: [] }>();
function time(value?: string) {
  return value ? `${new Date(value).toISOString().slice(11, 19)} UTC` : '使用当前已知船位';
}
</script>

<template>
  <details
    v-if="groups.length || manualMmsis?.length"
    class="vessel-highlight-control"
    data-testid="vessel-highlights-control"
  >
    <summary>船舶高亮 · {{ count }} 艘 <span>管理</span></summary>
    <div class="vessel-highlight-body">
      <p>船位更新：{{ time(updatedAt) }}{{ paused ? ' · 更新已暂停' : '' }}</p>
      <p v-if="error" role="status">{{ error }}</p>
      <p v-if="missing.length" role="status">
        缺少有效船位：{{ missing.join('、') }}；保留已有位置。
      </p>
      <ul>
        <li v-for="mmsi in manualMmsis" :key="`manual:${mmsi}`">
          <span>人工高亮 · {{ mmsi }}</span>
          <button
            type="button"
            :aria-label="`清除人工高亮 ${mmsi}`"
            @click="$emit('clearManual', mmsi)"
          >
            清除
          </button>
        </li>
        <li v-for="(group, index) in groups" :key="group.groupId" :data-group-id="group.groupId">
          <span :title="group.taskId">任务 {{ index + 1 }} · {{ group.mmsis.length }} 艘</span>
          <button
            type="button"
            :aria-label="`清除任务 ${index + 1} 高亮`"
            @click="$emit('clearGroup', group.groupId)"
          >
            清除
          </button>
        </li>
      </ul>
      <button type="button" data-testid="vessel-highlights-clear-all" @click="$emit('clearAll')">
        清除全部高亮
      </button>
    </div>
  </details>
</template>

<style scoped>
.vessel-highlight-control {
  max-width: min(320px, calc(100vw - 40px));
  color: #b9dce9;
  background: #061d2bea;
  border: 1px solid #19718b;
  border-radius: 7px;
  font-size: 12px;
  pointer-events: auto;
}
summary {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 9px 12px;
  cursor: pointer;
  color: #94edff;
}
summary span {
  margin-left: auto;
  font-size: 11px;
  color: #8bafc1;
}
.vessel-highlight-body {
  padding: 0 12px 12px;
  max-height: min(45vh, 320px);
  overflow-y: auto;
}
p {
  margin: 8px 0;
  overflow-wrap: anywhere;
}
ul {
  list-style: none;
  margin: 10px 0;
  padding: 0;
}
li {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 6px 0;
}
li span {
  flex: 1;
}
button {
  border: 1px solid #21627b;
  color: #bceaff;
  background: #0b2e41;
  border-radius: 4px;
  padding: 5px 9px;
  cursor: pointer;
}
button:hover {
  border-color: #2ed5f5;
  background: #10465e;
}
button:focus-visible,
summary:focus-visible {
  outline: 2px solid #52dfff;
  outline-offset: 2px;
}
</style>
