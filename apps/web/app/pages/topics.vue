<script setup lang="ts">
import type { TopicDefinition, TopicInstance, TopicDefinitionId } from '@ais/contracts';
import { parseBbox } from '../utils/fusion';
import { dateLabel } from '../utils/display';
const { api, session, notice } = usePlatform();
const { analysisVersion } = useFusionEvents();
const definitions = ref<TopicDefinition[]>([]);
const instances = ref<TopicInstance[]>([]);
const busy = ref(false);
const error = ref('');
const definitionId = ref<TopicDefinitionId>('port-restriction');
const name = ref('');
const bounds = ref('120,28,124,33');
const historyHours = ref(24);
const windowMinutes = ref(60);
const lowSpeedKnots = ref(3);
const minPositions = ref(3);
const scheduleSeconds = ref(60);
const enabled = ref(false);
const editing = ref<string | null>(null);
const editor = useTemplateRef<HTMLElement>('editor');
const canManage = computed(() => session.value?.user.role !== 'viewer');
const canAdmin = computed(() => session.value?.user.role === 'admin');
const statusNames = {
  disabled: '已停用',
  warming: '历史预热中',
  ready: '持续分析中',
  degraded: '运行受限',
};
async function load() {
  try {
    const response = await api<{ definitions: TopicDefinition[]; instances: TopicInstance[] }>(
      '/topics',
    );
    definitions.value = response.definitions;
    instances.value = response.instances;
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function action(operation: () => Promise<unknown>, message: string) {
  busy.value = true;
  error.value = '';
  try {
    await operation();
    notice.value = message;
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function create() {
  await action(
    async () => {
      if (windowMinutes.value > historyHours.value * 60)
        throw new Error('分析窗口需位于历史查询范围内');
      const config = {
        bbox: parseBbox(bounds.value),
        historyHours: historyHours.value,
        windowMinutes: windowMinutes.value,
        lowSpeedKnots: lowSpeedKnots.value,
        minPositions: minPositions.value,
        scheduleSeconds: scheduleSeconds.value,
      };
      await api(editing.value ? `/topics/instances/${editing.value}/config` : '/topics/instances', {
        method: editing.value ? 'PUT' : 'POST',
        body: editing.value
          ? { config }
          : {
              definitionId: definitionId.value,
              name: name.value,
              config,
              enabled: enabled.value,
            },
      });
      name.value = '';
      editing.value = null;
    },
    editing.value
      ? '专题配置已保存，启用中的专题将重新预热'
      : enabled.value
        ? '专题已创建，正在预热历史数据'
        : '专题已创建，可按需启用',
  );
}
function edit(instance: TopicInstance) {
  editing.value = instance.id;
  name.value = instance.name;
  definitionId.value = instance.definitionId;
  bounds.value = instance.config.bbox.join(',');
  historyHours.value = instance.config.historyHours;
  windowMinutes.value = instance.config.windowMinutes;
  lowSpeedKnots.value = instance.config.lowSpeedKnots;
  minPositions.value = instance.config.minPositions;
  scheduleSeconds.value = instance.config.scheduleSeconds;
  enabled.value = instance.enabled;
  editor.value?.scrollIntoView({ behavior: 'smooth' });
}
function toggle(instance: TopicInstance) {
  return action(
    () =>
      api(`/topics/instances/${instance.id}/state`, {
        method: 'PUT',
        body: { enabled: !instance.enabled },
      }),
    instance.enabled ? '专题已停用' : '专题已启用，正在预热历史数据',
  );
}
function run(instance: TopicInstance) {
  return action(
    () =>
      api(`/topics/instances/${instance.id}/run`, { method: 'POST', body: {}, idempotent: true }),
    '专题分析已提交',
  );
}
let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 10000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(analysisVersion, load);
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: busy.value }) });
useUiReadOnlyEditor(
  () => canManage.value,
  () => ({
    name: name.value,
    bounds: bounds.value,
    definitionId: definitionId.value,
    historyHours: historyHours.value,
    windowMinutes: windowMinutes.value,
  }),
  () => busy.value,
);
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">TOPICS / 持续分析</div>
        <h1>分析专题</h1>
        <p>配置关注范围与规则，启用后预热历史数据，并持续接收新观测与公告。</p>
      </div>
      <button
        :disabled="busy"
        @click="
          error = '';
          load();
        "
      >
        刷新专题
      </button>
    </div>
    <FetchState
      :busy="busy"
      :error="error"
      @retry="
        error = '';
        load();
      "
    />
    <div class="topic-definitions">
      <article v-for="definition in definitions" :key="definition.id" class="panel">
        <span class="eyebrow">{{ definition.id }}</span>
        <h2>{{ definition.name }}</h2>
        <p>{{ definition.description }}</p>
        <span class="badge"
          >{{ definition.available ? '可配置' : '所需数据能力待就绪' }} ·
          {{ definition.version }}</span
        >
      </article>
    </div>
    <form
      v-if="canAdmin"
      ref="editor"
      class="panel editor-grid topic-editor"
      @submit.prevent="create"
    >
      <h2 class="wide">{{ editing ? '编辑专题配置' : '新建分析专题' }}</h2>
      <label
        >专题名称<input
          v-model="name"
          :readonly="!!editing"
          required
          maxlength="200"
          placeholder="填写任务名称"
      /></label>
      <label
        >专题算法<select v-model="definitionId" :disabled="!!editing">
          <option
            v-for="definition in definitions"
            :key="definition.id"
            :value="definition.id"
            :disabled="!definition.available"
          >
            {{ definition.name }}
          </option>
        </select></label
      >
      <label class="wide"
        >关注范围（西,南,东,北）<input
          v-model="bounds"
          required
          placeholder="120,28,124,33"
        /><small class="muted">WGS84 经度、纬度；跨日期变更线时西界可大于东界。</small></label
      >
      <label
        >历史预热（小时）<input
          v-model.number="historyHours"
          type="number"
          min="1"
          max="168"
          required
      /></label>
      <label
        >分析窗口（分钟）<input
          v-model.number="windowMinutes"
          type="number"
          min="1"
          max="1440"
          required
      /></label>
      <label
        >低速阈值（节）<input
          v-model.number="lowSpeedKnots"
          type="number"
          min="0"
          max="20"
          step="0.1"
          required
      /></label>
      <label
        >最少有效船位<input v-model.number="minPositions" type="number" min="2" max="1000" required
      /></label>
      <label
        >分析周期（秒）<input
          v-model.number="scheduleSeconds"
          type="number"
          min="10"
          max="86400"
          required
      /></label>
      <label
        >创建后状态<select v-model="enabled" :disabled="!!editing">
          <option :value="false">保存为停用</option>
          <option :value="true">立即启用</option>
        </select></label
      >
      <div class="wide actions">
        <button
          :disabled="busy || !definitions.some((d) => d.id === definitionId && d.available)"
          type="submit"
        >
          {{ editing ? '保存配置' : '创建专题' }}
        </button>
        <button
          v-if="editing"
          type="button"
          @click="
            editing = null;
            name = '';
          "
        >
          取消编辑
        </button>
      </div>
    </form>
    <section class="panel">
      <div class="section-heading">
        <h2>专题实例</h2>
        <span class="muted">{{ instances.length }} 个专题</span>
      </div>
      <p v-if="!instances.length && !error" class="empty-copy">
        暂无专题实例。选择算法并配置关注范围后即可创建。
      </p>
      <article v-for="instance in instances" :key="instance.id" class="topic-instance">
        <div class="section-heading">
          <div>
            <h3>{{ instance.name }}</h3>
            <small class="muted">{{
              definitions.find((d) => d.id === instance.definitionId)?.name || instance.definitionId
            }}</small>
          </div>
          <span :class="['badge', instance.enabled ? 'status-enabled' : '']">{{
            statusNames[instance.status]
          }}</span>
        </div>
        <p class="detail-time">
          范围 {{ instance.config.bbox.join(', ') }} · 历史 {{ instance.config.historyHours }} 小时
          · 周期 {{ instance.config.scheduleSeconds }} 秒<br />最后运行
          {{ dateLabel(instance.lastRunAt) }} · 数据检查点
          {{ instance.checkpoint || '等待首次运行' }}
        </p>
        <p v-if="instance.lastError" class="error" role="alert">{{ instance.lastError }}</p>
        <div v-if="canManage" class="actions">
          <button v-if="canAdmin" :disabled="busy" @click="edit(instance)">编辑配置</button>
          <button v-if="canAdmin" :disabled="busy" @click="toggle(instance)">
            {{ instance.enabled ? '停用专题' : '启用专题' }}</button
          ><button :disabled="busy || !instance.enabled" @click="run(instance)">立即分析</button>
        </div>
      </article>
    </section>
  </section>
</template>
