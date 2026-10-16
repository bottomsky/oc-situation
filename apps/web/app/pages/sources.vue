<script setup lang="ts">
import type { SourceConfig } from '@ais/contracts';
import { dateLabel, statusLabel } from '../utils/display';
type Source = SourceConfig & { lastReceivedAt: string | null; lastError: string | null };
const { session } = usePlatform();
const { data, busy, error, load, mutate } = useResource<Source[]>('/sources', []);
const editor = ref(false);
const editing = ref(false);
const form = ref<SourceConfig>();
const hosts = ref('');
function open(source?: Source) {
  editing.value = !!source;
  form.value = source
    ? {
        sourceId: source.sourceId,
        sourceKind: source.sourceKind,
        name: source.name,
        status: source.status,
        priority: source.priority,
        secretRef: source.secretRef,
        ...(source.endpoint ? { endpoint: source.endpoint } : {}),
        ...(source.bbox ? { bbox: source.bbox } : {}),
        settings: {
          allowedHosts: [],
          requestsPerMinute: 30,
          maxPages: 100,
          httpConcurrency: 2,
          browserConcurrency: 1,
          timeoutSeconds: 30,
          timespanMinutes: 5,
          pageLimit: 2000,
          authorizationConfirmed: false,
          ...source.settings,
        },
      }
    : {
        sourceId: '',
        sourceKind: 'marinetraffic',
        name: '',
        status: 'disabled',
        priority: 300,
        secretRef: null,
        settings: {
          allowedHosts: [],
          requestsPerMinute: 30,
          maxPages: 100,
          httpConcurrency: 2,
          browserConcurrency: 1,
          timeoutSeconds: 30,
          timespanMinutes: 5,
          pageLimit: 2000,
          authorizationConfirmed: false,
        },
      };
  hosts.value = form.value.settings!.allowedHosts.join(',');
  editor.value = true;
}
async function save() {
  if (!form.value) return;
  const body = {
    ...form.value,
    ...(form.value.endpoint ? {} : { endpoint: undefined }),
    secretRef: form.value.secretRef || null,
    settings: {
      ...form.value.settings,
      allowedHosts: hosts.value
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    },
  };
  const result = await mutate(
    editing.value ? '/sources/' + encodeURIComponent(body.sourceId) : '/sources',
    editing.value ? 'PUT' : 'POST',
    body,
  );
  if (result) editor.value = false;
}
async function toggle(s: Source) {
  const { lastReceivedAt: _r, lastError: _e, ...config } = s;
  await mutate('/sources/' + encodeURIComponent(s.sourceId), 'PUT', {
    ...config,
    status: s.status === 'enabled' ? 'disabled' : 'enabled',
  });
}
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: busy.value }) });
useUiReadOnlyEditor(
  () => editor.value,
  () => ({ form: form.value, hosts: hosts.value }),
  () => busy.value,
);
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">SOURCE REGISTRY</div>
        <h1>数据来源</h1>
        <p>分别管理授权、请求预算和来源状态。密钥通过服务器变量引用提供。</p>
      </div>
      <div class="actions">
        <button @click="load">刷新</button
        ><button v-if="session?.user.role === 'admin'" @click="open()">新增来源</button>
      </div>
    </div>
    <FetchState :busy="busy" :error="error" :empty="!data.length" @retry="load" />
    <form v-if="editor && form" class="panel editor-grid" @submit.prevent="save">
      <h2 class="wide">{{ editing ? '编辑来源' : '新增来源' }}</h2>
      <label
        >来源标识<input
          v-model="form.sourceId"
          :readonly="editing"
          required
          pattern="[a-zA-Z0-9._-]+" /></label
      ><label>来源名称<input v-model="form.name" required /></label
      ><label
        >来源类型<select v-model="form.sourceKind">
          <option value="marinetraffic">MarineTraffic 官方 API</option>
          <option value="aisstream">AISStream</option>
          <option value="fixture-http">受控 HTTP 样例</option>
          <option value="fixture-browser">受控动态样例</option>
        </select></label
      ><label
        >状态<select v-model="form.status">
          <option value="disabled">停用</option>
          <option value="enabled">启用</option>
        </select></label
      ><label
        >来源优先级<input
          v-model.number="form.priority"
          type="number"
          min="0"
          max="10000"
          required /></label
      ><label
        >凭证变量名<input v-model="form.secretRef" placeholder="例：MARINETRAFFIC_API_KEY" /></label
      ><label
        >接口地址<input
          v-model="form.endpoint"
          type="url"
          placeholder="供应商官方端点 / 受控样例地址" /></label
      ><label>允许域名<input v-model="hosts" placeholder="逗号分隔" /></label
      ><template v-if="form.settings"
        ><label
          >每分钟请求预算<input
            v-model.number="form.settings.requestsPerMinute"
            type="number"
            min="1"
            max="10000" /></label
        ><label
          >单次运行页数<input
            v-model.number="form.settings.maxPages"
            type="number"
            min="1"
            max="1000" /></label
        ><label
          >请求超时（秒）<input
            v-model.number="form.settings.timeoutSeconds"
            type="number"
            min="1"
            max="120" /></label
        ><label
          >查询窗口（分钟）<input
            v-model.number="form.settings.timespanMinutes"
            type="number"
            min="1"
            max="1440" /></label
        ><label class="wide"
          ><span
            ><input v-model="form.settings.authorizationConfirmed" type="checkbox" />
            已确认采购或来源访问授权</span
          ></label
        ></template
      >
      <div class="wide actions">
        <button type="submit" :disabled="busy">保存来源</button
        ><button type="button" @click="editor = false">取消</button>
      </div>
    </form>
    <div class="panel table-scroll">
      <table>
        <thead>
          <tr>
            <th>来源</th>
            <th>类型 / 优先级</th>
            <th>状态</th>
            <th>最后接收时间</th>
            <th>请求预算</th>
            <th v-if="session?.user.role === 'admin'">管理</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in data" :key="s.sourceId">
            <td>
              {{ s.name }}<small class="mono">{{ s.sourceId }}</small
              ><span v-if="s.sourceKind.startsWith('fixture')" class="badge sample">样例数据</span>
            </td>
            <td>
              {{ s.sourceKind }}<small>优先级 {{ s.priority }}</small>
            </td>
            <td>
              <span :class="['badge', 'status-' + s.status]">{{ statusLabel[s.status] }}</span
              ><small v-if="s.lastError" class="error">{{ s.lastError }}</small>
            </td>
            <td>{{ dateLabel(s.lastReceivedAt) }}</td>
            <td>
              {{ s.settings?.requestsPerMinute ?? 30 }} 次 / 分钟<small>{{
                s.settings?.authorizationConfirmed ? '已确认授权' : '待确认授权'
              }}</small>
            </td>
            <td v-if="session?.user.role === 'admin'">
              <div class="actions">
                <button @click="open(s)">编辑</button
                ><button :disabled="busy" @click="toggle(s)">
                  {{ s.status === 'enabled' ? '停用' : '启用' }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
