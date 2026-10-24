<script setup lang="ts">
import type { AnalysisResult } from '@ais/contracts';
import { dateLabel, confidenceLabel } from '../utils/display';
defineProps<{
  items: AnalysisResult[];
  busy: boolean;
  error: string;
  selecting: string;
  selectedId?: string;
}>();
const emit = defineEmits<{ select: [result: AnalysisResult]; retry: [] }>();
</script>
<template>
  <section class="fusion-events" data-testid="fusion-events" aria-label="专题事件">
    <div class="section-heading">
      <h2>专题事件</h2>
      <NuxtLink class="text-link" to="/topics">管理专题 →</NuxtLink>
    </div>
    <FetchState :busy="busy" :error="error" @retry="emit('retry')" />
    <p v-if="!busy && !error && !items.length" class="empty-copy">
      暂无分析结论。专题根据实际船位与公告生成关联结果。
    </p>
    <p v-if="error && items.length" class="muted">以下为上次成功加载的结果。</p>
    <button
      v-for="item in items"
      :key="item.id"
      class="fusion-event"
      :aria-label="item.title"
      :disabled="selecting === item.id"
      :aria-pressed="selectedId === item.id"
      @click="emit('select', item)"
    >
      <span class="event-meta"
        ><span
          :class="['badge', item.status === 'withdrawn' ? 'status-error' : 'status-running']"
          >{{
            item.status === 'withdrawn'
              ? '已撤回'
              : item.status === 'revised'
                ? '已修订'
                : confidenceLabel(item.confidence)
          }}</span
        ><span>修订 {{ item.revision }}</span></span
      >
      <strong>{{ item.title }}</strong
      ><span>{{ item.summary }}</span
      ><small class="mono">{{ item.mmsi }} · {{ dateLabel(item.updatedAt) }}</small
      ><span class="event-open">查看证据 →</span>
    </button>
  </section>
</template>
