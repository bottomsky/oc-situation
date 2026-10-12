<script setup lang="ts">
import type { AnalysisResult } from '@ais/contracts';
import { dateLabel } from '../utils/display';
const props = defineProps<{ result: AnalysisResult }>();
const emit = defineEmits<{
  close: [];
  locate: [result: AnalysisResult];
  revision: [result: AnalysisResult];
}>();
const { api } = usePlatform();
const revisions = ref<AnalysisResult[]>([]);
const revisionError = ref('');
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
  active.value = result;
  emit('revision', result);
  emit('locate', result);
}
</script>
<template>
  <section class="evidence-panel panel" aria-label="结论证据">
    <div class="section-heading">
      <div>
        <div class="eyebrow">EVIDENCE / 来源与推导</div>
        <h2>结论证据</h2>
      </div>
      <div class="actions">
        <button @click="emit('locate', active)">定位海图</button
        ><button @click="emit('close')">关闭证据</button>
      </div>
    </div>
    <h3>{{ active.title }}</h3>
    <span v-if="synthetic" class="badge sample">样例数据 · 合成观测</span>
    <p>{{ active.summary }}</p>
    <div class="evidence-meta">
      <span class="badge"
        >修订 {{ active.revision }} ·
        {{
          active.status === 'withdrawn' ? '已撤回' : active.status === 'revised' ? '已修订' : '有效'
        }}</span
      ><span>规则版本 {{ active.definitionVersion }}</span
      ><span>MMSI {{ active.mmsi }}</span
      ><span>查询时刻 {{ dateLabel(active.evidence.queriedAt) }}</span>
    </div>
    <div v-if="active.evidence.limitations.length" class="evidence-caution">
      <strong>判读限制</strong>
      <p v-for="limit in active.evidence.limitations" :key="limit">{{ limit }}</p>
    </div>
    <div class="evidence-columns">
      <section>
        <h3>原始 AIS 观测</h3>
        <p class="muted">{{ active.evidence.ais.length }} 条证据记录 · UTC</p>
        <div class="table-scroll evidence-table">
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
                  <details>
                    <summary>查看记录</summary>
                    <pre class="code-view">{{ JSON.stringify(point.raw, null, 2) }}</pre>
                    <template v-if="point.staticEvidence"
                      ><h4>船型静态依据</h4>
                      <pre class="code-view">{{
                        JSON.stringify(point.staticEvidence, null, 2)
                      }}</pre>
                    </template>
                  </details>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h3>公告原文片段</h3>
        <article v-for="doc in active.evidence.documents" :key="doc.id" class="document-evidence">
          <h4>{{ doc.title }}</h4>
          <p class="muted">{{ doc.sourceId }} · 文档版本 {{ doc.version }} · {{ doc.status }}</p>
          <p class="detail-time">
            有效期 {{ dateLabel(doc.effectiveFrom) }} →
            {{ doc.effectiveTo ? dateLabel(doc.effectiveTo) : '持续有效' }}
          </p>
          <blockquote v-for="paragraph in doc.paragraphs" :key="paragraph.id">
            <small class="mono">{{ paragraph.id }}</small
            >{{ paragraph.text }}
          </blockquote>
          <details>
            <summary>归档标识与原始公告</summary>
            <p class="mono">{{ doc.archiveKey || doc.id }}</p>
            <pre class="code-view">{{ JSON.stringify(doc.raw, null, 2) }}</pre>
          </details>
        </article>
      </section>
    </div>
    <section>
      <h3>算法规则与中间事实</h3>
      <ol class="rule-steps">
        <li v-for="step in active.evidence.steps" :key="step.id">
          <strong>{{ step.rule }}</strong>
          <p>{{ step.outcome }}</p>
          <small class="mono">证据引用：{{ step.references.join(' · ') || '无附加引用' }}</small>
        </li>
      </ol>
      <details>
        <summary>运行参数与时空窗口</summary>
        <pre class="code-view">{{
          JSON.stringify(
            { from: active.from, to: active.to, ...active.evidence.parameters },
            null,
            2,
          )
        }}</pre>
      </details>
    </section>
    <section>
      <h3>版本修订记录</h3>
      <p v-if="revisionError" class="error" role="alert">{{ revisionError }}</p>
      <div class="revision-list">
        <button
          v-for="revision in revisions"
          :key="revision.revision"
          :class="{ selected: revision.revision === active.revision }"
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
    </section>
  </section>
</template>
