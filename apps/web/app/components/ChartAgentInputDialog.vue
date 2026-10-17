<script setup lang="ts">
import type {
  AgentInputRequest,
  AgentInputValues,
  AgentMapContext,
  AgentPurpose,
  Bbox,
  Page,
  VesselSummary,
  AgentInputField,
} from '@ais/contracts';
import { MARINE_SAMPLE_POINTS, VesselTracksSelectorSchema } from '@ais/contracts';
import type { AgentConversationState } from '../composables/useAgentConversation';
import {
  skillCandidateKey,
  skillChoiceValid,
  inputNeedsIntelligence,
  initializeAgentInputValues,
} from '../utils/skillInput';
const props = defineProps<{
  state: AgentConversationState;
  context: AgentMapContext;
  currentBounds?: () => Bbox;
  drawing: boolean;
  drawnRegion?: Bbox | null;
}>();
const emit = defineEmits<{ draw: []; stopDrawing: [] }>();
const { api } = usePlatform();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const values = ref<AgentInputValues>({});
const request = ref<AgentInputRequest | null>(null);
const search = ref('');
const results = ref<VesselSummary[]>([]);
const searching = ref(false);
const error = ref('');
const preset = ref('24');
const from = ref('');
const to = ref('');
const expanded = ref(false);
let searchGeneration = 0;
let returnFocus: HTMLElement | null = null;
const reasonLabels = {
  missing_vessel_selector: '请补充船舶型号、船型或船舶信息',
  missing_region: '请选择本次任务的区域',
  missing_vessels: '请选择要查询的船舶',
  missing_time: '请补充时间范围',
  missing_goal: '请选择希望执行的任务',
  ambiguous_skill: '多个技能符合请求，请选择本次使用的版本',
  data_limit: '数据较多，请缩小范围或时间',
  retention: '所选时间超出在线数据范围，请调整',
  scope_changed: '任务范围已变化，请确认条件',
  missing_topic: '请补充要检索的情报主题或海况代表点',
};
const isIntelligence = computed(() =>
  inputNeedsIntelligence(request.value?.fields ?? [], values.value.purpose),
);
const isMarine = computed(
  () => isIntelligence.value && values.value.intelligenceQuery?.kind === 'marine',
);
const intelligenceKeyword = computed({
  get: () => values.value.intelligenceQuery?.keyword ?? '',
  set: (keyword: string) => {
    values.value.intelligenceQuery = { ...values.value.intelligenceQuery, keyword };
  },
});
const intelligenceObjectId = computed({
  get: () => values.value.intelligenceQuery?.objectId ?? '',
  set: (objectId: string) => {
    values.value.intelligenceQuery = {
      ...values.value.intelligenceQuery,
      objectId: objectId || undefined,
    };
  },
});
const objectCandidates = computed(() => request.value?.prefill.intelligenceObjectCandidates ?? []);
const skillCandidates = computed(() => request.value?.prefill.skillCandidates ?? []);
const isQuery = computed(() =>
  ['vessel_list', 'vessel_detail'].includes(values.value.purpose ?? ''),
);
function beijingInput(iso: string) {
  return new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0, 16);
}
function required(field: AgentInputField) {
  if (request.value?.fields.includes(field)) return true;
  const purpose = values.value.purpose;
  if (field === 'vessel_selector') return purpose === 'vessel_tracks';
  if (field === 'topic') return purpose === 'intelligence_search';
  if (field === 'vessels') return purpose === 'vessel_detail';
  if (field === 'region')
    return (
      purpose === 'vessel_list' ||
      purpose === 'ais_heatmap' ||
      purpose === 'vessel_tracks' ||
      purpose === 'port-restriction' ||
      purpose === 'area-low-speed-notice'
    );
  if (field === 'time')
    return (
      purpose === 'ais_heatmap' ||
      purpose === 'vessel_tracks' ||
      purpose === 'port-restriction' ||
      purpose === 'area-low-speed-notice'
    );
  return false;
}
function visible(field: AgentInputField) {
  return expanded.value || required(field);
}
watch(
  () => props.state.openInput,
  async (next) => {
    if (!next) {
      if (!props.state.inputRequests.some((item) => item.id === request.value?.id)) {
        request.value = null;
        values.value = {};
        results.value = [];
        searchGeneration++;
      }
      dialog.value?.close();
      emit('stopDrawing');
      return;
    }
    if (request.value?.id !== next.id || request.value.inputRevision !== next.inputRevision) {
      request.value = next;
      values.value = initializeAgentInputValues(next.prefill, next.fields);
      if (!values.value.bbox && values.value.intelligenceQuery?.bbox)
        values.value.bbox = [...values.value.intelligenceQuery.bbox];
      const range = inputNeedsIntelligence(next.fields, next.prefill.purpose)
        ? (next.prefill.intelligenceTimeRange ??
          (next.prefill.intelligenceQuery?.kind === 'marine'
            ? {
                from: next.prefill.intelligenceQuery?.forecastFrom,
                to: next.prefill.intelligenceQuery?.forecastTo,
              }
            : {
                from: next.prefill.intelligenceQuery?.from,
                to: next.prefill.intelligenceQuery?.to,
              }))
        : next.prefill.timeRange;
      preset.value = range?.from && range.to ? 'custom' : '24';
      from.value = range?.from ? beijingInput(range.from) : '';
      to.value = range?.to ? beijingInput(range.to) : '';
      error.value = '';
      search.value = '';
      results.value = [];
      expanded.value = false;
      searchGeneration++;
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    }
    await nextTick();
    if (!props.drawing && props.state.openInput?.id === next.id && !dialog.value?.open)
      dialog.value?.showModal();
  },
  { immediate: true },
);
watch(
  () => props.drawing,
  async (drawing) => {
    if (drawing) dialog.value?.close();
    else {
      await nextTick();
      if (props.state.openInput && !dialog.value?.open) dialog.value?.showModal();
    }
  },
);
watch(
  () => props.drawnRegion,
  (bbox) => {
    if (bbox) {
      values.value.bbox = [...bbox];
      if (isIntelligence.value)
        values.value.intelligenceQuery = {
          ...values.value.intelligenceQuery,
          bbox: [...bbox],
          locationKeyword: undefined,
        };
    }
  },
);
function close() {
  if (props.state.inputBusy) return;
  props.state.closeInput();
  emit('stopDrawing');
  returnFocus?.focus({ preventScroll: true });
}
useUiComponent('agent.input', {
  read: () =>
    uiProjection(
      !!props.state.openInput && !props.drawing,
      ['close', ...(props.state.inputRequests.length ? ['open' as const] : [])],
      {
        order: 80,
        focused: !!dialog.value?.contains(import.meta.client ? document.activeElement : null),
        dirty:
          !!request.value && JSON.stringify(values.value) !== JSON.stringify(request.value.prefill),
        interacting: props.drawing,
        loading: props.state.inputBusy,
        ...(props.state.inputBusy ? { blocked: 'loading' as const } : {}),
      },
    ),
  execute: (op) => {
    if (op.action === 'close') close();
    else if (props.state.inputRequests[0]) props.state.showInput(props.state.inputRequests[0].id);
  },
});
function currentRegion() {
  const bbox = props.currentBounds?.() ?? props.context.bbox;
  values.value.bbox = [...bbox];
  if (isIntelligence.value) {
    values.value.intelligenceQuery = {
      ...values.value.intelligenceQuery,
      bbox: [...bbox],
      locationKeyword: undefined,
    };
    return;
  }
  values.value.filters = {
    ...(props.context.sourceId ? { sourceId: props.context.sourceId } : {}),
    ...(props.context.shipType ? { shipType: props.context.shipType } : {}),
    hours: props.context.hours ?? 24,
  };
}
function toggle(mmsi: string) {
  const selected = values.value.mmsis ?? [];
  if (selected.includes(mmsi)) values.value.mmsis = selected.filter((item) => item !== mmsi);
  else if (selected.length < 100) values.value.mmsis = [...selected, mmsi];
  else error.value = '最多选择 100 艘船舶。';
}
async function find() {
  const revision = ++searchGeneration;
  searching.value = true;
  error.value = '';
  try {
    const response = await api<Page<VesselSummary>>(
      `/vessels?query=${encodeURIComponent(search.value.trim())}&limit=20`,
    );
    if (revision === searchGeneration) results.value = response.items;
  } catch (e) {
    if (revision === searchGeneration) error.value = (e as Error).message;
  } finally {
    if (revision === searchGeneration) searching.value = false;
  }
}
async function submit() {
  if (!request.value) return;
  error.value = '';
  const body: AgentInputValues = JSON.parse(JSON.stringify(values.value));
  if (required('skill') && !skillChoiceValid(body.skillRef, skillCandidates.value)) {
    error.value = '请选择本次使用的技能版本。';
    return;
  }
  delete body.skillCandidates;
  if (
    required('vessel_selector') &&
    !VesselTracksSelectorSchema.safeParse(body.vesselSelector).success
  ) {
    error.value = '请填写至少一项有效船舶条件；AIS 船型编码范围为 1–99。';
    return;
  }
  if (body.purpose === 'vessel_tracks') delete body.tracksTimeUnclear;
  if (required('region') && !body.bbox) {
    error.value = '请确认当前视野或框选区域。';
    return;
  }
  if (
    (request.value.fields.includes('vessels') || body.purpose === 'vessel_detail') &&
    !body.mmsis?.length
  ) {
    error.value = '请至少选择一艘船舶。';
    return;
  }
  if (request.value.fields.includes('goal') && !body.purpose) {
    error.value = '请选择任务目标。';
    return;
  }
  if (isIntelligence.value) {
    body.intelligenceQuery = {
      ...body.intelligenceQuery,
      ...(body.bbox ? { bbox: body.bbox } : {}),
      ...(body.mmsis?.length ? { mmsis: body.mmsis } : {}),
    };
    if (isMarine.value && !body.intelligenceQuery.samplePointId) {
      error.value = '海况仅覆盖六个代表点，请选择代表点；该预报不能替代目标港口海况。';
      return;
    }
    if (request.value.prefill.intelligenceObjectUnclear) {
      if (
        !objectCandidates.value.some(
          (candidate) => candidate.id === body.intelligenceQuery?.objectId,
        )
      ) {
        error.value = '请选择本次检索对应的对象。';
        return;
      }
      delete body.intelligenceObjectUnclear;
    }
    if (
      !body.intelligenceQuery.keyword?.trim() &&
      !body.intelligenceQuery.samplePointId &&
      !body.intelligenceQuery.objectId &&
      required('topic')
    ) {
      error.value = '请输入检索主题，或选择海况代表点。';
      return;
    }
    if (visible('time') || isMarine.value) {
      const now = Date.now();
      const start =
        preset.value === 'custom'
          ? Date.parse(`${from.value}+08:00`)
          : isMarine.value
            ? now
            : now - Number(preset.value) * 3600000;
      const end =
        preset.value === 'custom'
          ? Date.parse(`${to.value}+08:00`)
          : isMarine.value
            ? now + Number(preset.value) * 3600000
            : now;
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        (isMarine.value && end - start > 72 * 3600000)
      ) {
        error.value = isMarine.value
          ? '请填写有效的海况预报时段，最长 72 小时。'
          : '请填写起点早于终点的情报检索时段。';
        return;
      }
      const range = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
      if (isMarine.value) {
        body.intelligenceQuery.forecastFrom = range.from;
        body.intelligenceQuery.forecastTo = range.to;
        delete body.intelligenceTimeRange;
        delete body.intelligenceQuery.from;
        delete body.intelligenceQuery.to;
      } else {
        body.intelligenceTimeRange = range;
        body.intelligenceQuery.from = range.from;
        body.intelligenceQuery.to = range.to;
        if (body.intelligenceQuery.kind !== 'both') {
          delete body.intelligenceQuery.forecastFrom;
          delete body.intelligenceQuery.forecastTo;
        }
      }
    }
    delete body.historyHours;
    delete body.timeRange;
  }
  if (!isQuery.value && !isIntelligence.value && visible('time')) {
    if (preset.value === 'custom') {
      const start = Date.parse(`${from.value}+08:00`);
      const end = Date.parse(`${to.value}+08:00`);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        end - start > 168 * 3600000 ||
        start < Date.now() - 30 * 86400000 ||
        end > Date.now()
      ) {
        error.value = '请选择最近 30 天内的有效时段，最长 168 小时，结束时间不能晚于现在。';
        return;
      }
      body.timeRange = { from: new Date(start).toISOString(), to: new Date(end).toISOString() };
      delete body.historyHours;
    } else {
      body.historyHours = Number(preset.value);
      delete body.timeRange;
    }
  }
  if (isQuery.value) {
    delete body.timeRange;
    delete body.historyHours;
  }
  await props.state.answerInput(request.value, body);
}
function purposeChanged(event: Event) {
  values.value.purpose = (event.target as HTMLSelectElement).value as AgentPurpose;
}
onBeforeUnmount(() => {
  searchGeneration++;
  dialog.value?.close();
});
</script>

<template>
  <dialog
    ref="dialog"
    class="agent-input-dialog"
    aria-label="补充任务条件"
    @cancel.prevent="close"
    @keydown.stop
    @wheel.stop
  >
    <form v-if="request" @submit.prevent="submit">
      <header>
        <h2>补充任务条件</h2>
        <button type="button" :disabled="state.inputBusy" @click="close">收起</button>
      </header>
      <p>{{ reasonLabels[request.reason] }}</p>
      <p class="hint">确认后将自动继续当前任务，无需再次发送问题。</p>
      <fieldset v-if="visible('skill') && skillCandidates.length">
        <legend>选择技能</legend>
        <label
          v-for="candidate in skillCandidates"
          :key="skillCandidateKey(candidate)"
          class="skill-choice"
        >
          <input
            type="radio"
            name="agent-skill-choice"
            :value="skillCandidateKey(candidate)"
            :checked="
              values.skillRef?.skillId === candidate.skillId &&
              values.skillRef?.version === candidate.version
            "
            @change="values.skillRef = { skillId: candidate.skillId, version: candidate.version }"
          />
          <span
            ><strong>{{ candidate.name }}</strong> · {{ candidate.version
            }}<small v-if="candidate.description">{{ candidate.description }}</small></span
          >
        </label>
      </fieldset>
      <fieldset v-if="visible('goal')">
        <legend>任务目标</legend>
        <select aria-label="任务目标" :value="values.purpose ?? ''" @change="purposeChanged">
          <option disabled value="">请选择</option>
          <option value="vessel_list">区域船舶列表</option>
          <option value="vessel_detail">船舶基本信息</option>
          <option value="vessel_tracks">船舶历史航线</option>
          <option value="ais_heatmap">AIS 历史船舶热力图</option>
          <option value="port-restriction">港口限制船舶识别</option>
          <option value="area-low-speed-notice">区域低速活动与公告关联</option>
          <option value="intelligence_search">本地情报与海况检索</option>
        </select>
      </fieldset>
      <VesselSelectorFields v-if="required('vessel_selector')" v-model="values.vesselSelector" />
      <fieldset v-if="isIntelligence && visible('topic')">
        <legend>情报主题</legend>
        <label
          >检索类型<select
            aria-label="情报检索类型"
            :value="values.intelligenceQuery?.kind ?? 'events'"
            @change="
              values.intelligenceQuery = {
                ...values.intelligenceQuery,
                kind: ($event.target as HTMLSelectElement).value as 'events' | 'marine' | 'both',
              };
              preset = '24';
              from = '';
              to = '';
            "
          >
            <option value="events">事件与公告</option>
            <option value="marine">海况预报</option>
            <option value="both">事件与海况</option>
          </select></label
        ><label v-if="request?.prefill.intelligenceObjectUnclear"
          >检索对象<select v-model="intelligenceObjectId" aria-label="选择情报检索对象">
            <option value="">请选择对应对象</option>
            <option v-for="candidate in objectCandidates" :key="candidate.id" :value="candidate.id">
              {{ candidate.name }}
            </option>
          </select></label
        ><label
          >检索主题<input
            v-model="intelligenceKeyword"
            aria-label="情报检索主题"
            maxlength="300"
            :placeholder="
              request?.prefill.intelligenceObjectUnclear
                ? '可选关键词，进一步筛选对象情报'
                : '例如：航行警告、地震、港口公告'
            " /></label
        ><label v-if="values.intelligenceQuery?.kind !== 'events' && values.intelligenceQuery?.kind"
          >海况代表点<select
            aria-label="海况代表点"
            :value="values.intelligenceQuery?.samplePointId ?? ''"
            @change="
              values.intelligenceQuery = {
                ...values.intelligenceQuery,
                samplePointId: ($event.target as HTMLSelectElement).value || undefined,
              }
            "
          >
            <option value="">请选择代表点</option>
            <option v-for="point in MARINE_SAMPLE_POINTS" :key="point.id" :value="point.id">
              {{ point.name }}
            </option>
          </select></label
        >
        <p class="hint">只检索已经采集入库的资料。问答不会触发外部采集。</p>
        <p v-if="isMarine" class="hint">
          海况仅覆盖六个代表点，不能替代其他港口或全海域的实际海况。
        </p>
      </fieldset>
      <fieldset v-if="visible('region')">
        <legend>区域</legend>
        <div class="actions">
          <button type="button" @click="currentRegion">使用当前视野</button
          ><button type="button" @click="emit('draw')">地图矩形框选</button>
        </div>
        <p v-if="values.bbox" data-testid="agent-region-preview">
          西 {{ values.bbox[0].toFixed(3) }}° · 南 {{ values.bbox[1].toFixed(3) }}° · 东
          {{ values.bbox[2].toFixed(3) }}° · 北 {{ values.bbox[3].toFixed(3) }}°
        </p>
        <p v-else class="hint">尚未确认区域</p>
      </fieldset>
      <fieldset v-if="visible('vessels')">
        <legend>船舶对象</legend>
        <div class="actions">
          <button
            v-if="context.selectedMmsis?.length"
            type="button"
            @click="values.mmsis = [...context.selectedMmsis]"
          >
            使用当前选中船舶</button
          ><button type="button" @click="values.mmsis = []">清除选择</button>
        </div>
        <div class="actions">
          <input
            v-model="search"
            aria-label="搜索船舶"
            placeholder="船名 / MMSI / IMO"
            @keydown.enter.prevent="find"
          /><button type="button" :disabled="searching" @click="find">
            {{ searching ? '搜索中…' : '搜索' }}
          </button>
        </div>
        <div class="search-results">
          <label v-for="vessel in results" :key="vessel.mmsi"
            ><input
              type="checkbox"
              :checked="values.mmsis?.includes(vessel.mmsi)"
              @change="toggle(vessel.mmsi)"
            />{{ vessel.staticFields.name || '未命名船舶' }} · {{ vessel.mmsi }}</label
          >
        </div>
        <p>已选 {{ values.mmsis?.length ?? 0 }} / 100 艘</p>
        <div class="actions">
          <button
            v-for="mmsi in values.mmsis"
            :key="mmsi"
            type="button"
            :aria-label="`移除 ${mmsi}`"
            @click="toggle(mmsi)"
          >
            {{ mmsi }} ×
          </button>
        </div>
      </fieldset>
      <fieldset v-if="visible('time') || isMarine">
        <legend>{{ isQuery ? '最新报告窗口' : '分析时间（北京时间）' }}</legend>
        <template v-if="isIntelligence">
          <label v-if="!isMarine"
            >时间依据<select
              aria-label="情报时间依据"
              :value="values.intelligenceQuery?.timeMode ?? 'published'"
              @change="
                values.intelligenceQuery = {
                  ...values.intelligenceQuery,
                  timeMode: ($event.target as HTMLSelectElement).value as
                    'published' | 'effective' | 'observed',
                }
              "
            >
              <option value="published">原文发布时间</option>
              <option value="observed">索引观测时间</option>
              <option value="effective">情报适用时间</option>
            </select></label
          >
          <select v-model="preset" aria-label="情报检索时间范围">
            <option
              v-for="hours in isMarine ? [24, 48, 72] : [24, 168, 720, 2160]"
              :key="hours"
              :value="String(hours)"
            >
              {{ isMarine ? '未来' : '最近' }} {{ hours }} 小时
            </option>
            <option value="custom">自定义时段</option>
          </select>
          <template v-if="preset === 'custom'"
            ><label
              >开始<input
                v-model="from"
                type="datetime-local"
                aria-label="情报开始时间（北京时间）" /></label
            ><label
              >结束<input
                v-model="to"
                type="datetime-local"
                aria-label="情报结束时间（北京时间）" /></label
          ></template>
          <p class="hint">
            {{
              isMarine
                ? '预报最长 72 小时，具体覆盖以采集快照为准。'
                : '检索已入库历史情报，不受 AIS 168 小时分析窗口限制。'
            }}
          </p>
        </template>
        <template v-else-if="isQuery"
          ><select
            aria-label="最新报告窗口"
            :value="values.filters?.hours ?? context.hours ?? 24"
            @change="
              values.filters = {
                ...values.filters,
                hours: Number(($event.target as HTMLSelectElement).value),
              }
            "
          >
            <option v-for="hours in [1, 6, 24, 72, 168]" :key="hours" :value="hours">
              最近 {{ hours }} 小时
            </option>
          </select>
          <p class="hint">查询船舶最新船位，按最新报告时间筛选。</p></template
        ><template v-else
          ><select v-model="preset" aria-label="分析时间范围">
            <option v-for="hours in [1, 6, 24, 72, 168]" :key="hours" :value="String(hours)">
              最近 {{ hours }} 小时
            </option>
            <option value="custom">自定义时段</option></select
          ><template v-if="preset === 'custom'"
            ><label
              >开始<input
                v-model="from"
                type="datetime-local"
                aria-label="开始时间（北京时间）" /></label
            ><label
              >结束<input
                v-model="to"
                type="datetime-local"
                aria-label="结束时间（北京时间）" /></label></template
        ></template>
      </fieldset>
      <button type="button" @click="expanded = !expanded">
        {{ expanded ? '收起其他条件' : '编辑其他条件' }}
      </button>
      <p v-if="error || state.inputError" role="alert" class="error">
        {{ error || state.inputError }}
      </p>
      <footer>
        <button type="button" :disabled="state.inputBusy" @click="state.answerInput(request)">
          取消本次任务</button
        ><button type="submit" :disabled="state.inputBusy || !state.canWrite">
          {{ state.inputBusy ? '正在提交…' : '确认并继续' }}
        </button>
      </footer>
    </form>
  </dialog>
</template>
<style scoped>
.agent-input-dialog {
  position: fixed;
  inset: 0;
  margin: auto;
  width: min(620px, calc(100vw - 28px));
  max-height: 85vh;
  overflow: auto;
  color: #d8effc;
  background: #082436;
  border: 1px solid #38bdd7;
  border-radius: 12px;
  padding: 20px;
}
.agent-input-dialog::backdrop {
  background: rgb(0 12 24 / 65%);
}
form {
  display: grid;
  gap: 14px;
}
header,
footer,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
header,
footer {
  justify-content: space-between;
}
h2,
p {
  margin: 0;
}
h2 {
  font-size: 18px;
}
fieldset {
  display: grid;
  gap: 10px;
  border: 1px solid #275369;
  min-width: 0;
}
legend {
  color: #68d7ee;
}
input,
select,
button {
  color: #d8effc;
  background: #10354a;
  border: 1px solid #31718b;
  border-radius: 4px;
  padding: 8px;
}
input {
  min-width: 0;
}
.hint {
  color: #9dbdcc;
  font-size: 12px;
}
.skill-choice {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 10px;
}
.skill-choice input {
  width: auto;
  margin-top: 4px;
}
.skill-choice small {
  display: block;
  color: #9dbdcc;
  line-height: 1.6;
  margin-top: 5px;
}
.error {
  color: #ffc3ae;
}
.search-results {
  display: grid;
  gap: 6px;
  max-height: 170px;
  overflow: auto;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 2px solid #54d7ef;
  outline-offset: 2px;
}
</style>
