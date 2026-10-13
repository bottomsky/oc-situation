<script setup lang="ts">
import type {
  IntelligenceEvidence,
  IntelligenceSearchResult,
  IntelligenceSource,
} from '@ais/contracts';
import { MARINE_SAMPLE_POINTS } from '@ais/contracts';
import { dateLabel } from '../utils/display';
defineProps<{ sources: IntelligenceSource[] }>();
const { api } = usePlatform();
const keyword = ref('');
const sourceId = ref('');
const kind = ref('events');
const timeMode = ref('published');
const from = ref('');
const to = ref('');
const samplePointId = ref('');
const result = ref<IntelligenceSearchResult | null>(null);
const busy = ref(false);
const error = ref('');
let generation = 0;
const evidence = computed<IntelligenceEvidence[]>(() => [
  ...(result.value?.items ?? []).map((event, index) => ({
    kind: 'event' as const,
    reference: `I${index + 1}`,
    event,
  })),
  ...(result.value?.forecasts ?? []).map((forecast, index) => ({
    kind: 'marine' as const,
    reference: `I${(result.value?.items.length ?? 0) + index + 1}`,
    forecast,
  })),
]);
async function search() {
  const turn = ++generation;
  busy.value = true;
  error.value = '';
  result.value = null;
  try {
    const query = new URLSearchParams({ kind: kind.value, limit: '50', timeMode: timeMode.value });
    if (keyword.value.trim()) query.set('keyword', keyword.value.trim());
    if (sourceId.value) query.set('sourceIds', sourceId.value);
    if (samplePointId.value) query.set('samplePointId', samplePointId.value);
    const start = from.value ? Date.parse(`${from.value}+08:00`) : null;
    const end = to.value ? Date.parse(`${to.value}+08:00`) : null;
    if (
      (start !== null && !Number.isFinite(start)) ||
      (end !== null && !Number.isFinite(end)) ||
      (start !== null &&
        end !== null &&
        (start >= end || (kind.value === 'marine' && end - start > 72 * 3600000)))
    )
      throw new Error(
        kind.value === 'marine'
          ? '请填写有效时段，海况预报窗口最长 72 小时。'
          : '请填写起点早于终点的时段。',
      );
    if (start !== null)
      query.set(kind.value === 'marine' ? 'forecastFrom' : 'from', new Date(start).toISOString());
    if (end !== null)
      query.set(kind.value === 'marine' ? 'forecastTo' : 'to', new Date(end).toISOString());
    const response = await api<IntelligenceSearchResult>(`/intelligence/search?${query}`);
    if (turn === generation) result.value = response;
  } catch (e) {
    if (turn === generation) error.value = (e as Error).message;
  } finally {
    if (turn === generation) busy.value = false;
  }
}
onBeforeUnmount(() => {
  generation++;
});
</script>
<template>
  <section class="panel" aria-label="本地情报检索">
    <h2>检索已入库情报</h2>
    <p class="muted">检索不会发起外部采集；结果保留来源、时间依据与原文归档。</p>
    <form class="editor-grid" @submit.prevent="search">
      <label>主题<input v-model="keyword" aria-label="检索情报主题" maxlength="300" /></label
      ><label
        >检索类型<select v-model="kind" aria-label="本地情报类型">
          <option value="events">事件与公告</option>
          <option value="marine">海况预报</option>
          <option value="both">事件与海况</option>
        </select></label
      ><label
        >来源<select v-model="sourceId">
          <option value="">全部来源</option>
          <option v-for="source in sources" :key="source.sourceId" :value="source.sourceId">
            {{ source.name }}
          </option>
        </select></label
      ><label v-if="kind !== 'marine'"
        >时间依据<select v-model="timeMode">
          <option value="published">原文发布</option>
          <option value="observed">索引观测</option>
          <option value="effective">适用时间</option>
        </select></label
      ><label v-if="kind !== 'events'"
        >海况代表点<select v-model="samplePointId">
          <option value="">全部代表点</option>
          <option v-for="point in MARINE_SAMPLE_POINTS" :key="point.id" :value="point.id">
            {{ point.name }}
          </option>
        </select></label
      ><label>开始（北京时间）<input v-model="from" type="datetime-local" /></label
      ><label>结束（北京时间）<input v-model="to" type="datetime-local" /></label>
      <div class="wide">
        <button :disabled="busy">{{ busy ? '检索中…' : '检索情报' }}</button>
      </div>
    </form>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <template v-if="result"
      ><p>
        事件 {{ result.total }} 条 · 海况 {{ result.forecasts.length }} 组 · 查询时间
        {{ dateLabel(result.asOf) }}
      </p>
      <p v-if="result.spec.locationKeyword" class="muted">
        {{ result.spec.locationKeyword }}：粗略检索范围，非官方海域界线；文字提及不代表已确认位置。
      </p>
      <p v-for="note in result.coverageNotes" :key="note" class="muted">{{ note }}</p>
      <p v-if="result.nextCursor" class="muted">
        当前展示前 {{ result.items.length }} 条事件，请缩小条件检索更多相关结果。
      </p>
      <IntelligenceSourceHealth :sources="result.sourceHealth" />
      <p v-if="!evidence.length" class="empty-copy">未找到匹配结果。</p>
      <details v-for="item in evidence" :key="item.reference" class="search-evidence">
        <summary>
          {{ item.kind === 'event' ? item.event.title : item.forecast.pointName + ' · 海况预报' }}
        </summary>
        <IntelligenceSourceCard
          :evidence="item"
          :source-health="result.sourceHealth"
          :locatable="false"
        /></details
    ></template>
  </section>
</template>
<style scoped>
.search-evidence {
  margin-top: 14px;
  padding: 14px;
  border: 1px solid #275369;
  border-radius: 5px;
}
.search-evidence > summary {
  cursor: pointer;
  margin-bottom: 10px;
  color: #84d7e8;
}
</style>
