<script setup lang="ts">
import {
  CreateOperationalEventSchema,
  UpdateOperationalEventSchema,
  OperationalEventSchema,
  type OperationalEvent,
  type OperationalEventFields,
  type OperationalEventSource,
  type CircleRegion,
} from '@ais/contracts';
import {
  emptyEvent,
  eventPatch,
  eventChartHref,
  eventStatusLabels,
  eventSeverityLabels,
} from '../utils/operationalEvents';
const events = reactive(useOperationalEvents());
const pageRoute = useRoute();
const draft = reactive(emptyEvent()),
  base = ref<OperationalEvent | null>(null),
  creating = ref(false),
  releases = ref<string[]>([]),
  formError = ref('');
const keyword = ref(''),
  status = ref(''),
  offset = ref(0),
  circle = reactive({ lon: '', lat: '', radius: '' });
const mmsis = ref(''),
  routeIds = ref(''),
  occurred = ref(''),
  mergeId = ref(''),
  mergeSource = ref(''),
  mergeTarget = ref<OperationalEvent | null>(null),
  mergeSources = ref<OperationalEventSource[]>([]),
  historical = ref<OperationalEvent | null>(null);
const { api } = usePlatform();
let turn = 0,
  mergeTurn = 0;
async function load(reset = false) {
  if (reset) offset.value = 0;
  const values = Object.values(circle).filter(Boolean);
  let region: CircleRegion | undefined;
  if (values.length && values.length !== 3) {
    formError.value = '圆形筛选请完整填写经度、纬度和半径。';
    return;
  }
  if (values.length)
    region = {
      kind: 'circle',
      center: [Number(circle.lon), Number(circle.lat)],
      radiusMeters: Number(circle.radius),
    };
  formError.value = '';
  await events.load({
    keyword: keyword.value,
    ...(status.value ? { status: status.value as OperationalEvent['status'] } : {}),
    limit: 20,
    offset: offset.value,
    ...(region ? { circle: region } : {}),
  });
}
function assign(value: OperationalEvent | null) {
  ++mergeTurn;
  base.value = value;
  Object.assign(
    draft,
    value
      ? Object.fromEntries(
          Object.keys(emptyEvent()).map((k) => [k, value[k as keyof OperationalEventFields]]),
        )
      : emptyEvent(),
  );
  mmsis.value = draft.linkedMmsis.join(', ');
  routeIds.value = draft.linkedRouteIds.join(', ');
  occurred.value = draft.occurredAt?.slice(0, 16) ?? '';
  releases.value = [];
  historical.value = null;
  creating.value = !value;
  mergeId.value = '';
  mergeSource.value = '';
  mergeTarget.value = null;
  mergeSources.value = [];
}
async function open(id: string) {
  const current = ++turn;
  const value = await events.detail(id);
  if (current === turn && value) assign(value);
}
function fresh() {
  ++turn;
  events.clear();
  assign(null);
}
async function save() {
  formError.value = '';
  let timestamp: string | null = null;
  if (occurred.value) {
    const date = new Date(occurred.value + 'Z');
    if (!Number.isFinite(date.getTime())) {
      formError.value = '发生时间无效。';
      return;
    }
    timestamp = date.toISOString();
  }
  const fields = {
    ...draft,
    occurredAt: timestamp,
    linkedMmsis: mmsis.value.split(/[,，\s]+/).filter(Boolean),
    linkedRouteIds: routeIds.value.split(/[,，\s]+/).filter(Boolean),
  };
  const body = base.value
    ? {
        expectedRevision: base.value.revision,
        fields: eventPatch(base.value, fields, releases.value),
        releaseOverrides: releases.value,
      }
    : fields;
  const parsed = (
    base.value ? UpdateOperationalEventSchema : CreateOperationalEventSchema
  ).safeParse({ ...body, operationId: crypto.randomUUID() });
  if (!parsed.success) {
    formError.value = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('；');
    return;
  }
  const current = turn,
    saved = await events.mutate(
      base.value ? `/operational-events/${base.value.id}` : '/operational-events',
      body,
      base.value ? 'PATCH' : 'POST',
    );
  if (saved && current === turn) await open(saved.id);
}
async function transition(value: 'active' | 'resolved' | 'archived') {
  if (!base.value) return;
  const current = turn,
    saved = await events.mutate(`/operational-events/${base.value.id}`, {
      expectedRevision: base.value.revision,
      status: value,
    });
  if (saved && current === turn) await open(saved.id);
}
async function target() {
  const current = ++mergeTurn;
  mergeTarget.value = null;
  mergeSources.value = [];
  mergeSource.value = '';
  if (!mergeId.value) return;
  try {
    const [value, sources] = await Promise.all([
      api<OperationalEvent>(`/operational-events/${mergeId.value}`),
      api<{ items: OperationalEventSource[] }>(`/operational-events/${mergeId.value}/sources`),
    ]);
    if (current !== mergeTurn) return;
    mergeTarget.value = value;
    mergeSources.value = sources.items;
  } catch {
    if (current === mergeTurn) formError.value = '合并目标读取失败。';
  }
}
const allSources = computed(() => [
  ...new Map([...events.sources, ...mergeSources.value].map((s) => [s.key, s])).values(),
]);
async function merge() {
  if (!base.value || !mergeTarget.value || !mergeSource.value) return;
  const current = turn,
    saved = await events.mutate(
      `/operational-events/${base.value.id}/merge`,
      {
        targetId: mergeTarget.value.id,
        expectedRevision: base.value.revision,
        targetExpectedRevision: mergeTarget.value.revision,
        primarySourceKey: mergeSource.value,
      },
      'POST',
    );
  if (saved && current === turn) await open(saved.id);
}
function release(key: string, e: Event) {
  releases.value = (e.target as HTMLInputElement).checked
    ? [...releases.value, key]
    : releases.value.filter((k) => k !== key);
}
onMounted(() => {
  void load();
  watch(
    () => pageRoute.query.id,
    (id) => {
      const parsed = OperationalEventSchema.shape.id.safeParse(id);
      if (parsed.success) void open(parsed.data);
    },
    { immediate: true },
  );
});
onBeforeUnmount(() => {
  ++turn;
  ++mergeTurn;
});
</script>
<template>
  <main class="events-workbench">
    <header class="events-heading">
      <div>
        <small>MARITIME OPERATIONS / EVENT DESK</small>
        <h1>业务事件工作台</h1>
        <p>独立事件档案 · 来源证据 · 处置进程</p>
      </div>
      <div>
        <button v-if="events.isAdmin" :disabled="events.busy" @click="events.backfill">
          同步历史来源</button
        ><button v-if="events.canWrite" @click="fresh">＋ 人工创建事件</button>
      </div>
    </header>
    <p v-if="events.error || formError" role="alert" class="event-error">
      {{ formError || events.error }}
    </p>
    <div class="events-layout">
      <aside class="event-list">
        <form @submit.prevent="load(true)">
          <input v-model="keyword" aria-label="事件关键词" placeholder="检索标题与摘要" /><select
            v-model="status"
            aria-label="事件状态"
          >
            <option value="">全部状态</option>
            <option v-for="(label, key) in eventStatusLabels" :key="key" :value="key">
              {{ label }}
            </option>
          </select>
          <details>
            <summary>圆形范围筛选</summary>
            <input
              v-model="circle.lon"
              type="number"
              aria-label="中心经度"
              placeholder="经度"
              min="-180"
              max="180"
              step="any"
            /><input
              v-model="circle.lat"
              type="number"
              aria-label="中心纬度"
              placeholder="纬度"
              min="-90"
              max="90"
              step="any"
            /><input
              v-model="circle.radius"
              type="number"
              aria-label="半径米"
              placeholder="半径（米）"
              min="100"
              max="2000000"
            />
          </details>
          <button :disabled="events.loading">筛选事件</button>
        </form>
        <p class="muted">共 {{ events.total }} 条 · {{ events.loading ? '更新中' : '实时档案' }}</p>
        <button
          v-for="item in events.items"
          :key="item.id"
          class="event-row"
          :class="{ active: base?.id === item.id }"
          @click="open(item.id)"
        >
          <small
            >{{ eventStatusLabels[item.status] }} · {{ eventSeverityLabels[item.severity] }}</small
          ><strong>{{ item.title }}</strong
          ><span>{{ item.geometry ? '已定位' : '未定位' }} · 修订 {{ item.revision }}</span>
        </button>
        <p v-if="!events.items.length && !events.loading" class="muted">当前条件下没有业务事件。</p>
        <nav class="pagination">
          <button
            :disabled="offset === 0"
            @click="
              offset = Math.max(0, offset - 20);
              load();
            "
          >
            上一页</button
          ><span>{{ Math.floor(offset / 20) + 1 }}</span
          ><button
            :disabled="offset + 20 >= events.total"
            @click="
              offset += 20;
              load();
            "
          >
            下一页
          </button>
        </nav>
      </aside>
      <section class="event-detail">
        <template v-if="base || creating"
          ><header class="detail-heading">
            <div>
              <small>{{ base ? `实时档案 / 修订 ${base.revision}` : '人工新建' }}</small>
              <h2>{{ base?.title || '创建业务事件' }}</h2>
            </div>
            <NuxtLink v-if="base" :to="eventChartHref(base.id)">海图定位与分析 ↗</NuxtLink>
          </header>
          <p v-if="events.updated" role="status" class="update-note">
            服务端已有新修订，当前草稿保留。<button @click="open(base!.id)">
              读取最新版本（替换草稿）
            </button>
          </p>
          <form @submit.prevent="save">
            <fieldset :disabled="!events.canWrite || events.busy || base?.status === 'merged'">
              <label>事件标题<input v-model="draft.title" required maxlength="500" /></label>
              <div class="field-grid">
                <label>类别<input v-model="draft.category" required /></label
                ><label
                  >级别<select v-model="draft.severity">
                    <option v-for="(label, key) in eventSeverityLabels" :key="key" :value="key">
                      {{ label }}
                    </option>
                  </select></label
                ><label>发生时间（UTC）<input v-model="occurred" type="datetime-local" /></label>
              </div>
              <label>摘要<textarea v-model="draft.summary" rows="4" /></label
              ><label
                >关联船舶 MMSI<input
                  v-model="mmsis"
                  placeholder="多个九位 MMSI 用逗号分隔" /></label
              ><label
                >关联航线 ID<input
                  v-model="routeIds"
                  placeholder="多个航线 UUID 用逗号分隔" /></label
              ><ClientOnly
                ><OperationalEventGeometry
                  :key="base?.id ?? 'new'"
                  v-model="draft.geometry"
                  :readonly="!events.canWrite || events.busy"
              /></ClientOnly>
              <section v-if="base && Object.keys(base.overrides).length" class="source-override">
                <h3>人工覆盖字段</h3>
                <p class="muted">勾选字段后保存，将恢复随主来源更新；其余人工编辑保持。</p>
                <label v-for="key in Object.keys(base.overrides)" :key="key" class="inline"
                  ><input
                    type="checkbox"
                    :checked="releases.includes(key)"
                    @change="release(key, $event)"
                  />{{ key }} · 人工覆盖 → 恢复来源值
                  <code>{{
                    base.sourceSuggestions[key as keyof OperationalEventFields] ?? '无来源建议'
                  }}</code></label
                >
              </section>
              <button v-if="events.canWrite" class="primary" type="submit">
                {{ events.busy ? '提交中…' : '保存事件' }}
              </button>
            </fieldset>
          </form>
          <div v-if="base && events.canWrite && base.status !== 'merged'" class="actions">
            <span>处置状态：{{ eventStatusLabels[base.status] }}</span
            ><button
              v-for="s in ['active', 'resolved', 'archived'] as const"
              :key="s"
              :disabled="events.busy || base.status === s"
              @click="transition(s)"
            >
              {{ eventStatusLabels[s] }}
            </button>
          </div>
          <section v-if="base" class="evidence">
            <h3>来源证据与审核状态</h3>
            <p class="muted">来源发布、审核与撤回状态独立记录；业务处置状态见上方。</p>
            <article v-for="s in events.sources" :key="s.key">
              <strong>{{ s.externalId }}</strong
              ><span
                >{{ s.kind }} · 来源版本 {{ s.version }} · 发布 {{ s.status }} · 审核
                {{ s.reviewStatus }} {{ s.key === base.primarySourceKey ? '· 主来源' : '' }}</span
              ><button @click="events.readSource(s.key)">来源历史快照</button>
            </article>
            <p v-if="!events.sources.length">人工事件暂无来源证据。</p>
            <pre v-if="events.sourceHistory.length">{{
              JSON.stringify(events.sourceHistory, null, 2)
            }}</pre>
            <h3>业务修订历史快照</h3>
            <button v-for="h in events.history" :key="h.revision" @click="historical = h">
              修订 {{ h.revision }} · {{ h.updatedAt }}
            </button>
            <article v-if="historical" class="historical">
              <strong>历史快照 · 修订 {{ historical.revision }}（只读）</strong>
              <pre>{{ JSON.stringify(historical, null, 2) }}</pre>
              <button @click="historical = null">关闭快照</button>
            </article>
          </section>
          <details v-if="base && events.canWrite && base.status !== 'merged'" class="merge">
            <summary>合并重复事件</summary>
            <p>将当前事件并入目标，保留双方来源与历史。选择主来源后提交。</p>
            <select v-model="mergeId" aria-label="合并目标" @change="target">
              <option value="">选择目标事件</option>
              <option
                v-for="item in events.items.filter(
                  (e) => e.id !== base?.id && e.status !== 'merged',
                )"
                :key="item.id"
                :value="item.id"
              >
                {{ item.title }} · r{{ item.revision }}
              </option></select
            ><select v-model="mergeSource" aria-label="合并主来源">
              <option value="">选择主来源</option>
              <option v-for="s in allSources" :key="s.key" :value="s.key">
                {{ s.externalId }} · {{ s.key }}
              </option></select
            ><button :disabled="!mergeTarget || !mergeSource || events.busy" @click="merge">
              确认合并至目标
            </button>
          </details></template
        >
        <div v-else class="event-empty">
          <span>◎</span>
          <h2>选择业务事件</h2>
          <p>查看独立档案、关联来源与处置历史，或创建人工事件。</p>
        </div>
      </section>
    </div>
  </main>
</template>
<style scoped>
.events-workbench {
  padding: 28px;
  color: #d7eaed;
  background: radial-gradient(ellipse at 80% 0, #123c48 0, transparent 55%), #071b25;
  min-height: calc(100vh - 60px);
}
.events-heading,
.detail-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.events-heading small {
  letter-spacing: 3px;
  color: #62cebf;
  font-size: 10px;
}
.events-heading h1 {
  font-size: 28px;
  margin: 8px 0;
}
.events-heading p,
.muted {
  color: #89aab5;
  font-size: 13px;
}
.events-layout {
  display: grid;
  grid-template-columns: 310px minmax(0, 1fr);
  gap: 22px;
  margin-top: 28px;
}
.event-list,
.event-detail {
  border: 1px solid #264958;
  background: #0b2530cc;
  border-radius: 10px;
  padding: 20px;
}
.event-list form {
  display: grid;
  gap: 10px;
}
.event-row {
  width: 100%;
  text-align: left;
  display: grid;
  gap: 8px;
  margin: 8px 0;
  padding: 15px !important;
  background: #112f3b !important;
}
.event-row.active {
  border-color: #5cd3c2 !important;
  background: #154451 !important;
}
.event-row small {
  color: #68d4c6;
}
.event-row span {
  font-size: 12px;
  color: #93b2bd;
}
.events-workbench input,
.events-workbench select,
.events-workbench textarea {
  background: #081e29;
  border: 1px solid #315364;
  color: #e0edf0;
  border-radius: 5px;
  padding: 9px;
  width: 100%;
}
.events-workbench button {
  border: 1px solid #35616f;
  border-radius: 5px;
  padding: 8px 12px;
  background: #173c49;
  color: #def3f1;
  cursor: pointer;
}
.events-workbench button:disabled {
  opacity: 0.45;
  cursor: default;
}
.events-workbench a {
  color: #69daca;
}
.event-detail label {
  display: grid;
  gap: 7px;
  margin: 13px 0;
  font-size: 13px;
}
.event-detail fieldset {
  border: 0;
  padding: 0;
  min-width: 0;
}
.field-grid {
  display: grid;
  grid-template-columns: 1fr 1fr 1.4fr;
  gap: 14px;
}
.primary {
  background: #277a72 !important;
  margin-top: 16px;
}
.pagination,
.actions {
  display: flex;
  gap: 12px;
  align-items: center;
  margin: 20px 0;
}
.event-error {
  padding: 14px;
  border: 1px solid #9c6158;
  color: #ffc5b3;
  background: #4b2925;
}
.update-note {
  padding: 14px;
  background: #51472a;
  color: #ffe4a4;
}
.source-override,
.evidence,
.merge {
  border-top: 1px solid #31505d;
  margin-top: 25px;
  padding-top: 16px;
}
.source-override .inline {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
}
.inline input {
  width: auto;
}
.evidence article {
  display: grid;
  gap: 9px;
  margin: 12px 0;
  padding: 14px;
  background: #102f3b;
}
.evidence span {
  font-size: 12px;
  color: #a8c6cf;
}
.evidence button {
  margin: 3px;
}
.evidence pre {
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 400px;
  overflow: auto;
  font-size: 12px;
}
.merge select {
  margin: 10px 0;
}
.event-empty {
  text-align: center;
  padding: 100px 30px;
  color: #8caeb8;
}
.event-empty > span {
  font-size: 80px;
  color: #3f9b99;
}
.historical {
  border: 1px solid #8b8053;
}
h3 {
  font-size: 15px;
}
@media (max-width: 900px) {
  .events-layout {
    grid-template-columns: 1fr;
  }
  .field-grid {
    grid-template-columns: 1fr;
  }
  .events-workbench {
    padding: 15px;
  }
  .events-heading {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
