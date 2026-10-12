<script setup lang="ts">
import type { SourceConfig, RunRecord } from '@ais/contracts';
import type { operations } from '../types/api.generated';
import { canOperate, dateLabel, statusLabel } from '../utils/display';
type ReplayPage =
  operations['ReplayController_list']['responses'][200]['content']['application/json'];
const { api, session, notice } = usePlatform();
const { data, busy, error, load } = useResource<ReplayPage>('/replays', {
  items: [],
  nextCursor: null,
});
const sources = ref<SourceConfig[]>([]);
const sourceId = ref('');
const from = ref(new Date(Date.now() - 3600000).toISOString().slice(0, 19));
const to = ref(new Date().toISOString().slice(0, 19));
onMounted(async () => {
  try {
    sources.value = await api<SourceConfig[]>('/sources');
    sourceId.value = sources.value[0]?.sourceId ?? '';
  } catch (e) {
    error.value = (e as Error).message;
  }
});
async function create() {
  busy.value = true;
  error.value = '';
  try {
    const run = await api<RunRecord>('/replays', {
      method: 'POST',
      idempotent: true,
      body: {
        sourceId: sourceId.value,
        from: new Date(from.value + 'Z').toISOString(),
        to: new Date(to.value + 'Z').toISOString(),
        cleaningVersion: 1,
        targetDataset: 'current',
      },
    });
    notice.value = '重放任务已进入队列';
    await navigateTo('/runs?runId=' + run.runId);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function more() {
  try {
    const page = await api<ReplayPage>(
      '/replays?cursor=' + encodeURIComponent(data.value.nextCursor ?? ''),
    );
    data.value = { items: [...data.value.items, ...page.items], nextCursor: page.nextCursor };
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">ARCHIVE REPLAY</div>
        <h1>归档重放</h1>
        <p>将保留期内的原始响应重新送入清洗通道，复用原始时间、来源与事件标识。</p>
      </div>
      <button @click="load">刷新</button>
    </div>
    <FetchState :busy="busy" :error="error" @retry="load" />
    <form v-if="canOperate(session?.user.role)" class="panel" @submit.prevent="create">
      <h2>创建重放任务</h2>
      <p class="muted">可查询最近 90 天的已确认归档，清洗版本为 1。原始归档到期时间保持不变。</p>
      <div class="toolbar" style="margin-top: 20px">
        <label
          >来源<select v-model="sourceId" required>
            <option v-for="s in sources" :key="s.sourceId" :value="s.sourceId">{{ s.name }}</option>
          </select></label
        ><label>开始（UTC）<input v-model="from" type="datetime-local" step="1" required /></label
        ><label>结束（UTC）<input v-model="to" type="datetime-local" step="1" required /></label
        ><button :disabled="busy">创建重放</button>
      </div>
    </form>
    <div class="panel">
      <h2>重放记录</h2>
      <p v-if="!data.items.length" class="muted">暂无重放记录。</p>
      <table v-else>
        <thead>
          <tr>
            <th>运行</th>
            <th>来源</th>
            <th>原文时间范围</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in data.items" :key="r.runId">
            <td>
              <NuxtLink :to="'/runs?runId=' + r.runId" class="mono"
                >{{ r.runId.slice(0, 12) }}…</NuxtLink
              >
            </td>
            <td>{{ r.sourceId }}</td>
            <td>{{ dateLabel(r.from) }} — {{ dateLabel(r.to) }}</td>
            <td>{{ statusLabel[r.status] ?? r.status }}</td>
          </tr>
        </tbody>
      </table>
      <button v-if="data.nextCursor" @click="more">加载更多</button>
    </div>
  </section>
</template>
