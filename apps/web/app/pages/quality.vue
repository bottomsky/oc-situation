<script setup lang="ts">
import type { Page, QuarantineObservation, SourceConfig } from '@ais/contracts';
import { queryString, dateLabel } from '../utils/display';
import type { operations } from '../types/api.generated';
type Quality =
  operations['QualityController_quality']['responses'][200]['content']['application/json'];
const { api } = usePlatform();
const quality = ref<Quality | null>(null);
const rejected = ref<Page<QuarantineObservation>>({ items: [], nextCursor: null });
const busy = ref(false);
const error = ref('');
const sources = ref<SourceConfig[]>([]);
const sourceId = ref('');
const reason = ref('');
const raw = ref<unknown>(null);
const from = ref(new Date(Date.now() - 86400000).toISOString().slice(0, 19));
const to = ref(new Date().toISOString().slice(0, 19));
function params() {
  return {
    from: new Date(from.value + 'Z').toISOString(),
    to: new Date(to.value + 'Z').toISOString(),
    sourceId: sourceId.value || undefined,
  };
}
async function load(more = false) {
  busy.value = true;
  error.value = '';
  try {
    if (!more) quality.value = await api<Quality>('/quality' + queryString(params()));
    const page = await api<Page<QuarantineObservation>>(
      '/quarantine' +
        queryString({
          ...params(),
          reason: reason.value || undefined,
          limit: 50,
          cursor: more ? (rejected.value.nextCursor ?? undefined) : undefined,
        }),
    );
    rejected.value = {
      items: more ? [...rejected.value.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    };
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function inspect(q: QuarantineObservation) {
  error.value = '';
  try {
    raw.value = await api(
      '/captures/' +
        encodeURIComponent(q.captureId) +
        queryString({ sourceId: q.sourceId, receivedAt: q.receivedAt }),
    );
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(async () => {
  await load();
  try {
    sources.value = await api<SourceConfig[]>('/sources');
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">DATA QUALITY</div>
        <h1>清洗质量</h1>
        <p>按接收时间查看规范观测及隔离记录，原始响应统计包含归档确认延迟。</p>
      </div>
    </div>
    <form class="toolbar" @submit.prevent="load(false)">
      <label>开始（UTC）<input v-model="from" type="datetime-local" step="1" required /></label
      ><label>结束（UTC）<input v-model="to" type="datetime-local" step="1" required /></label
      ><label
        >来源<select v-model="sourceId">
          <option value="">全部来源</option>
          <option v-for="s in sources" :key="s.sourceId" :value="s.sourceId">{{ s.name }}</option>
        </select></label
      ><button :disabled="busy">查询</button>
    </form>
    <FetchState :busy="busy" :error="error" @retry="load(false)" />
    <div v-if="quality" class="metric-strip">
      <div class="metric">
        <small>{{ quality.receivedCapturesLabel }}</small
        ><strong>{{ quality.receivedCaptures.toLocaleString() }}</strong>
        <p class="muted">延迟约 {{ quality.archiveLagSeconds }} 秒</p>
      </div>
      <div class="metric">
        <small>规范船位观测</small
        ><strong>{{ quality.normalizedPositions.toLocaleString() }}</strong>
      </div>
      <div class="metric">
        <small>静态观测</small><strong>{{ quality.normalizedStatic.toLocaleString() }}</strong>
      </div>
      <div class="metric">
        <small>隔离观测</small><strong>{{ quality.quarantinedEvents.toLocaleString() }}</strong>
      </div>
    </div>
    <div class="panel">
      <h2>质量标记</h2>
      <p v-if="quality" class="muted">
        {{ quality.latestPositionJumpLabel }}：{{ quality.latestPositionJumpFlags }}
        艘（当前最新船位）
      </p>
      <p class="muted">同一观测可能包含多个标记，样例记录使用 synthetic 标识。</p>
      <table>
        <thead>
          <tr>
            <th>标记</th>
            <th>观测数量</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="f in quality?.qualityFlags" :key="f.flag">
            <td class="mono">{{ f.flag }}</td>
            <td>{{ f.events.toLocaleString() }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!quality?.qualityFlags.length" class="muted">当前范围没有质量标记。</p>
    </div>
    <div class="panel">
      <div class="panel-title">
        <h2>隔离记录</h2>
        <form class="actions" @submit.prevent="load(false)">
          <input v-model="reason" aria-label="隔离原因筛选" placeholder="原因标识" /><button>
            筛选
          </button>
        </form>
      </div>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>船舶 / 事件</th>
              <th>来源</th>
              <th>接收时间</th>
              <th>隔离原因</th>
              <th>原文</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="q in rejected.items" :key="q.eventId">
              <td class="mono">
                {{ q.mmsi ?? '无有效 MMSI' }}<small>{{ q.eventId.slice(0, 19) }}…</small>
              </td>
              <td>
                {{ q.sourceId
                }}<span v-if="q.quality.includes('synthetic')" class="badge sample">样例数据</span>
              </td>
              <td>{{ dateLabel(q.receivedAt) }}</td>
              <td>{{ q.reasons.join('、') }}</td>
              <td><button @click="inspect(q)">查看原文</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!rejected.items.length" class="muted">当前范围没有隔离记录。</p>
      <button v-if="rejected.nextCursor" @click="load(true)">加载更多</button>
    </div>
    <div v-if="raw" class="panel">
      <div class="panel-title">
        <h2>原始响应</h2>
        <button @click="raw = null">关闭</button>
      </div>
      <pre class="code-view">{{ JSON.stringify(raw, null, 2) }}</pre>
    </div>
  </section>
</template>
