<script setup lang="ts">
import { canOperate, dateLabel, statusLabel } from '../utils/display';
const { session } = usePlatform();
const {
  instances,
  selectedId,
  runs,
  error,
  runsError,
  busy,
  runsBusy,
  submitting,
  loadedId,
  selected,
  pending,
  canRun,
  load,
  loadRuns,
  run,
} = useChartTasks();
</script>
<template>
  <section class="chart-task-center" aria-label="任务中心" data-testid="chart-task-center">
    <div class="section-heading">
      <h2>专题任务</h2>
      <button :disabled="busy" @click="load">刷新专题</button>
    </div>
    <FetchState :busy="busy" :error="error" @retry="load" />
    <p v-if="!busy && !instances.length" class="empty-copy">
      暂无专题实例。前往专题管理配置算法与关注范围。
    </p>
    <button
      v-for="instance in instances"
      :key="instance.id"
      class="chart-task-item"
      :aria-pressed="selectedId === instance.id"
      @click="selectedId = instance.id"
    >
      <strong>{{ instance.name }}</strong
      ><span>{{
        { disabled: '已停用', warming: '历史预热中', ready: '持续分析中', degraded: '运行受限' }[
          instance.status
        ]
      }}</span
      ><small>最后运行 {{ dateLabel(instance.lastRunAt) }}</small>
    </button>
    <section v-if="selected" class="chart-section chart-selected-task">
      <h3>{{ selected.name }} · 运行记录</h3>
      <p>
        范围 {{ selected.config.bbox.join(', ') }} · 周期 {{ selected.config.scheduleSeconds }} 秒
      </p>
      <p v-if="selected.lastError" class="error">{{ selected.lastError }}</p>
      <FetchState :busy="runsBusy" :error="runsError" @retry="loadRuns" />
      <p v-if="loadedId !== selectedId && !runsBusy" class="chart-caution">
        运行状态待确认，刷新成功后可提交分析。
      </p>
      <button :disabled="runsBusy" @click="loadRuns">刷新运行状态</button>
      <button v-if="canOperate(session?.user.role)" :disabled="!canRun" @click="run">
        {{ submitting ? '提交中' : pending ? '已有运行等待完成' : '立即分析' }}
      </button>
      <p v-if="!selected.enabled" class="muted">专题启用后可提交分析。</p>
      <article v-for="item in runs" :key="item.id" class="chart-run">
        <strong>{{ statusLabel[item.status] }} · {{ item.trigger }}</strong
        ><small>{{ dateLabel(item.createdAt) }}</small>
        <p v-if="item.error" class="error">{{ item.error }}</p>
      </article>
      <p v-if="!runsBusy && !runs.length" class="muted">该专题暂无运行记录。</p>
    </section>
    <nav class="chart-task-links" aria-label="任务管理入口">
      <NuxtLink to="/topics">专题管理 →</NuxtLink><NuxtLink to="/jobs">采集任务 →</NuxtLink
      ><NuxtLink to="/runs">运行记录 →</NuxtLink>
    </nav>
  </section>
</template>
