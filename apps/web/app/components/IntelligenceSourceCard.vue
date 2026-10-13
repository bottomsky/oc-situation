<script setup lang="ts">
import type {
  IntelligenceEvidence,
  IntelligenceGeometry,
  IntelligenceSourceHealth,
} from '@ais/contracts';
import { dateLabel } from '../utils/display';
import { safeOriginalUrl } from '../utils/intelligenceLabels';
const props = withDefaults(
  defineProps<{
    evidence: IntelligenceEvidence;
    sourceHealth?: IntelligenceSourceHealth[];
    locatable?: boolean;
  }>(),
  { locatable: true },
);
const emit = defineEmits<{ locate: [geometry: IntelligenceGeometry] }>();
const { api } = usePlatform();
const archive = ref('');
const archiveBusy = ref(false);
const archiveError = ref('');
let archiveGeneration = 0;
const item = computed(() =>
  props.evidence.kind === 'event' ? props.evidence.event : props.evidence.forecast,
);
const health = computed(() =>
  props.sourceHealth?.find((source) => source.sourceId === item.value.sourceId),
);
const healthLabels = {
  ready: '已就绪',
  stale: '数据过期',
  unavailable: '采集不可用',
  never_collected: '尚未采集',
  disabled: '已停用',
};
const basisLabels = {
  publication: '原文发布时间',
  'index-observation': '索引观测时间',
  effective: '发生 / 适用时间',
  unknown: '时间依据未知',
};
const geometry = computed<IntelligenceGeometry | null>(() =>
  props.evidence.kind === 'event'
    ? props.evidence.event.geometry
    : {
        type: 'Point',
        coordinates: [props.evidence.forecast.point.lon, props.evidence.forecast.point.lat],
      },
);
async function readArchive() {
  if (!item.value.originalArchiveId) return;
  const revision = ++archiveGeneration;
  archiveBusy.value = true;
  archive.value = '';
  archiveError.value = '';
  try {
    const response = await api<{ content: string }>(
      `/intelligence/archives/${encodeURIComponent(item.value.originalArchiveId)}`,
    );
    if (revision === archiveGeneration) archive.value = response.content;
  } catch (e) {
    if (revision === archiveGeneration) archiveError.value = (e as Error).message;
  } finally {
    if (revision === archiveGeneration) archiveBusy.value = false;
  }
}
watch(
  () => props.evidence,
  () => {
    archiveGeneration++;
    archive.value = '';
    archiveError.value = '';
    archiveBusy.value = false;
  },
);
onBeforeUnmount(() => {
  archiveGeneration++;
});
</script>
<template>
  <article class="intelligence-source-card" aria-label="情报来源卡">
    <template v-if="evidence.kind === 'event'">
      <h3>[{{ evidence.reference }}] {{ evidence.event.title }}</h3>
      <p>{{ evidence.event.summary }}</p>
      <p v-if="evidence.event.snippet">{{ evidence.event.snippet }}</p>
      <p>
        {{ evidence.event.sourceName }} ·
        {{ evidence.event.visibility === 'public' ? '公开来源' : '内部来源' }} ·
        {{
          evidence.event.reviewStatus === 'candidate'
            ? '候选情报 · 待核实'
            : evidence.event.reviewStatus === 'confirmed'
              ? '已核实'
              : '已拒绝'
        }}
      </p>
      <p v-if="evidence.event.status === 'withdrawn'" class="warning">该情报已撤回</p>
      <dl>
        <dt>原文发布</dt>
        <dd>{{ dateLabel(evidence.event.publishedAt) }}</dd>
        <dt>
          {{ evidence.event.timeBasis === 'index-observation' ? '索引观测' : '来源观测 / 更新' }}
        </dt>
        <dd>{{ dateLabel(evidence.event.observedAt) }}</dd>
        <dt>采集入库</dt>
        <dd>{{ dateLabel(evidence.event.collectedAt) }}</dd>
        <dt>时间依据</dt>
        <dd>{{ basisLabels[evidence.event.timeBasis] }}</dd>
        <dt>发生 / 适用时段</dt>
        <dd>
          {{ dateLabel(evidence.event.effectiveFrom) }} →
          {{ dateLabel(evidence.event.effectiveTo) }}
        </dd>
      </dl>
      <p>
        {{
          evidence.event.locationNote ||
          (evidence.event.geometry ? '位置依据为已登记几何' : '暂无可定位的已知位置')
        }}
      </p>
    </template>
    <template v-else>
      <h3>[{{ evidence.reference }}] {{ evidence.forecast.pointName }} · 海况预报</h3>
      <p>
        {{ evidence.forecast.visibility === 'public' ? '公开来源' : '内部来源' }} · 固定代表点预报
      </p>
      <dl>
        <dt>采集入库</dt>
        <dd>{{ dateLabel(evidence.forecast.fetchedAt) }}</dd>
        <dt>模型发布时间</dt>
        <dd>{{ dateLabel(evidence.forecast.modelPublishedAt) }}</dd>
        <dt>预报适用时段</dt>
        <dd>
          {{ dateLabel(evidence.forecast.validFrom) }} → {{ dateLabel(evidence.forecast.validTo) }}
        </dd>
        <dt>代表点</dt>
        <dd>{{ evidence.forecast.point.lon }}°, {{ evidence.forecast.point.lat }}°</dd>
        <dt>模型网格</dt>
        <dd>{{ evidence.forecast.grid.lon }}°, {{ evidence.forecast.grid.lat }}°</dd>
      </dl>
      <div class="forecast-table">
        <table>
          <thead>
            <tr>
              <th>预报时间</th>
              <th>浪高(m)</th>
              <th>浪向(°)</th>
              <th>周期(s)</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="hour in evidence.forecast.series" :key="hour.validAt">
              <td>{{ dateLabel(hour.validAt) }}</td>
              <td>{{ hour.waveHeight ?? '—' }}</td>
              <td>{{ hour.waveDirection ?? '—' }}</td>
              <td>{{ hour.wavePeriod ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
    <div v-if="health" class="source-health">
      <strong>来源状态：{{ healthLabels[health.status] }}</strong>
      <p>
        最近成功 {{ dateLabel(health.lastSuccessfulAt) }} · 下次采集
        {{ dateLabel(health.nextPollAt) }}
      </p>
      <p v-if="health.lastError" class="warning">{{ health.lastError }}</p>
    </div>
    <div class="source-actions">
      <a
        v-if="safeOriginalUrl(item.originalUrl ?? undefined)"
        :href="safeOriginalUrl(item.originalUrl ?? undefined)"
        target="_blank"
        rel="noopener noreferrer"
        >查看来源原文</a
      ><button
        v-if="item.originalArchiveId"
        type="button"
        :disabled="archiveBusy"
        @click="readArchive"
      >
        {{ archiveBusy ? '正在读取…' : '查看归档原文' }}</button
      ><button v-if="geometry && locatable" type="button" @click="emit('locate', geometry)">
        定位已知位置
      </button>
    </div>
    <p v-if="archiveError" role="alert" class="warning">{{ archiveError }}</p>
    <pre v-if="archive" class="archive-text" aria-label="情报归档原文">{{ archive }}</pre>
  </article>
</template>
<style scoped>
.intelligence-source-card {
  display: grid;
  gap: 12px;
  overflow-wrap: anywhere;
}
h3,
p {
  margin: 0;
}
h3 {
  font-size: 16px;
  color: #d8f5ff;
}
p {
  line-height: 1.7;
}
dl {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 7px 14px;
  margin: 0;
}
dt {
  color: #8bb2c7;
}
dd {
  margin: 0;
}
.warning {
  color: #e9bf84;
}
.source-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  align-items: center;
}
a {
  color: #75dcec;
}
.forecast-table {
  max-height: 260px;
  overflow: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
}
th,
td {
  text-align: left;
  padding: 6px;
  border-bottom: 1px solid #275369;
}
.archive-text {
  white-space: pre-wrap;
  max-height: 340px;
  overflow: auto;
  font-size: 12px;
  background: #051b2b;
  padding: 12px;
}
.source-health {
  background: #10354a;
  padding: 10px;
}
</style>
