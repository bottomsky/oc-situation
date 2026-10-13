<script setup lang="ts">
import type { IntelligenceSourceHealth } from '@ais/contracts';
import { dateLabel } from '../utils/display';
defineProps<{ sources: IntelligenceSourceHealth[] }>();
const labels = {
  ready: '已就绪',
  stale: '数据过期',
  unavailable: '采集不可用',
  never_collected: '尚未采集',
  disabled: '已停用',
};
</script>
<template>
  <details v-if="sources.length" class="source-health-list">
    <summary>来源覆盖与采集状态（{{ sources.length }}）</summary>
    <article v-for="source in sources" :key="source.sourceId">
      <strong>{{ source.name }} · {{ labels[source.status] }}</strong>
      <p>
        最近成功 {{ dateLabel(source.lastSuccessfulAt) }} · 下次采集
        {{ dateLabel(source.nextPollAt) }}
      </p>
      <p v-if="source.lastError">{{ source.lastError }}</p>
    </article>
  </details>
</template>
<style scoped>
.source-health-list {
  color: #9fc1d2;
}
article {
  padding: 8px 0;
  border-bottom: 1px solid #275369;
}
p {
  margin: 5px 0;
  font-size: 12px;
}
</style>
