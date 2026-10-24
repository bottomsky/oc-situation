<script setup lang="ts">
import type { PredictionRecord } from '../composables/useReachability';
import { dateLabel } from '../utils/display';
defineProps<{ record: PredictionRecord }>();
const emit = defineEmits<{ evidence: [id: string] }>();
</script>
<template>
  <section class="prediction-impacts" aria-label="预测影响与证据">
    <header>
      <small>WARNING INTERSECTION</small>
      <h3>航警相交影响</h3>
      <span>目标 {{ record.prediction.mmsi }} · 未校准</span>
    </header>
    <p v-if="record.stale" class="impact-stale">结果已过期，请重新计算后评估当前态势。</p>
    <p v-if="!record.impacts.length" class="muted">当前结果未提供适用航警的相交记录。</p>
    <article v-for="impact in record.impacts" :key="impact.warningId">
      <div>
        <strong>{{ (impact.probability * 100).toFixed(1) }}<small>%</small></strong
        ><span>进入适用区域的模型概率</span>
      </div>
      <p :title="impact.warningId">
        {{
          record.evidence?.documents.find((doc) => doc.id === impact.documentId)?.title ??
          '适用航警'
        }}
        · {{ impact.documentId?.slice(0, 12) }}
      </p>
      <div class="impact-meter"><i :style="{ width: impact.probability * 100 + '%' }" /></div>
      <p>
        命中路径 {{ impact.hitPaths }} / {{ impact.totalPaths }}<br />95% 蒙特卡洛区间
        {{ (impact.confidenceInterval[0] * 100).toFixed(1) }}–{{
          (impact.confidenceInterval[1] * 100).toFixed(1)
        }}%
      </p>
      <p v-if="impact.firstEntry">
        首次进入时间窗<br />{{ dateLabel(impact.firstEntry.from) }}<br />至
        {{ dateLabel(impact.firstEntry.to) }}
      </p>
      <p v-if="impact.relationId">
        适用关系 {{ impact.relationId }} · 修订 {{ impact.relationRevision }}
      </p>
      <button
        :disabled="!impact.documentId"
        @click="if (impact.documentId) emit('evidence', impact.documentId);"
      >
        查看航警证据 ↗
      </button>
    </article>
    <details open>
      <summary>数据与证据引用</summary>
      <p>
        AIS {{ record.evidence?.ais.length ?? 0 }} 条 · 文档
        {{ record.evidence?.documents.length ?? 0 }} 份
      </p>
      <button
        v-for="doc in record.evidence?.documents"
        :key="doc.id"
        @click="emit('evidence', doc.id)"
      >
        {{ doc.title || doc.id }} ↗
      </button>
      <p v-for="(step, index) in record.evidence?.steps" :key="index">
        {{ step.rule }} · {{ step.outcome }} · {{ step.detail }}
      </p>
      <p v-for="note in record.evidence?.limitations" :key="note" class="muted">{{ note }}</p>
    </details>
  </section>
</template>
<style scoped>
.prediction-impacts {
  padding: 16px;
  color: #b7d4de;
  background: #082033;
  border-bottom: 1px solid #284a60;
  font-size: 11px;
}
.prediction-impacts header small {
  font:
    9px Georgia,
    serif;
  letter-spacing: 0.15em;
  color: #d6ae6d;
}
.prediction-impacts h3 {
  margin: 5px 0;
  color: #e6d6ac;
  font-size: 17px;
}
.prediction-impacts article {
  border: 1px solid #665539;
  border-left: 2px solid #d1a35c;
  background: #252b2d;
  padding: 12px;
  margin-top: 12px;
}
.prediction-impacts article > div:first-child {
  display: flex;
  align-items: center;
  gap: 12px;
}
.prediction-impacts strong {
  font-size: 29px;
  font-weight: 500;
  color: #f2cb88;
}
.prediction-impacts strong small {
  font-size: 13px;
}
.prediction-impacts p {
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.impact-meter {
  height: 4px;
  background: #384345;
}
.impact-meter i {
  display: block;
  height: 100%;
  background: #e2af59;
}
.prediction-impacts button {
  display: block;
  padding: 5px 0;
  color: #74cfda;
  background: transparent;
  border: 0;
  text-align: left;
  font-size: 11px;
  cursor: pointer;
}
.prediction-impacts details {
  margin-top: 16px;
}
.prediction-impacts summary {
  cursor: pointer;
  color: #a4cfda;
}
.impact-stale {
  color: #dfb46b;
}
</style>
