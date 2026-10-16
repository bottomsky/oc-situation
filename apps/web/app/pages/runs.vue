<script setup lang="ts">
import type { RunRecord, Page } from '@ais/contracts';
import { dateLabel, statusLabel, queryString } from '../utils/display';
const { api } = usePlatform();
const data = ref<Page<RunRecord>>({ items: [], nextCursor: null });
const busy = ref(false);
const error = ref('');
const status = ref('');
const sourceId = ref('');
const selected = ref<RunRecord | null>(null);
const route = useRoute();
let timer: ReturnType<typeof setInterval>;
async function load(more = false) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const page = await api<Page<RunRecord>>(
      '/runs' +
        queryString({
          status: status.value || undefined,
          sourceId: sourceId.value || undefined,
          limit: 50,
          cursor: more ? (data.value.nextCursor ?? undefined) : undefined,
        }),
    );
    data.value = {
      items: more ? [...data.value.items, ...page.items] : page.items,
      nextCursor: page.nextCursor,
    };
    if (selected.value) selected.value = await api<RunRecord>('/runs/' + selected.value.runId);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function select(id: string) {
  try {
    selected.value = await api<RunRecord>('/runs/' + encodeURIComponent(id));
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(async () => {
  await load();
  if (typeof route.query.runId === 'string') await select(route.query.runId);
  timer = setInterval(() => void load(), 5000);
});
onBeforeUnmount(() => clearInterval(timer));
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: busy.value }) });
useUiComponent('page.detail', { read: () => uiProjection(!!selected.value, []) });
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">EXECUTION LOG</div>
        <h1>运行记录</h1>
        <p>采集响应数与规范观测数分别统计。每 5 秒更新执行状态。</p>
      </div>
      <button @click="load(false)">刷新</button>
    </div>
    <form class="toolbar" @submit.prevent="load(false)">
      <label
        >执行状态<select v-model="status">
          <option value="">全部状态</option>
          <option
            v-for="s in ['queued', 'running', 'succeeded', 'failed', 'cancelled']"
            :key="s"
            :value="s"
          >
            {{ statusLabel[s] }}
          </option>
        </select></label
      ><label>来源标识<input v-model="sourceId" placeholder="全部来源" /></label
      ><button>筛选</button>
    </form>
    <FetchState :busy="busy" :error="error" :empty="!data.items.length" @retry="load(false)" />
    <div v-if="selected" class="panel">
      <div class="panel-title">
        <h2>运行详情</h2>
        <button @click="selected = null">关闭</button>
      </div>
      <dl class="detail-grid">
        <div>
          <dt>运行标识</dt>
          <dd>{{ selected.runId }}</dd>
        </div>
        <div>
          <dt>状态</dt>
          <dd>{{ statusLabel[selected.status] }}</dd>
        </div>
        <div>
          <dt>提交时间</dt>
          <dd>{{ dateLabel(selected.requestedAt) }}</dd>
        </div>
        <div>
          <dt>开始 / 结束</dt>
          <dd>{{ dateLabel(selected.startedAt) }} / {{ dateLabel(selected.finishedAt) }}</dd>
        </div>
      </dl>
      <p>
        响应 {{ selected.captures ?? '—' }} · 船位 {{ selected.positions ?? '—' }} · 隔离
        {{ selected.quarantined ?? '—' }}
      </p>
      <p v-if="selected.error" class="error">{{ selected.error }}</p>
    </div>
    <div class="panel table-scroll">
      <table>
        <thead>
          <tr>
            <th>运行</th>
            <th>来源 / 方式</th>
            <th>提交时间</th>
            <th>状态</th>
            <th>响应 / 船位 / 隔离</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in data.items" :key="r.runId">
            <td>
              <button class="mono" @click="select(r.runId)">{{ r.runId.slice(0, 12) }}…</button>
            </td>
            <td>
              {{ r.sourceId }}<small>{{ r.mode }}</small>
            </td>
            <td>{{ dateLabel(r.requestedAt) }}</td>
            <td>
              <span :class="['badge', 'status-' + r.status]">{{ statusLabel[r.status] }}</span>
            </td>
            <td>{{ r.captures ?? '—' }} / {{ r.positions ?? '—' }} / {{ r.quarantined ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <button v-if="data.nextCursor" @click="load(true)">加载更多</button>
  </section>
</template>
