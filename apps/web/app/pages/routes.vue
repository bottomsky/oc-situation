<script setup lang="ts">
import type { Route, RouteCoordinate, RoutePlan, RouteRestrictionInput } from '@ais/contracts';
import {
  CreateRouteSchema,
  UpdateRouteSchema,
  ImportRouteSchema,
  RestrictionSchema,
  RouteSchema,
} from '@ais/contracts';
import { reorderWaypoint, routeChartHref } from '../utils/routeWorkspace';
function localDateTime(value: string | Date) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const routes = reactive(useRoutes());
const pageRoute = useRoute();
const { api } = usePlatform();
const draft = reactive({
  name: '',
  status: 'draft' as 'draft' | 'active' | 'archived',
  mmsis: '',
  waypoints: [] as RouteCoordinate[],
});
const editing = ref<Route | null>(null),
  comparison = ref<Route | null>(null),
  comparisonPlan = ref<RoutePlan | null>(null);
const search = ref(''),
  filterStatus = ref(''),
  offset = ref(0),
  formError = ref('');
const circle = reactive({ longitude: '', latitude: '', radiusMeters: '' });
const mapMode = ref<'waypoints' | 'restriction' | 'inspect'>('waypoints');
const polygon = ref<RouteCoordinate[]>([]);
const restriction = reactive({
  name: '',
  validFrom: localDateTime(new Date()),
  validUntil: '',
  enabled: true,
});
const restrictionId = ref(''),
  restrictionRevision = ref(0);
const fileInput = ref<HTMLInputElement>();
const selectedPlan = ref<RoutePlan | null>(null);
let openTurn = 0;
const planStatus = {
  queued: '排队中',
  running: '规划中',
  completed: '已生成候选',
  failed: '规划失败',
  cancelled: '已取消',
};
const statusLabel = { draft: '草稿', active: '启用', archived: '已归档' };
const planPending = computed(
  () => routes.candidate && ['queued', 'running'].includes(routes.candidate.status),
);
const currentPlan = computed(() => routes.candidate || selectedPlan.value);
const planMatches = computed(
  () =>
    routes.candidate?.status === 'completed' &&
    JSON.stringify(routes.candidate.input.waypoints) === JSON.stringify(draft.waypoints),
);
const canSave = computed(
  () => routes.canWrite && !routes.busy && !planPending.value && draft.waypoints.length >= 2,
);
async function load() {
  formError.value = '';
  const values = Object.values(circle).filter(Boolean);
  if (values.length !== 0 && values.length !== 3) {
    formError.value = '圆形筛选需要同时填写经度、纬度和半径。';
    return;
  }
  await routes.load({
    search: search.value,
    status: filterStatus.value,
    limit: 20,
    offset: offset.value,
    ...(values.length === 3
      ? {
          longitude: Number(circle.longitude),
          latitude: Number(circle.latitude),
          radiusMeters: Number(circle.radiusMeters),
        }
      : {}),
  });
}
function fresh() {
  ++openTurn;
  editing.value = null;
  selectedPlan.value = null;
  routes.clearPlan();
  Object.assign(draft, { name: '', status: 'draft', mmsis: '', waypoints: [] });
  formError.value = '';
}
async function open(route: Route) {
  const turn = ++openTurn;
  routes.clearPlan();
  selectedPlan.value = null;
  editing.value = structuredClone(toRaw(route));
  Object.assign(draft, {
    name: route.name,
    status: route.status,
    mmsis: route.mmsis.join(', '),
    waypoints: route.waypoints.map((p) => [...p] as RouteCoordinate),
  });
  await routes.detail(route.id);
  if (turn !== openTurn) return;
  if (route.planId) {
    try {
      const value = await api<RoutePlan>(`/routes/plans/${route.planId}`);
      if (turn === openTurn) selectedPlan.value = value;
    } catch {
      if (turn === openTurn) formError.value = '方案版本信息读取失败，可刷新详情重试。';
    }
  }
}
function setWaypoints(value: RouteCoordinate[]) {
  autoSavePlan.value = false;
  draft.waypoints = value;
  routes.clearPlan();
  selectedPlan.value = null;
}
function coordinate(index: number, axis: number, event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  if (!Number.isFinite(value)) return;
  const points = draft.waypoints.map((p) => [...p] as RouteCoordinate);
  points[index]![axis] = value;
  setWaypoints(points);
}
async function save(asNew = false) {
  formError.value = '';
  const metadata = {
    name: draft.name,
    status: draft.status,
    mmsis: draft.mmsis.split(/[,，\s]+/).filter(Boolean),
  };
  const manual = {
    waypoints: draft.waypoints,
    geometry: { type: 'LineString' as const, coordinates: draft.waypoints },
  };
  const existing = asNew ? undefined : editing.value || undefined;
  const unchanged =
    existing && JSON.stringify(existing.waypoints) === JSON.stringify(draft.waypoints);
  // Completed planner geometry is saved exclusively through planId, preserving provenance.
  const value = existing
    ? { ...metadata, ...(unchanged ? {} : manual), expectedRevision: existing.revision }
    : { ...metadata, ...(planMatches.value ? { planId: routes.candidate!.id } : manual) };
  const parsed = (existing ? UpdateRouteSchema : CreateRouteSchema).safeParse({
    ...value,
    operationId: crypto.randomUUID(),
  });
  if (!parsed.success) {
    formError.value = '请填写航线名称、2—10 个合法航点和九位 MMSI；起终点须与几何一致。';
    return;
  }
  if (existing && planMatches.value) {
    formError.value = '新规划作为独立方案保存，请使用“将候选保存为新方案”以保留规划来源。';
    return;
  }
  const saved = await routes.save(value, existing);
  if (saved) await open(saved);
}
async function planAndSave() {
  autoSavePlan.value = true;
  await routes.plan(draft.waypoints);
}
const autoSavePlan = ref(false);
watch(
  () => routes.candidate?.status,
  (status) => {
    if (status === 'completed' && autoSavePlan.value) {
      autoSavePlan.value = false;
      void save(true);
    } else if (status === 'failed' || status === 'cancelled') autoSavePlan.value = false;
  },
);
function startPlan() {
  autoSavePlan.value = false;
  void routes.plan(draft.waypoints);
}
async function copy() {
  if (!editing.value) return;
  const source = editing.value;
  const value = await routes.copy(source);
  if (value) {
    comparison.value = source;
    comparisonPlan.value = selectedPlan.value;
    await open(value);
  }
}
async function compare(route: Route) {
  comparison.value = structuredClone(toRaw(route));
  comparisonPlan.value = null;
  if (route.planId) {
    try {
      comparisonPlan.value = await api<RoutePlan>(`/routes/plans/${route.planId}`);
    } catch {
      formError.value = '对照方案版本暂时无法读取。';
    }
  }
}
async function archive() {
  if (editing.value) {
    const value = await routes.archive(editing.value);
    if (value) await open(value);
  }
}
async function exportFile() {
  if (!editing.value) return;
  const data = await routes.exportGeoJSON(editing.value);
  if (!data) return;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `${editing.value.name}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}
async function importFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const geojson = JSON.parse(await file.text());
    const input = ImportRouteSchema.parse({
      operationId: crypto.randomUUID(),
      name: file.name.replace(/\.(geo)?json$/i, ''),
      geojson,
    });
    const saved = await routes.importGeoJSON(input.name, input.geojson);
    if (saved) await open(saved);
  } catch {
    formError.value = '导入需要 GeoJSON Feature，几何为合法 LineString，至少两个坐标。';
  }
  (event.target as HTMLInputElement).value = '';
}
function editRestriction(value: (typeof routes.restrictions)[number]) {
  restrictionId.value = value.id;
  restrictionRevision.value = value.revision;
  Object.assign(restriction, {
    name: value.name,
    enabled: value.enabled,
    validFrom: localDateTime(value.validFrom),
    validUntil: value.validUntil ? localDateTime(value.validUntil) : '',
  });
  polygon.value =
    value.geometry.type === 'Polygon'
      ? value.geometry.coordinates[0]!.slice(0, -1)
      : value.geometry.coordinates[0]![0]!.slice(0, -1);
  mapMode.value = 'restriction';
}
function newRestriction() {
  restrictionId.value = '';
  restrictionRevision.value = 0;
  restriction.name = '';
  polygon.value = [];
  mapMode.value = 'restriction';
}
async function saveRestriction() {
  try {
    const input: Omit<RouteRestrictionInput, 'operationId'> = {
      expectedRevision: restrictionRevision.value,
      name: restriction.name,
      enabled: restriction.enabled,
      validFrom: new Date(restriction.validFrom).toISOString(),
      validUntil: restriction.validUntil ? new Date(restriction.validUntil).toISOString() : null,
      geometry: { type: 'Polygon', coordinates: [[...polygon.value, polygon.value[0]!]] },
    };
    RestrictionSchema.parse({ ...input, operationId: crypto.randomUUID() });
    const saved = await routes.saveRestriction(input, restrictionId.value || undefined);
    if (saved) {
      restrictionId.value = saved.id;
      restrictionRevision.value = saved.revision;
      if (routes.candidate) routes.candidate.stale = true;
      if (selectedPlan.value) selectedPlan.value.stale = true;
    }
  } catch {
    formError.value = '请填写禁行区名称、有效时间，并在海图上绘制至少三个边界点。';
  }
}
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: routes.loading }) });
useUiComponent('page.detail', { read: () => uiProjection(!!editing.value, []) });
useUiReadOnlyEditor(
  () => routes.canWrite,
  () => ({ draft, restriction }),
  () => routes.busy,
);
onMounted(() => {
  void load();
  void routes.loadRestrictions();
  watch(
    () => pageRoute.query.id,
    async (id) => {
      const parsed = RouteSchema.shape.id.safeParse(id);
      if (!parsed.success) return;
      const turn = ++openTurn;
      try {
        const value = RouteSchema.parse(await api(`/routes/${parsed.data}`));
        if (turn === openTurn) await open(value);
      } catch {
        if (turn === openTurn) formError.value = '当前航线详情读取失败，请刷新或检查访问权限。';
      }
    },
    { immediate: true },
  );
});
onBeforeUnmount(() => {
  ++openTurn;
});
</script>
<template>
  <main class="routes-page">
    <header class="routes-heading">
      <div>
        <p class="eyebrow">MARITIME / ROUTE OPERATIONS</p>
        <h1>计划航线工作台</h1>
        <p>绘制航点、约束规划与方案对照</p>
      </div>
      <div class="heading-actions">
        <NuxtLink to="/">返回海图</NuxtLink
        ><button :disabled="!routes.canWrite" @click="fileInput?.click()">导入 GeoJSON</button
        ><button :disabled="!routes.canWrite" class="primary" @click="fresh">＋ 新建航线</button
        ><input
          ref="fileInput"
          type="file"
          accept=".json,.geojson,application/geo+json"
          hidden
          @change="importFile"
        />
      </div>
    </header>
    <p v-if="!routes.canWrite" class="info">当前账号为只读权限，可查询、对照和导出航线。</p>
    <p v-if="routes.error || formError" role="alert" class="error">
      {{ formError || routes.error }}
      <button v-if="editing" @click="routes.detail(editing.id)">刷新服务端详情（保留草稿）</button>
    </p>
    <div class="routes-grid">
      <aside class="routes-library panel">
        <div class="panel-heading">
          <h2>航线库</h2>
          <span>{{ routes.total }} 条</span>
        </div>
        <form
          class="filters"
          @submit.prevent="
            offset = 0;
            load();
          "
        >
          <input v-model="search" aria-label="搜索航线" placeholder="搜索航线名称" /><select
            v-model="filterStatus"
            aria-label="状态筛选"
          >
            <option value="">全部状态</option>
            <option value="draft">草稿</option>
            <option value="active">启用</option>
            <option value="archived">归档</option>
          </select>
          <details>
            <summary>精确圆形范围</summary>
            <input
              v-model="circle.longitude"
              aria-label="筛选中心经度"
              placeholder="中心经度"
              type="number"
              step="any"
            /><input
              v-model="circle.latitude"
              aria-label="筛选中心纬度"
              placeholder="中心纬度"
              type="number"
              step="any"
            /><input
              v-model="circle.radiusMeters"
              aria-label="筛选半径米"
              placeholder="半径（米）"
              type="number"
              min="100"
              max="2000000"
            />
          </details>
          <button type="submit">查询航线</button>
        </form>
        <p v-if="routes.loading" class="muted">正在查询…</p>
        <p v-else-if="!routes.items.length" class="empty">
          暂无符合条件的航线<br />从海图放置起点与终点开始
        </p>
        <article
          v-for="item in routes.items"
          :key="item.id"
          class="library-route"
          :class="{ selected: editing?.id === item.id }"
        >
          <button class="route-select" @click="open(item)">
            <strong>{{ item.name }}</strong
            ><span>{{ statusLabel[item.status] }} · 修订 {{ item.revision }}</span
            ><b>{{ (item.lengthMeters / 1852).toFixed(1) }} <small>海里</small></b></button
          ><button class="compare-link" @click="compare(item)">设为对照</button>
        </article>
        <nav class="pagination">
          <button
            :disabled="offset === 0"
            @click="
              offset -= 20;
              load();
            "
          >
            上一页</button
          ><span>{{ Math.floor(offset / 20) + 1 }}</span
          ><button
            :disabled="offset + 20 >= routes.total"
            @click="
              offset += 20;
              load();
            "
          >
            下一页
          </button>
        </nav>
      </aside>
      <section class="map-column">
        <div class="map-toolbar">
          <button :class="{ chosen: mapMode === 'waypoints' }" @click="mapMode = 'waypoints'">
            航点编辑</button
          ><button
            :class="{ chosen: mapMode === 'restriction' }"
            :disabled="!routes.canWrite"
            @click="mapMode = 'restriction'"
          >
            禁行区绘制</button
          ><button :class="{ chosen: mapMode === 'inspect' }" @click="mapMode = 'inspect'">
            浏览海图</button
          ><span>WGS 84 · {{ draft.waypoints.length }}/10 航点</span>
        </div>
        <ClientOnly
          ><RouteMap
            :waypoints="draft.waypoints"
            :candidate="currentPlan"
            :saved-route="editing"
            :comparison="comparison"
            :restrictions="routes.restrictions"
            :polygon="polygon"
            :mode="mapMode"
            :readonly="!routes.canWrite"
            @update:waypoints="setWaypoints"
            @update:polygon="polygon = $event"
        /></ClientOnly>
        <div v-if="currentPlan || comparison" class="comparison panel">
          <div>
            <h2>当前方案</h2>
            <strong>{{
              currentPlan?.result
                ? (currentPlan.result.lengthMeters / 1852).toFixed(1) + ' 海里'
                : editing
                  ? (editing.lengthMeters / 1852).toFixed(1) + ' 海里'
                  : '待规划'
            }}</strong
            ><span>数据 {{ currentPlan?.datasetVersion || '手绘 / 未关联数据' }}</span
            ><span>约束版本 {{ currentPlan?.restrictionVersion ?? '—' }}</span>
          </div>
          <div v-if="comparison">
            <h2>对照 · {{ comparison.name }}</h2>
            <strong>{{ (comparison.lengthMeters / 1852).toFixed(1) }} 海里</strong
            ><span>数据 {{ comparisonPlan?.datasetVersion || '手绘 / 未关联数据' }}</span
            ><span>约束版本 {{ comparisonPlan?.restrictionVersion ?? '—' }}</span
            ><button @click="comparison = null">清除对照</button>
          </div>
        </div>
      </section>
      <aside class="editor panel">
        <div class="panel-heading">
          <h2>{{ editing ? '编辑航线' : '新建航线' }}</h2>
          <span>{{ editing ? '修订 ' + editing.revision : '未保存' }}</span>
        </div>
        <fieldset :disabled="!routes.canWrite || routes.busy">
          <label
            >航线名称<input
              v-model="draft.name"
              aria-label="航线名称"
              maxlength="200"
              placeholder="如：舟山—宁波进港方案" /></label
          ><label
            >状态<select v-model="draft.status" aria-label="航线状态">
              <option value="draft">草稿</option>
              <option value="active">启用</option>
              <option value="archived">归档</option>
            </select></label
          ><label
            >关联船舶 MMSI<input
              v-model="draft.mmsis"
              aria-label="关联船舶 MMSI"
              placeholder="九位 MMSI，以逗号分隔"
          /></label>
          <div class="waypoint-heading">
            <h3>有序航点</h3>
            <button
              :disabled="draft.waypoints.length >= 10"
              @click="setWaypoints([...draft.waypoints, [123, 30]])"
            >
              ＋ 航点
            </button>
          </div>
          <div v-for="(point, index) in draft.waypoints" :key="index" class="waypoint">
            <b>{{ String(index + 1).padStart(2, '0') }}</b>
            <div>
              <input
                :value="point[0]"
                :aria-label="`航点${index + 1}经度`"
                type="number"
                min="-180"
                max="180"
                step="0.0001"
                @change="coordinate(index, 0, $event)"
              /><input
                :value="point[1]"
                :aria-label="`航点${index + 1}纬度`"
                type="number"
                min="-85"
                max="85"
                step="0.0001"
                @change="coordinate(index, 1, $event)"
              />
            </div>
            <div class="waypoint-controls">
              <button
                :disabled="index === 0"
                :aria-label="`上移航点${index + 1}`"
                @click="setWaypoints(reorderWaypoint(draft.waypoints, index, -1))"
              >
                ↑</button
              ><button
                :disabled="index === draft.waypoints.length - 1"
                :aria-label="`下移航点${index + 1}`"
                @click="setWaypoints(reorderWaypoint(draft.waypoints, index, 1))"
              >
                ↓</button
              ><button
                :aria-label="`删除航点${index + 1}`"
                @click="setWaypoints(draft.waypoints.filter((_, i) => i !== index))"
              >
                ×
              </button>
            </div>
          </div>
          <p v-if="draft.waypoints.length < 2" class="muted">
            在海图点击两个位置，或添加并编辑坐标。
          </p>
        </fieldset>
        <div class="plan-actions">
          <button :disabled="!canSave || !!planPending" @click="startPlan">规划航路</button
          ><button :disabled="!canSave || !!planPending || !draft.name.trim()" @click="planAndSave">
            规划并保存新方案</button
          ><button
            v-if="planPending"
            :disabled="!routes.canWrite"
            @click="
              autoSavePlan = false;
              routes.cancelPlan();
            "
          >
            取消规划
          </button>
        </div>
        <p v-if="routes.candidate" class="info" role="status">
          {{ planStatus[routes.candidate.status]
          }}{{ routes.candidate.status === 'completed' ? ' · 确认后单独保存航线' : '' }}
        </p>
        <p v-if="currentPlan?.stale" class="warning">数据或禁行约束已变化，此方案需要重新规划。</p>
        <button class="primary save-route" :disabled="!canSave" @click="save()">保存航线</button
        ><button v-if="editing && planMatches" :disabled="!canSave" @click="save(true)">
          将候选保存为新方案
        </button>
        <div v-if="editing" class="detail-actions">
          <button :disabled="!routes.canWrite || routes.busy" @click="copy">复制为独立方案</button
          ><button
            :disabled="!routes.canWrite || routes.busy || editing.status === 'archived'"
            @click="archive"
          >
            归档航线</button
          ><button @click="exportFile">导出 GeoJSON</button
          ><NuxtLink :to="routeChartHref(editing.id)">在海图关注</NuxtLink
          ><NuxtLink :to="routeChartHref(editing.id, true)">询问此航线</NuxtLink>
        </div>
        <details v-if="editing" class="history">
          <summary>详情与修订历史 · {{ routes.history.length }}</summary>
          <p>来源 {{ editing.generatedBy }} · {{ editing.mmsis.length }} 艘关联船舶</p>
          <p>当前版本 {{ routes.selected?.revision }} · {{ routes.selected?.updatedAt }}</p>
          <p v-for="item in routes.history" :key="item.revision">
            修订 {{ item.revision }} · {{ statusLabel[item.status] }} · {{ item.name }}
          </p>
        </details>
      </aside>
    </div>
    <section class="restrictions panel">
      <div class="panel-heading">
        <h2>禁行约束</h2>
        <button :disabled="!routes.canWrite" @click="newRestriction">新建禁行区</button>
      </div>
      <div class="restriction-grid">
        <div>
          <button
            v-for="item in routes.restrictions"
            :key="item.id"
            class="restriction-row"
            @click="editRestriction(item)"
          >
            <strong>{{ item.name }}</strong
            ><span
              >{{ item.enabled ? '启用' : '停用' }} · 版本 {{ item.version }} · 修订
              {{ item.revision }}</span
            ><small>{{ item.validFrom }} — {{ item.validUntil || '长期有效' }}</small>
          </button>
          <p v-if="!routes.restrictions.length" class="muted">暂无禁行区域</p>
        </div>
        <fieldset :disabled="!routes.canWrite || routes.busy" class="restriction-form">
          <label>禁行区名称<input v-model="restriction.name" aria-label="禁行区名称" /></label
          ><label>有效起始<input v-model="restriction.validFrom" type="datetime-local" /></label
          ><label>有效截止<input v-model="restriction.validUntil" type="datetime-local" /></label
          ><label class="toggle"
            ><input v-model="restriction.enabled" type="checkbox" />启用约束</label
          >
          <div>
            <span>{{ polygon.length }} 个边界点</span><button @click="polygon = []">清空边界</button
            ><button @click="saveRestriction">
              {{ restrictionId ? '保存禁行区新版本' : '保存禁行区' }}
            </button>
          </div>
        </fieldset>
      </div>
    </section>
  </main>
</template>
<style scoped>
.routes-page {
  --edge: #244957;
  --muted: #82a9b7;
  color: #d9eaf0;
  max-width: 1920px;
  margin: auto;
  padding: 24px;
  background: radial-gradient(ellipse at 40% 0, #123341 0, transparent 55%), #071923;
  min-height: 100vh;
  font-size: 13px;
}
.routes-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 3px;
  color: #65caba;
  margin-bottom: 6px;
}
h1 {
  font-size: 25px;
  letter-spacing: 2px;
  margin: 0;
}
h2 {
  font-size: 14px;
  margin: 0;
}
h3 {
  font-size: 12px;
  margin: 0;
}
.routes-heading p:last-child {
  color: var(--muted);
  margin: 7px 0 0;
}
.heading-actions,
.plan-actions,
.detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.routes-grid {
  display: grid;
  grid-template-columns: 240px minmax(360px, 1fr) 310px;
  gap: 16px;
  align-items: start;
}
.panel {
  border: 1px solid var(--edge);
  border-radius: 10px;
  background: #0b2430d9;
  overflow: hidden;
}
.panel-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--edge);
}
.panel-heading > span {
  color: var(--muted);
  font-size: 11px;
}
.filters {
  padding: 12px;
  display: grid;
  gap: 8px;
}
input,
select {
  background: #081e2a;
  border: 1px solid #315361;
  color: #d9eaf0;
  min-width: 0;
  border-radius: 5px;
  padding: 8px;
  font-size: 12px;
  width: 100%;
}
input:focus,
select:focus {
  outline: 1px solid #5eead4;
}
button,
a {
  background: #123543;
  border: 1px solid #2b5868;
  color: #bfe6eb;
  border-radius: 5px;
  padding: 7px 10px;
  font-size: 12px;
  cursor: pointer;
  text-decoration: none;
  transition: border-color 0.15s;
}
button:hover,
a:hover {
  border-color: #5eead4;
}
button:disabled {
  opacity: 0.4;
  cursor: default;
}
.primary {
  background: #175c5a;
  border-color: #2b9c8f;
  color: #d7fff4;
}
.chosen {
  background: #17504f;
  color: #9cffee;
}
.library-route {
  position: relative;
  border-top: 1px solid #1c3e4b;
  padding: 8px;
}
.library-route.selected {
  background: #15434b;
  border-left: 3px solid #5eead4;
}
.route-select {
  border: 0;
  background: transparent;
  display: grid;
  text-align: left;
  width: 100%;
  gap: 7px;
  padding: 8px;
}
.route-select strong {
  font-size: 13px;
}
.route-select span,
.route-select small {
  color: var(--muted);
  font-size: 11px;
}
.route-select b {
  font-family: ui-monospace, monospace;
  font-size: 18px;
  font-weight: 500;
}
.compare-link {
  position: absolute;
  right: 12px;
  bottom: 14px;
  font-size: 10px;
  padding: 4px 6px;
}
.pagination {
  display: flex;
  gap: 8px;
  justify-content: center;
  align-items: center;
  padding: 12px;
}
.map-column {
  display: grid;
  grid-template-rows: auto minmax(490px, 1fr) auto;
  gap: 12px;
  min-width: 0;
}
.map-toolbar {
  display: flex;
  gap: 7px;
  align-items: center;
  flex-wrap: wrap;
}
.map-toolbar span {
  margin-left: auto;
  color: var(--muted);
  font-size: 10px;
}
.editor > fieldset {
  padding: 14px;
}
.editor label {
  display: grid;
  gap: 6px;
  margin-bottom: 12px;
  color: #a9c5d0;
  font-size: 11px;
}
fieldset {
  border: 0;
  margin: 0;
  min-width: 0;
}
fieldset:disabled {
  opacity: 0.65;
}
.waypoint-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 16px 0 10px;
}
.waypoint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.waypoint > b {
  font:
    12px ui-monospace,
    monospace;
  color: #60d7c6;
}
.waypoint > div {
  display: grid;
  gap: 4px;
  min-width: 0;
}
.waypoint input {
  padding: 5px 7px;
  font-family: ui-monospace, monospace;
}
.waypoint-controls {
  display: flex !important;
  gap: 3px !important;
}
.waypoint-controls button {
  padding: 4px 5px;
}
.plan-actions,
.detail-actions {
  padding: 0 14px 12px;
}
.save-route {
  display: block;
  width: calc(100% - 28px);
  margin: 0 14px 14px;
}
.detail-actions > * {
  font-size: 11px;
}
.muted,
.empty {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.empty {
  padding: 28px 12px;
  text-align: center;
}
.info,
.warning,
.error {
  padding: 11px 14px;
  border-radius: 6px;
  margin: 0 0 12px;
  background: #123b45;
  color: #8ee8da;
}
.error {
  background: #442d30;
  color: #ffb8b8;
  border: 1px solid #784248;
}
.warning {
  background: #4a3d1f;
  color: #f9d88e;
}
.editor .info,
.editor .warning {
  margin: 0 14px 12px;
}
.comparison {
  display: flex;
  padding: 16px;
  gap: 28px;
}
.comparison > div {
  display: grid;
  gap: 6px;
  flex: 1;
}
.comparison strong {
  font:
    22px ui-monospace,
    monospace;
  color: #5eead4;
}
.comparison > div + div {
  border-left: 1px solid var(--edge);
  padding-left: 24px;
}
.comparison > div + div strong {
  color: #fbbf24;
}
.comparison span {
  color: var(--muted);
  font-size: 11px;
}
.history {
  padding: 14px;
  border-top: 1px solid var(--edge);
  font-size: 11px;
  color: var(--muted);
}
summary {
  cursor: pointer;
  padding: 6px 0;
}
details input {
  margin-top: 6px;
}
.restrictions {
  margin-top: 18px;
}
.restriction-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  padding: 16px;
}
.restriction-row {
  display: grid;
  text-align: left;
  gap: 7px;
  width: 100%;
  margin-bottom: 8px;
}
.restriction-row span,
.restriction-row small {
  color: var(--muted);
  font-size: 11px;
}
.restriction-form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.restriction-form label {
  display: grid;
  gap: 5px;
  color: var(--muted);
  font-size: 11px;
}
.restriction-form > div {
  grid-column: 1/-1;
  display: flex;
  gap: 10px;
  align-items: center;
}
.restriction-form .toggle {
  display: flex;
  align-items: center;
}
.toggle input {
  width: auto;
}
@media (min-width: 1600px) {
  .routes-grid {
    grid-template-columns: 270px minmax(400px, 1fr) 340px;
  }
  .map-column {
    grid-template-rows: auto minmax(620px, 1fr) auto;
  }
}
@media (max-width: 1150px) {
  .routes-grid {
    grid-template-columns: 200px minmax(320px, 1fr);
  }
  .editor {
    grid-column: 1/-1;
  }
  .editor > fieldset {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
  }
  .waypoint-heading {
    grid-column: 1/-1;
  }
  .restriction-grid {
    grid-template-columns: 1fr;
  }
  .heading-actions {
    justify-content: flex-end;
  }
}
@media (max-width: 700px) {
  .routes-page {
    padding: 12px;
  }
  .routes-heading {
    align-items: flex-start;
    gap: 12px;
    flex-direction: column;
  }
  .routes-grid {
    display: flex;
    flex-direction: column;
  }
  .routes-grid > * {
    width: 100%;
  }
  .routes-library {
    max-height: 330px;
    overflow: auto;
  }
  .editor > fieldset {
    display: block;
  }
  .map-column {
    min-height: 520px;
  }
  .comparison {
    flex-direction: column;
  }
  .comparison > div + div {
    border-left: 0;
    border-top: 1px solid var(--edge);
    padding: 12px 0 0;
  }
  .restriction-form {
    grid-template-columns: 1fr;
  }
  .restriction-form > div {
    flex-wrap: wrap;
  }
}
</style>
