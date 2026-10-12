<script setup lang="ts">
import type { ChartSource } from '../composables/useChartWorkspace';
import { dateLabel } from '../utils/display';
defineProps<{
  total: number | null;
  conclusionCount: number;
  liveStatus: string;
  paused: boolean;
  sources: ChartSource[];
  sourceError: string;
}>();
const emit = defineEmits<{ refreshSources: [] }>();
</script>
<template>
  <section class="chart-status-strip" aria-label="态势数据状态">
    <div class="chart-stat">
      <ChartIcon name="Ship" />
      <div>
        <small>视野船舶</small
        ><strong>{{ total === null ? '—' : total.toLocaleString() }}<em>艘</em></strong>
      </div>
    </div>
    <div class="chart-stat">
      <ChartIcon name="Radio" />
      <div>
        <small>最近专题结论 · 上限 30</small><strong>{{ conclusionCount }}<em>条</em></strong>
      </div>
    </div>
    <div class="chart-stat chart-connection">
      <span :class="['status-dot', { offline: liveStatus !== 'live' }]" />
      <div>
        <small>平台实时连接</small
        ><strong>{{
          paused
            ? '显示已暂停'
            : liveStatus === 'live'
              ? '已连接'
              : liveStatus === 'connecting'
                ? '连接中'
                : '接口补取'
        }}</strong>
      </div>
    </div>
    <details class="chart-source-status">
      <summary>
        来源状态
        <span
          >{{ sources.filter((s) => s.status === 'enabled').length }} /
          {{ sources.length }} 已启用</span
        >
      </summary>
      <div class="chart-source-popover">
        <p v-if="sourceError" class="error" role="alert">{{ sourceError }}</p>
        <button @click="emit('refreshSources')">刷新来源状态</button>
        <p v-if="!sources.length">暂无来源配置</p>
        <article v-for="source in sources" :key="source.sourceId">
          <strong>{{ source.name }}</strong
          ><span>{{
            { enabled: '配置已启用', disabled: '已停用', error: '配置异常' }[source.status]
          }}</span
          ><small>最近接收 {{ dateLabel(source.lastReceivedAt) }}</small>
          <p v-if="source.lastError" class="error">{{ source.lastError }}</p>
          <p v-if="source.sourceKind === 'aisstream' && source.status === 'disabled'">
            AISStream 已停用，管理员需确认本地 API Key 与来源授权后启用。
          </p>
        </article>
        <NuxtLink to="/sources">查看来源管理 →</NuxtLink>
      </div>
    </details>
  </section>
</template>
