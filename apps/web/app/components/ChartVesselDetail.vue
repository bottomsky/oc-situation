<script setup lang="ts">
import type { VesselDetail } from '@ais/contracts';
import { dateLabel } from '../utils/display';
import { resolveVesselDirection } from '../utils/vesselMarkers';
const props = defineProps<{ detail: VesselDetail }>();
const emit = defineEmits<{ playback: [] }>();
const detailDirection = computed(() => resolveVesselDirection(props.detail.latestPosition ?? {}));
</script>
<template>
  <div class="vessel-detail">
    <div class="section-rule" />
    <h2>船舶详情</h2>
    <button @click="emit('playback')">查询历史轨迹 →</button>
    <h3>{{ detail.staticFields.name || detail.mmsi }}</h3>
    <span v-if="detail.latestPosition?.quality.includes('synthetic')" class="badge sample"
      >样例数据</span
    >
    <dl class="detail-grid">
      <div>
        <dt>MMSI</dt>
        <dd class="mono">{{ detail.mmsi }}</dd>
      </div>
      <div>
        <dt>IMO</dt>
        <dd>{{ detail.staticFields.imo || '—' }}</dd>
      </div>
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
        <dd>
          {{ detail.latestPosition?.lon.toFixed(4) }},
          {{ detail.latestPosition?.lat.toFixed(4) }}
        </dd>
      </div>
      <div>
        <dt>目的地</dt>
        <dd>{{ detail.staticFields.destination || '—' }}</dd>
      </div>
      <div>
        <dt>数据来源</dt>
        <dd>{{ detail.latestPosition?.sourceId || '—' }}</dd>
      </div>
    </dl>
    <div class="detail-time">
      报告：{{ dateLabel(detail.latestPosition?.observedAt) }}<br />接收：{{
        dateLabel(detail.latestPosition?.receivedAt)
      }}<br />质量：{{ detail.latestPosition?.quality.join('、') || '有效观测' }}
    </div>
    <details>
      <summary class="muted">静态资料与字段来源</summary>
      <dl v-for="(value, field) in detail.staticFields" :key="field" class="detail-time">
        <dt>{{ field }}：{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dt>
        <dd>
          {{ detail.provenance[field]?.sourceId || '—' }} ·
          {{ dateLabel(detail.provenance[field]?.observedAt) }}
        </dd>
      </dl>
    </details>
  </div>
</template>
