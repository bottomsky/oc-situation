<script setup lang="ts">
import type { VesselDetail } from '@ais/contracts';
import { dateLabel } from '../utils/display';
import { resolveVesselDirection } from '../utils/vesselMarkers';
const props = defineProps<{
  detail: VesselDetail;
  predictionBusy?: boolean;
  highlighted?: boolean;
  actionError?: string;
}>();
const emit = defineEmits<{ playback: []; locate: []; predict: []; highlight: [] }>();
const detailDirection = computed(() => resolveVesselDirection(props.detail.latestPosition ?? {}));
const positionAvailable = computed(() => {
  const position = props.detail.latestPosition;
  return (
    !!position &&
    Number.isFinite(position.lon) &&
    Number.isFinite(position.lat) &&
    position.lon >= -180 &&
    position.lon <= 180 &&
    position.lat >= -90 &&
    position.lat <= 90
  );
});
const validMmsi = computed(() => /^[1-9]\d{8}$/.test(props.detail.mmsi));
</script>
<template>
  <div class="vessel-detail detail-content">
    <header class="detail-hero">
      <p class="detail-eyebrow">VESSEL PROFILE</p>
      <h3 class="detail-title">{{ detail.staticFields.name || detail.mmsi }}</h3>
      <div class="detail-meta">
        <span class="mono">MMSI {{ detail.mmsi }}</span>
        <span
          v-if="detail.latestPosition?.quality.includes('synthetic')"
          class="detail-status"
          data-tone="warning"
          >样例数据</span
        >
        <span v-if="!detail.latestPosition" class="detail-status" data-tone="warning"
          >暂无船位</span
        >
      </div>
      <div class="detail-actions">
        <button type="button" :disabled="!positionAvailable" @click="emit('locate')">定位</button>
        <button type="button" :disabled="predictionBusy || !validMmsi" @click="emit('predict')">
          航迹预测
        </button>
        <button
          type="button"
          :aria-pressed="!!highlighted"
          :disabled="!highlighted && (!positionAvailable || !validMmsi)"
          @click="emit('highlight')"
        >
          {{ highlighted ? '取消高亮' : '高亮' }}
        </button>
        <button type="button" class="detail-action-primary" @click="emit('playback')">
          查询历史轨迹 <span aria-hidden="true">→</span>
        </button>
      </div>
      <p v-if="actionError" role="status" class="detail-action-error">{{ actionError }}</p>
    </header>

    <ChartDetailSection title="船舶标识" eyebrow="IDENTIFICATION">
      <dl class="detail-fields">
        <div>
          <dt>MMSI</dt>
          <dd class="mono">{{ detail.mmsi }}</dd>
        </div>
        <div>
          <dt>IMO</dt>
          <dd class="mono">{{ detail.staticFields.imo || '—' }}</dd>
        </div>
      </dl>
    </ChartDetailSection>

    <ChartDetailSection title="航行信息" eyebrow="NAVIGATION">
      <dl class="detail-fields">
        <div>
          <dt>航速 / 对地航向</dt>
          <dd>
            {{ detail.latestPosition?.sogKnots ?? '—' }} kn /
            {{ detail.latestPosition?.cogDegrees ?? '—' }}°
          </dd>
        </div>
        <div>
          <dt>地图方向</dt>
          <dd>{{ detailDirection.directionLabel }}</dd>
        </div>
        <div>
          <dt>坐标</dt>
          <dd class="mono">
            <template v-if="detail.latestPosition">
              {{ detail.latestPosition.lon.toFixed(4) }},
              {{ detail.latestPosition.lat.toFixed(4) }}
            </template>
            <template v-else>—</template>
          </dd>
        </div>
        <div>
          <dt>目的地</dt>
          <dd>{{ detail.staticFields.destination || '—' }}</dd>
        </div>
      </dl>
    </ChartDetailSection>

    <ChartDetailSection title="观测与来源" eyebrow="OBSERVATION">
      <dl class="detail-fields vessel-observation">
        <div>
          <dt>数据来源</dt>
          <dd>{{ detail.latestPosition?.sourceId || '—' }}</dd>
        </div>
        <div>
          <dt>报告时间 · UTC</dt>
          <dd class="mono">{{ dateLabel(detail.latestPosition?.observedAt) }}</dd>
        </div>
        <div>
          <dt>接收时间 · UTC</dt>
          <dd class="mono">{{ dateLabel(detail.latestPosition?.receivedAt) }}</dd>
        </div>
        <div>
          <dt>观测质量</dt>
          <dd>
            {{
              detail.latestPosition
                ? detail.latestPosition.quality.join('、') || '有效观测'
                : '暂无观测记录'
            }}
          </dd>
        </div>
      </dl>
    </ChartDetailSection>

    <details class="detail-disclosure vessel-provenance">
      <summary>静态资料与字段来源</summary>
      <dl class="detail-fields">
        <div v-for="(value, field) in detail.staticFields" :key="field">
          <dt>{{ field }}</dt>
          <dd>{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dd>
          <dd class="detail-meta">
            {{ detail.provenance[field]?.sourceId || '—' }} ·
            {{ dateLabel(detail.provenance[field]?.observedAt) }}
          </dd>
        </div>
      </dl>
    </details>
  </div>
</template>
<style scoped>
.detail-actions button[aria-pressed='true'] {
  border-color: #57d8ef;
  color: #e1fbff;
  background: #17617b66;
}
.detail-action-error {
  margin: 10px 0 0;
  color: #f3c98c;
  font-size: 12px;
}
.vessel-observation,
.vessel-provenance .detail-fields {
  grid-template-columns: minmax(0, 1fr);
}
.vessel-provenance .detail-meta {
  margin-top: 5px;
  font-size: 11px;
}
</style>
