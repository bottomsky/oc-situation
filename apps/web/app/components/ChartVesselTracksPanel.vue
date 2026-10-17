<script setup lang="ts">
import type { Bbox, VesselTracksSelector } from '@ais/contracts';
import type { UnwrapNestedRefs } from 'vue';
import type { useVesselTracks } from '../composables/useVesselTracks';
import { heatmapDateLabel } from '../utils/display';
const props = defineProps<{
  state: UnwrapNestedRefs<ReturnType<typeof useVesselTracks>>;
  currentBounds: () => Bbox;
  sourceId?: string;
}>();
const selector = ref<VesselTracksSelector>({});
const preset = ref('24');
const from = ref('');
const to = ref('');
const error = ref('');
async function generate() {
  const now = new Date();
  const start =
    preset.value === 'custom'
      ? Date.parse(`${from.value}+08:00`)
      : now.getTime() - Number(preset.value) * 3600000;
  const end = preset.value === 'custom' ? Date.parse(`${to.value}+08:00`) : now.getTime();
  error.value = '';
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    error.value = '请填写有效时段。';
    return;
  }
  await props.state.generate(
    {
      bbox: [...props.currentBounds()],
      from: new Date(start).toISOString(),
      to: new Date(end).toISOString(),
      selector: selector.value,
      ...(props.sourceId ? { sourceId: props.sourceId } : {}),
      maxVessels: 20,
      maxPointsPerVessel: 500,
    },
    now,
  );
}
</script>
<template>
  <section class="chart-section vessel-tracks-panel" aria-label="历史航线">
    <h3>历史航线</h3>
    <p class="muted">
      选择历史时段经过生成时当前视野的船舶，展示其完整可用航线，航线可延伸到视野外。每次最多 20
      艘、每船 500 点。
    </p>
    <form @submit.prevent="generate">
      <VesselSelectorFields v-model="selector" />
      <label
        >历史时段<select v-model="preset" aria-label="航线历史时段">
          <option value="24">最近 24 小时</option>
          <option value="72">最近 3 天</option>
          <option value="168">最近 7 天</option>
          <option value="custom">自定义（北京时间）</option>
        </select></label
      >
      <template v-if="preset === 'custom'"
        ><label>开始<input v-model="from" type="datetime-local" aria-label="航线开始时间" /></label
        ><label>结束<input v-model="to" type="datetime-local" aria-label="航线结束时间" /></label
      ></template>
      <div class="actions">
        <button :disabled="state.loading">生成历史航线</button
        ><button v-if="state.loading" type="button" @click="state.cancel">取消查询</button
        ><button type="button" @click="state.close">关闭历史航线</button>
      </div>
    </form>
    <p v-if="error || state.error" class="error" role="alert">{{ error || state.error }}</p>
    <p v-if="state.loading" role="status">正在查询历史航线…</p>
    <template v-if="state.result">
      <p>
        {{ state.displayed ? '海图已展示' : '等待地图绘制' }} ·
        {{ state.result.returnedVessels }} 艘
      </p>
      <small
        >{{ heatmapDateLabel(state.result.query.from) }} ～
        {{ heatmapDateLabel(state.result.query.to) }}</small
      >
      <p v-if="state.result.hasMoreVessels">
        至少匹配 {{ state.result.matchedVesselsLowerBound }} 艘，当前仅返回
        {{ state.result.returnedVessels }} 艘；可缩小范围或补充船舶条件。
      </p>
      <p v-if="!state.result.tracks.length">
        没有符合条件的历史观测。型号资料尚未收录时，具体型号查询也可能返回空结果。
      </p>
      <p v-for="track in state.result.tracks" :key="track.mmsi">
        {{ track.name || track.mmsi }} · {{ track.returned }}/{{ track.total }} 点<span
          v-if="track.sampled"
        >
          · 已抽样</span
        ><span v-if="track.truncated"> · 数据已截断</span>
      </p>
    </template>
  </section>
</template>
<style scoped>
form,
label {
  display: grid;
  gap: 10px;
}
form {
  margin-top: 12px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
