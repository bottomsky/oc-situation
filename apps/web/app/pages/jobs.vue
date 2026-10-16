<script setup lang="ts">
import type { JobConfig, SourceConfig, RunRecord } from '@ais/contracts';
import { canOperate, statusLabel } from '../utils/display';
const { api, session, notice } = usePlatform();
const { data, busy, error, load, mutate } = useResource<JobConfig[]>('/jobs', []);
const sources = ref<SourceConfig[]>([]);
const editor = ref(false);
const editing = ref(false);
const form = ref<JobConfig>();
const schedule = ref(900);
const scheduled = ref(true);
onMounted(async () => {
  try {
    sources.value = await api<SourceConfig[]>('/sources');
  } catch (e) {
    error.value = (e as Error).message;
  }
});
function open(job?: JobConfig) {
  editing.value = !!job;
  form.value = job
    ? { ...job }
    : {
        jobId: crypto.randomUUID(),
        sourceId: sources.value[0]?.sourceId ?? '',
        name: '',
        mode: 'crawl',
        status: 'paused',
        scheduleSeconds: 900,
      };
  scheduled.value = form.value.scheduleSeconds !== null;
  schedule.value = form.value.scheduleSeconds ?? 900;
  editor.value = true;
}
async function save() {
  if (!form.value) return;
  const body = { ...form.value, scheduleSeconds: scheduled.value ? schedule.value : null };
  if (
    await mutate(
      editing.value ? '/jobs/' + body.jobId : '/jobs',
      editing.value ? 'PUT' : 'POST',
      body,
    )
  )
    editor.value = false;
}
async function run(job: JobConfig) {
  const result = (await mutate(
    '/jobs/' + job.jobId + '/run',
    'POST',
    undefined,
    true,
  )) as RunRecord | null;
  if (result) {
    notice.value = '任务已进入队列，运行状态以运行记录为准';
    await navigateTo('/runs?runId=' + result.runId);
  }
}
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: busy.value }) });
useUiReadOnlyEditor(
  () => editor.value,
  () => ({ form: form.value, schedule: schedule.value, scheduled: scheduled.value }),
  () => busy.value,
);
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">COLLECTION CONTROL</div>
        <h1>采集任务</h1>
        <p>配置周期、手动运行和暂停任务；工作进程通过持久队列接收指令。</p>
      </div>
      <div class="actions">
        <button @click="load">刷新</button
        ><button v-if="session?.user.role === 'admin'" @click="open()">新增任务</button>
      </div>
    </div>
    <FetchState :busy="busy" :error="error" :empty="!data.length" @retry="load" />
    <form v-if="editor && form" class="panel editor-grid" @submit.prevent="save">
      <h2 class="wide">{{ editing ? '编辑任务' : '新增任务' }}</h2>
      <label>任务名称<input v-model="form.name" required /></label
      ><label
        >数据来源<select v-model="form.sourceId" aria-label="数据来源" required>
          <option v-for="s in sources" :key="s.sourceId" :value="s.sourceId">{{ s.name }}</option>
        </select></label
      ><label
        >运行方式<select v-model="form.mode">
          <option value="crawl">网页采集</option>
          <option value="collect">官方接口采集</option>
        </select></label
      ><label
        >初始状态<select v-model="form.status">
          <option value="paused">暂停</option>
          <option value="enabled">启用</option>
        </select></label
      ><label
        ><span><input v-model="scheduled" type="checkbox" /> 周期运行</span
        ><input
          v-if="scheduled"
          v-model.number="schedule"
          type="number"
          min="10"
          max="86400"
          aria-label="运行间隔秒数"
      /></label>
      <div class="wide actions">
        <button :disabled="busy">保存任务</button
        ><button type="button" @click="editor = false">取消</button>
      </div>
    </form>
    <div class="panel table-scroll">
      <table>
        <thead>
          <tr>
            <th>任务</th>
            <th>来源</th>
            <th>方式</th>
            <th>调度</th>
            <th>状态</th>
            <th v-if="canOperate(session?.user.role)">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="j in data" :key="j.jobId">
            <td>
              {{ j.name }}<small class="mono">{{ j.jobId }}</small>
            </td>
            <td>{{ sources.find((s) => s.sourceId === j.sourceId)?.name ?? j.sourceId }}</td>
            <td>
              {{ j.mode === 'crawl' ? '网页采集' : j.mode === 'collect' ? '接口采集' : '归档重放' }}
            </td>
            <td>{{ j.scheduleSeconds ? j.scheduleSeconds + ' 秒' : '手动运行' }}</td>
            <td>
              <span :class="['badge', 'status-' + j.status]">{{ statusLabel[j.status] }}</span>
            </td>
            <td v-if="canOperate(session?.user.role)">
              <div class="actions">
                <button :disabled="busy || j.status === 'paused'" @click="run(j)">运行</button
                ><button
                  :disabled="busy"
                  @click="
                    mutate(
                      '/jobs/' + j.jobId + (j.status === 'enabled' ? '/pause' : '/resume'),
                      'POST',
                    )
                  "
                >
                  {{ j.status === 'enabled' ? '暂停' : '恢复' }}</button
                ><button v-if="session?.user.role === 'admin'" @click="open(j)">编辑</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
