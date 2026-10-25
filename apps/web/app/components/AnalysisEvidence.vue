<script setup lang="ts">
import type { AnalysisResult } from '@ais/contracts';
import { dateLabel, confidenceLabel } from '../utils/display';
const props = withDefaults(
  defineProps<{ result: AnalysisResult; presentation?: 'standalone' | 'embedded' }>(),
  { presentation: 'standalone' },
);
const emit = defineEmits<{
  close: [];
  locate: [result: AnalysisResult];
  revision: [result: AnalysisResult];
}>();
const { api } = usePlatform();
const revisions = ref<AnalysisResult[]>([]);
const revisionError = ref('');
const artifactError = ref('');
const artifactBusy = ref(false);
const artifact = ref<unknown>(null);
const active = ref(props.result);
const synthetic = computed(() =>
  active.value.evidence.ais.some((point) => {
    const raw = point.raw as { quality?: string[] } | null;
    return Array.isArray(raw?.quality) && raw.quality.includes('synthetic');
  }),
);
let request = 0;
watch(
  () => props.result,
  async (result) => {
    const current = ++request;
    const sameResult = active.value.id === result.id;
    active.value = result;
    artifact.value = null;
    artifactError.value = '';
    if (sameResult && revisions.value.length) return;
    revisions.value = [];
    revisionError.value = '';
    try {
      const response = await api<{ items: AnalysisResult[] }>(
        '/analysis/results/' + encodeURIComponent(result.id) + '/revisions',
      );
      if (current === request) revisions.value = response.items;
    } catch (e) {
      if (current === request) revisionError.value = (e as Error).message;
    }
  },
  { immediate: true },
);
function showRevision(result: AnalysisResult) {
  artifact.value = null;
  artifactError.value = '';
  active.value = result;
  emit('revision', result);
  emit('locate', result);
}
async function loadArtifact() {
  artifactBusy.value = true;
  artifactError.value = '';
  const selected = active.value;
  try {
    const response = await api(
      '/analysis/results/' +
        encodeURIComponent(selected.id) +
        '/artifact?revision=' +
        selected.revision,
    );
    if (active.value.id === selected.id && active.value.revision === selected.revision)
      artifact.value = response;
  } catch (e) {
    artifactError.value = (e as Error).message;
  } finally {
    artifactBusy.value = false;
  }
}
</script>
<template>
  <section
    class="analysis-evidence detail-content"
    :data-presentation="presentation"
    aria-label="结论证据"
  >
    <header v-if="presentation === 'standalone'" class="analysis-evidence-heading">
      <div>
        <div class="detail-eyebrow">ANALYSIS EVIDENCE</div>
        <h2 class="detail-title">结论证据</h2>
      </div>
      <button type="button" @click="emit('close')">关闭证据</button>
    </header>
    <div class="detail-hero">
      <div class="detail-eyebrow">结论与判读</div>
      <h3 class="detail-title">{{ active.title }}</h3>
      <div class="detail-meta">
        <span class="detail-status">{{ confidenceLabel(active.confidence) }}</span>
        <span
          class="detail-status"
          :data-tone="active.status === 'withdrawn' ? 'warning' : undefined"
        >
          修订 {{ active.revision }} ·
          {{
            active.status === 'withdrawn'
              ? '已撤回'
              : active.status === 'revised'
                ? '已修订'
                : '有效'
          }}
        </span>
        <span v-if="synthetic" class="detail-status" data-tone="warning">样例数据 · 合成观测</span>
      </div>
      <p class="detail-summary">{{ active.summary }}</p>
      <dl class="detail-fields">
        <div>
          <dt>MMSI</dt>
          <dd class="mono">{{ active.mmsi }}</dd>
        </div>
        <div>
          <dt>规则版本</dt>
          <dd>{{ active.definitionVersion }}</dd>
        </div>
        <div class="analysis-evidence-full-field">
          <dt>查询时刻 · UTC</dt>
          <dd>{{ dateLabel(active.evidence.queriedAt) }}</dd>
        </div>
      </dl>
      <div class="detail-actions">
        <button type="button" class="detail-action-primary" @click="emit('locate', active)">
          <ChartIcon name="Compass" :size="14" />定位海图
        </button>
      </div>
    </div>
    <aside
      v-if="active.evidence.limitations.length"
      class="analysis-evidence-caution"
      aria-label="判读限制"
    >
      <strong>判读限制</strong>
      <p v-for="limit in active.evidence.limitations" :key="limit">{{ limit }}</p>
    </aside>
    <ChartDetailSection v-if="active.artifactRef" title="本修订预测工件" eyebrow="MODEL ARTIFACT">
      <button type="button" :disabled="artifactBusy" @click="loadArtifact">
        {{ artifactBusy ? '正在读取…' : '读取本修订预测工件' }}
      </button>
      <p v-if="artifactError" class="analysis-evidence-error" role="alert">{{ artifactError }}</p>
      <details v-if="artifact" class="detail-disclosure">
        <summary>固定修订 {{ active.revision }} · 模型工件</summary>
        <pre class="detail-code">{{ JSON.stringify(artifact, null, 2) }}</pre>
      </details>
    </ChartDetailSection>
    <div class="analysis-evidence-sources">
      <ChartDetailSection
        title="原始 AIS 观测"
        eyebrow="AIS OBSERVATIONS"
        :meta="`${active.evidence.ais.length} 条证据记录 · UTC`"
      >
        <p v-if="!active.evidence.ais.length" class="detail-empty">本结论未附带 AIS 观测记录。</p>
        <div v-else class="analysis-evidence-table" tabindex="0" aria-label="AIS 观测记录">
          <table>
            <thead>
              <tr>
                <th>记录 / 时间</th>
                <th>位置 / 航速</th>
                <th>原始数据</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="point in active.evidence.ais" :key="point.recordId">
                <td>
                  <span class="mono">{{ point.recordId }}</span
                  ><small>{{ dateLabel(point.occurredAt) }}</small>
                </td>
                <td>
                  {{ point.longitude.toFixed(4) }}, {{ point.latitude.toFixed(4)
                  }}<small>{{ point.speedOverGround ?? '—' }} kn · {{ point.mmsi }}</small>
                </td>
                <td>
                  <details class="detail-disclosure">
                    <summary>查看记录</summary>
                    <pre class="detail-code">{{ JSON.stringify(point.raw, null, 2) }}</pre>
                    <template v-if="point.staticEvidence"
                      ><h4>船型静态依据</h4>
                      <pre class="detail-code">{{
                        JSON.stringify(point.staticEvidence, null, 2)
                      }}</pre>
                    </template>
                  </details>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </ChartDetailSection>
      <ChartDetailSection
        title="公告原文片段"
        eyebrow="DOCUMENT SOURCES"
        :meta="`${active.evidence.documents.length} 份来源公告`"
      >
        <p v-if="!active.evidence.documents.length" class="detail-empty">本结论未附带公告原文。</p>
        <article
          v-for="doc in active.evidence.documents"
          :key="doc.id"
          class="analysis-evidence-document"
        >
          <h4>{{ doc.title }}</h4>
          <p class="detail-meta">
            {{ doc.sourceId }} · 文档版本 {{ doc.version }} · {{ doc.status }}
          </p>
          <p class="detail-meta">
            有效期 {{ dateLabel(doc.effectiveFrom) }} →
            {{ doc.effectiveTo ? dateLabel(doc.effectiveTo) : '持续有效' }}
          </p>
          <blockquote v-for="paragraph in doc.paragraphs" :key="paragraph.id" class="detail-quote">
            <small class="mono">{{ paragraph.id }}</small
            >{{ paragraph.text }}
          </blockquote>
          <details class="detail-disclosure">
            <summary>归档标识与原始公告</summary>
            <p class="mono">{{ doc.archiveKey || doc.id }}</p>
            <pre class="detail-code">{{ JSON.stringify(doc.raw, null, 2) }}</pre>
          </details>
        </article>
      </ChartDetailSection>
    </div>
    <ChartDetailSection
      title="算法规则与中间事实"
      eyebrow="DERIVATION"
      :meta="`${active.evidence.steps.length} 个推导步骤`"
    >
      <p v-if="!active.evidence.steps.length" class="detail-empty">本结论未附带推导步骤。</p>
      <ol v-else class="analysis-evidence-steps">
        <li v-for="step in active.evidence.steps" :key="step.id">
          <strong>{{ step.rule }}</strong>
          <p>{{ step.outcome }}</p>
          <small class="detail-meta mono"
            >证据引用：{{ step.references.join(' · ') || '无附加引用' }}</small
          >
        </li>
      </ol>
      <details class="detail-disclosure">
        <summary>运行参数与时空窗口</summary>
        <pre class="detail-code">{{
          JSON.stringify(
            { from: active.from, to: active.to, ...active.evidence.parameters },
            null,
            2,
          )
        }}</pre>
      </details>
    </ChartDetailSection>
    <ChartDetailSection title="版本修订记录" eyebrow="REVISION HISTORY">
      <p v-if="revisionError" class="analysis-evidence-error" role="alert">{{ revisionError }}</p>
      <div class="analysis-evidence-revisions">
        <button
          v-for="revision in revisions"
          :key="revision.revision"
          type="button"
          :aria-pressed="revision.revision === active.revision"
          @click="showRevision(revision)"
        >
          修订 {{ revision.revision }} · {{ dateLabel(revision.updatedAt) }} ·
          {{
            revision.status === 'withdrawn'
              ? '已撤回'
              : revision.status === 'revised'
                ? '已修订'
                : '有效'
          }}
        </button>
      </div>
    </ChartDetailSection>
  </section>
</template>

<style scoped>
.analysis-evidence {
  min-width: 0;
}
.analysis-evidence-heading {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--detail-line, #224b5d);
}
.analysis-evidence-heading > div {
  min-width: 0;
}
.analysis-evidence-heading > button {
  flex-shrink: 0;
}
.analysis-evidence-full-field {
  grid-column: 1 / -1;
}
.analysis-evidence-caution {
  display: grid;
  gap: 6px;
  padding: 12px 14px;
  border-left: 2px solid #ba9456;
  color: #e2ca9c;
  background: #30291dba;
}
.analysis-evidence-caution strong {
  font-size: 12px;
}
.analysis-evidence-caution p {
  font-size: 12px;
}
.analysis-evidence-sources {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  column-gap: 24px;
  min-width: 0;
}
.analysis-evidence-table {
  min-width: 0;
  overflow: auto;
  scrollbar-width: thin;
  scrollbar-color: #326378 transparent;
}
.analysis-evidence-table table {
  width: 100%;
  border-collapse: collapse;
  font-size: 11px;
}
.analysis-evidence-table th,
.analysis-evidence-table td {
  padding: 10px 8px;
  border-bottom: 1px solid var(--detail-line, #224b5d);
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.analysis-evidence-table th {
  color: #86aebe;
  font-weight: 500;
  background: #0a28377a;
}
.analysis-evidence-table td {
  color: #c5dce5;
}
.analysis-evidence-table small {
  display: block;
  margin-top: 5px;
  color: #86aebe;
  line-height: 1.6;
}
.analysis-evidence-table .detail-code {
  width: 240px;
  max-width: 100%;
}
.analysis-evidence-document {
  display: grid;
  gap: 8px;
  min-width: 0;
}
.analysis-evidence-document + .analysis-evidence-document {
  padding-top: 16px;
  margin-top: 16px;
  border-top: 1px solid var(--detail-line, #224b5d);
}
.analysis-evidence-document h4 {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: #d7ecf4;
}
.analysis-evidence-steps {
  display: grid;
  gap: 16px;
  padding-left: 22px;
  margin: 0;
}
.analysis-evidence-steps li::marker {
  color: #65bacd;
  font-variant-numeric: tabular-nums;
}
.analysis-evidence-steps strong {
  font-size: 12px;
  color: #c5e4ed;
}
.analysis-evidence-steps p {
  margin: 5px 0;
}
.analysis-evidence-revisions {
  display: grid;
  gap: 6px;
}
.analysis-evidence-revisions button {
  justify-content: flex-start;
  text-align: left;
}
.analysis-evidence-revisions button[aria-pressed='true'] {
  border-color: #4cb7cd;
  background: #103848;
  color: #c6f4fc;
}
.analysis-evidence-error {
  padding: 9px 12px;
  border-left: 2px solid #d38476;
  color: #ffc0b5;
  background: #382027;
}
</style>
