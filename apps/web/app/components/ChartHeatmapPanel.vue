<script setup lang="ts">
import type { Bbox, HeatmapQuery } from '@ais/contracts';
import type { UnwrapNestedRefs } from 'vue';
import type { useAisHeatmap } from '../composables/useAisHeatmap';
const props = defineProps<{
  state: UnwrapNestedRefs<ReturnType<typeof useAisHeatmap>>;
  bbox: Bbox;
  currentBounds: () => Bbox;
  region: Bbox | null;
  drawing: boolean;
  sourceId?: string;
  shipType?: string;
}>();
const emit = defineEmits<{ draw: []; region: [bbox: Bbox]; stop: [] }>();
const preset = ref('24');
const from = ref('');
const to = ref('');
const error = ref('');
const settingsOpen = ref(false);
const draft = reactive({ preset: '24', from: '', to: '' });
const settingsError = ref('');
const conditions = computed(() => [
  {
    key: 'time',
    label:
      preset.value === 'custom'
        ? `时间：${from.value.replace('T', ' ')} 至 ${to.value.replace('T', ' ')} 北京时间`
        : `时间：最近${Number(preset.value) / 24}天`,
  },
  { key: 'region', label: props.region ? '范围：已选区域' : '范围：生成时的当前视野' },
]);
function openSettings() {
  Object.assign(draft, { preset: preset.value, from: from.value, to: to.value });
  settingsError.value = '';
  settingsOpen.value = true;
}
function applySettings() {
  const start = Date.parse(`${draft.from}+08:00`);
  const end = Date.parse(`${draft.to}+08:00`);
  if (
    draft.preset === 'custom' &&
    (!Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      end - start > 168 * 3600000 ||
      start < Date.now() - 30 * 86400000 ||
      end > Date.now())
  ) {
    settingsError.value = '请选择最近30天内的有效时段，最长7天，结束时间不能晚于现在。';
    return;
  }
  preset.value = draft.preset;
  from.value = draft.from;
  to.value = draft.to;
  settingsOpen.value = false;
}
function generate() {
  error.value = '';
  const now = Date.now();
  const start =
    preset.value === 'custom'
      ? Date.parse(`${from.value}+08:00`)
      : now - Number(preset.value) * 3600000;
  const end = preset.value === 'custom' ? Date.parse(`${to.value}+08:00`) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    error.value = '请填写有效的开始和结束时间。';
    return;
  }
  const query: HeatmapQuery = {
    bbox: [...(props.region ?? props.currentBounds())],
    from: new Date(start).toISOString(),
    to: new Date(end).toISOString(),
    ...(props.sourceId ? { sourceId: props.sourceId } : {}),
    ...(props.shipType ? { shipType: Number(props.shipType) } : {}),
  };
  void props.state.generate(query);
}
</script>
<template>
  <section class="chart-section heatmap-panel" aria-label="AIS 热力图">
    <h3>AIS 热力图</h3>
    <p class="muted">统计历史时段内每格去重船数。同一船可经过多个格；全区域总数独立去重。</p>
    <ChartConditionSummary
      title="统计条件"
      settings-label="设置热图统计条件"
      :items="conditions"
      :removable="false"
      @settings="openSettings"
    />
    <ChartSettingsDialog
      v-model="settingsOpen"
      title="热图统计条件设置"
      :sections="[{ id: 'time', label: '时间范围' }]"
      @apply="applySettings"
      @reset="
        Object.assign(draft, { preset: '24', from: '', to: '' });
        settingsError = '';
      "
    >
      <div class="settings-fields">
        <h3>时间范围</h3>
        <label
          >统计时段<select v-model="draft.preset" aria-label="热图统计时段">
            <option value="24">最近 24 小时</option>
            <option value="72">最近 3 天</option>
            <option value="168">最近 7 天</option>
            <option value="custom">自定义时间</option>
          </select></label
        >
        <template v-if="draft.preset === 'custom'"
          ><label
            >开始（北京时间）<input
              v-model="draft.from"
              type="datetime-local"
              aria-label="热图开始时间" /></label
          ><label
            >结束（北京时间）<input
              v-model="draft.to"
              type="datetime-local"
              aria-label="热图结束时间" /></label
        ></template>
        <p v-if="settingsError" class="error" role="alert">{{ settingsError }}</p>
      </div>
    </ChartSettingsDialog>
    <p class="muted">
      保留最近 30 天数据，单次最长 7 天。数据来源与船型在下方“观测筛选”中设置，船型按当前资料口径。
    </p>
    <div class="heatmap-actions">
      <button @click="emit('region', [...currentBounds()])">热图使用当前视野</button
      ><button :disabled="drawing" @click="emit('draw')">热图矩形框选</button
      ><button v-if="drawing" @click="emit('stop')">取消热图框选</button>
    </div>
    <p v-if="region" class="mono">已选范围：{{ region.map((n) => n.toFixed(2)).join('，') }}</p>
    <p v-else class="muted">生成时固定当前视野；平移和缩放保持统计范围。</p>
    <div class="heatmap-actions">
      <button :disabled="state.loading || drawing" @click="generate">
        {{ state.result ? '更新热力图' : '生成热力图' }}</button
      ><button v-if="state.loading" @click="state.cancel">取消加载</button
      ><button :disabled="!state.result && !state.loading" @click="state.close">关闭热力图</button>
    </div>
    <p v-if="state.loading" role="status">正在计算热力图…</p>
    <p v-if="error || state.error" role="alert" class="error">{{ error || state.error }}</p>
    <p v-if="state.result" data-testid="heatmap-summary">
      {{ state.displayed ? '海图已展示' : '计算完成，等待地图绘制' }} ·
      {{ state.result.totalVessels }} 艘 · {{ state.result.cells.length }} 个非空格
    </p>
    <p v-if="state.result && !state.result.cells.length">
      所选范围和时段内没有符合条件的 AIS 观测。
    </p>
  </section>
</template>
<style scoped>
.heatmap-panel {
  display: grid;
  gap: 12px;
}
.heatmap-panel label {
  display: grid;
  gap: 6px;
}
.heatmap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.heatmap-panel p {
  margin: 0;
}
</style>
