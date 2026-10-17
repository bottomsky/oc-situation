<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { IntelligenceCategorySchema } from '@ais/contracts';
import {
  categoryLabels,
  reviewLabels,
  statusLabels,
  objectLabels,
} from '../utils/intelligenceLabels';
import { dateLabel } from '../utils/display';
const state = defineModel<UnwrapNestedRefs<ReturnType<typeof useIntelligenceWorkspace>>>('state', {
  required: true,
});
const emit = defineEmits<{ select: [id: string]; locate: [id?: string] }>();
const objectSearch = ref('');
const filteredObjects = computed(() =>
  state.value.objects.filter(
    (o) =>
      o.id === draft.objectId || [o.name, ...o.aliases].some((v) => v.includes(objectSearch.value)),
  ),
);
const categories = IntelligenceCategorySchema.options;
const filterOpen = ref(false);
const layerOpen = ref(false);
const draft = reactive({ ...state.value.filters, viewportOnly: false });
const timePreset = ref('custom');
const filterError = ref('');
const layerNames = {
  location: '发生位置',
  object: '对象关联',
  impact: '影响范围',
  candidate: '待核实关系',
  directory: '对象目录',
};
const layerDraft = reactive({ ...state.value.layerVisibility, includeCandidates: false });
const filterItems = computed(() => {
  const f = state.value.filters;
  const labels: Record<string, string> = {
    keyword: `关键词：${f.keyword}`,
    category: `类别：${categoryLabels[f.category] ?? f.category}`,
    sourceId: `来源：${state.value.sources.find((s) => s.sourceId === f.sourceId)?.name ?? f.sourceId}`,
    reviewStatus: `审核：${reviewLabels[f.reviewStatus] ?? f.reviewStatus}`,
    status: `状态：${statusLabels[f.status] ?? f.status}`,
    from: `起：${f.from.replace('T', ' ')} UTC`,
    to: `止：${f.to.replace('T', ' ')} UTC`,
    objectId: `对象：${state.value.objects.find((o) => o.id === f.objectId)?.name ?? f.objectId}`,
  };
  return [
    ...Object.entries(f)
      .filter(([, value]) => value)
      .map(([key]) => ({ key, label: labels[key]! })),
    ...(state.value.viewportOnly ? [{ key: 'viewportOnly', label: '仅当前海图视野' }] : []),
  ];
});
const layerItems = computed(() => [
  ...Object.entries(layerNames)
    .filter(([key]) => state.value.layerVisibility[key as keyof typeof layerNames])
    .map(([key, label]) => ({ key, label })),
  ...(state.value.includeCandidates ? [{ key: 'includeCandidates', label: '显示候选关系' }] : []),
]);
function openFilters() {
  Object.assign(draft, state.value.filters, { viewportOnly: state.value.viewportOnly });
  timePreset.value = draft.from || draft.to ? 'custom' : '';
  objectSearch.value = '';
  filterError.value = '';
  filterOpen.value = true;
}
function resetFilters() {
  for (const key of Object.keys(state.value.filters) as (keyof typeof state.value.filters)[])
    draft[key] = '';
  draft.viewportOnly = false;
  timePreset.value = '';
  filterError.value = '';
}
function applyFilters() {
  filterError.value = '';
  if (draft.from && draft.to && draft.from >= draft.to) {
    filterError.value = '有效期起必须早于有效期止。';
    return;
  }
  for (const key of Object.keys(state.value.filters) as (keyof typeof state.value.filters)[])
    state.value.filters[key] = draft[key].trim();
  state.value.viewportOnly = draft.viewportOnly;
  filterOpen.value = false;
  void state.value.load();
}
function setTime(value: string) {
  timePreset.value = value;
  if (value === 'custom') return;
  draft.from = value
    ? new Date(Date.now() - Number(value) * 3600000).toISOString().slice(0, 16)
    : '';
  draft.to = value ? new Date().toISOString().slice(0, 16) : '';
}
function removeFilter(key: string) {
  if (key === 'viewportOnly') state.value.viewportOnly = false;
  else state.value.filters[key as keyof typeof state.value.filters] = '';
  void state.value.load();
}
function openLayers() {
  Object.assign(layerDraft, state.value.layerVisibility, {
    includeCandidates: state.value.includeCandidates,
  });
  layerOpen.value = true;
}
function applyLayers() {
  for (const key of Object.keys(layerNames) as (keyof typeof layerNames)[])
    state.value.layerVisibility[key] = layerDraft[key];
  const changed = state.value.includeCandidates !== layerDraft.includeCandidates;
  state.value.includeCandidates = layerDraft.includeCandidates;
  layerOpen.value = false;
  if (changed) void state.value.refreshPlot();
}
function removeLayer(key: string) {
  if (key === 'includeCandidates') {
    state.value.includeCandidates = false;
    void state.value.refreshPlot();
  } else state.value.layerVisibility[key as keyof typeof layerNames] = false;
}
</script>
<template>
  <section class="intelligence-list" aria-label="情报标绘">
    <ChartConditionSummary
      title="筛选条件"
      settings-label="设置情报筛选"
      :items="filterItems"
      @settings="openFilters"
      @remove="removeFilter"
    />
    <ChartConditionSummary
      title="当前图层"
      settings-label="设置情报图层"
      icon="layers"
      :items="layerItems"
      @settings="openLayers"
      @remove="removeLayer"
    />
    <ChartSettingsDialog
      v-model="filterOpen"
      title="情报筛选条件设置"
      :sections="[
        { id: 'basic', label: '基础筛选' },
        { id: 'time', label: '时间范围' },
        { id: 'object', label: '地理与对象' },
      ]"
      @apply="applyFilters"
      @reset="resetFilters"
    >
      <template #default="{ section }">
        <div v-show="section === 'basic'" class="settings-fields">
          <h3>基础筛选</h3>
          <label
            >情报关键词<input
              v-model="draft.keyword"
              aria-label="情报关键词"
              placeholder="标题、摘要、原文关键词"
          /></label>
          <fieldset>
            <legend>情报类别</legend>
            <div class="settings-choices">
              <button
                type="button"
                :aria-pressed="draft.category === ''"
                @click="draft.category = ''"
              >
                全部类别
              </button>
              <button
                v-for="c in categories"
                :key="c"
                type="button"
                :aria-pressed="draft.category === c"
                @click="draft.category = c"
              >
                {{ categoryLabels[c] }}
              </button>
            </div>
          </fieldset>
          <label
            >情报来源<select v-model="draft.sourceId" aria-label="情报来源">
              <option value="">全部来源</option>
              <option v-for="s in state.sources" :key="s.sourceId" :value="s.sourceId">
                {{ s.name }}
              </option>
            </select></label
          >
          <label
            >情报审核状态<select v-model="draft.reviewStatus" aria-label="情报审核状态">
              <option value="">全部审核状态</option>
              <option value="candidate">待核实</option>
              <option value="confirmed">已确认</option>
              <option value="rejected">已驳回</option>
            </select></label
          >
          <label
            >情报有效状态<select v-model="draft.status" aria-label="情报有效状态">
              <option value="">全部有效状态</option>
              <option value="active">有效</option>
              <option value="revised">已修订</option>
              <option value="withdrawn">已撤回</option>
            </select></label
          >
        </div>
        <div v-show="section === 'time'" class="settings-fields">
          <h3>时间范围</h3>
          <fieldset>
            <legend>有效期（UTC）</legend>
            <div class="settings-choices">
              <button
                v-for="p in [
                  { id: '', name: '全部' },
                  { id: '24', name: '近24小时' },
                  { id: '168', name: '近7天' },
                  { id: '720', name: '近30天' },
                  { id: 'custom', name: '自定义' },
                ]"
                :key="p.id"
                type="button"
                :aria-pressed="timePreset === p.id"
                @click="setTime(p.id)"
              >
                {{ p.name }}
              </button>
            </div>
          </fieldset>
          <label
            >有效期起（UTC）<input
              v-model="draft.from"
              type="datetime-local"
              @input="timePreset = 'custom'"
          /></label>
          <label
            >有效期止（UTC）<input
              v-model="draft.to"
              type="datetime-local"
              @input="timePreset = 'custom'"
          /></label>
        </div>
        <div v-show="section === 'object'" class="settings-fields">
          <h3>地理与对象</h3>
          <label
            >筛选关联对象<input
              v-model="objectSearch"
              aria-label="筛选关联对象"
              placeholder="搜索对象名称 / 别名" /></label
          ><label
            >关联对象<select v-model="draft.objectId" aria-label="关联对象">
              <option value="">全部关联对象</option>
              <option v-for="o in filteredObjects" :key="o.id" :value="o.id">
                {{ o.name }} · {{ objectLabels[o.kind] }}
              </option>
            </select></label
          >
          <label class="chart-layer-check"
            ><input v-model="draft.viewportOnly" type="checkbox" />仅当前海图视野</label
          >
        </div>
        <p v-if="filterError" class="error" role="alert">{{ filterError }}</p>
      </template>
    </ChartSettingsDialog>
    <ChartSettingsDialog
      v-model="layerOpen"
      title="情报图层设置"
      :sections="[{ id: 'layers', label: '图层显示' }]"
      @apply="applyLayers"
      @reset="
        Object.assign(layerDraft, {
          location: true,
          object: true,
          impact: true,
          candidate: true,
          directory: true,
          includeCandidates: false,
        })
      "
    >
      <div class="settings-fields">
        <h3>图层显示</h3>
        <label v-for="(name, key) in layerNames" :key="key" class="settings-layer"
          ><span>{{ name }}</span
          ><input v-model="layerDraft[key]" type="checkbox"
        /></label>
        <label class="settings-layer"
          ><span>显示待核实候选关系</span
          ><input v-model="layerDraft.includeCandidates" type="checkbox"
        /></label>
      </div>
    </ChartSettingsDialog>
    <FetchState :busy="state.busy" :error="state.error" @retry="state.load()" />
    <p class="detail-time">
      已勾选 {{ state.selectedIds.length }} · 标绘 {{ state.plottedIds.length }} · 隐藏
      {{ state.hiddenIds.length }}
    </p>
    <div class="intelligence-actions">
      <button :disabled="!state.selectedIds.length" @click="state.add()">批量加入</button
      ><button :disabled="!state.selectedIds.length" @click="state.remove()">批量移除</button
      ><button :disabled="!state.selectedIds.length" @click="state.hide()">隐藏所选</button
      ><button @click="state.clear()">清空标绘</button
      ><button @click="emit('locate')">定位全部</button>
    </div>
    <details v-if="state.plottedIds.length" open>
      <summary>当前标绘集合</summary>
      <article v-for="item in state.plot.items" :key="item.eventId" class="plotted-item">
        <strong>{{ item.title }}</strong
        ><small
          >{{ item.featureCount }} 个几何 ·
          {{ state.hiddenIds.includes(item.eventId) ? '已隐藏' : '显示中' }}</small
        >
        <div class="intelligence-actions">
          <button @click="emit('select', item.eventId)">证据</button
          ><button @click="emit('locate', item.eventId)">定位</button
          ><button v-if="state.hiddenIds.includes(item.eventId)" @click="state.add([item.eventId])">
            恢复显示</button
          ><button v-else @click="state.hide([item.eventId])">隐藏</button
          ><button @click="state.remove([item.eventId])">移除</button>
        </div>
      </article>
    </details>
    <p v-if="state.feedback" class="chart-caution" role="status">{{ state.feedback }}</p>
    <div
      v-for="item in state.items"
      :key="item.id"
      class="intelligence-row"
      :class="{ selected: state.activeId === item.id }"
    >
      <input
        :checked="state.selectedIds.includes(item.id)"
        type="checkbox"
        :aria-label="'勾选 ' + item.title"
        @change="state.toggleSelection(item.id)"
      />
      <button class="intelligence-content" type="button" @click="emit('select', item.id)">
        <strong>{{ item.title }}</strong
        ><span>{{ item.summary }}</span
        ><small>{{ item.sourceId }} · v{{ item.version }} · {{ dateLabel(item.publishedAt) }}</small
        ><small
          >{{ statusLabels[item.status] }} · {{ reviewLabels[item.reviewStatus || 'candidate'] }} ·
          {{ state.plottedIds.includes(item.id) ? '已标绘' : '未标绘' }}</small
        >
      </button>
      <button
        class="intelligence-locate"
        type="button"
        :aria-label="'定位 ' + item.title"
        @click="emit('locate', item.id)"
      >
        <span aria-hidden="true">⌖</span> 定位
      </button>
    </div>
    <p v-if="!state.items.length && !state.busy" class="empty-copy">当前条件没有情报记录。</p>
    <button v-if="state.cursor" :disabled="state.busy" @click="state.load(true)">
      加载更多情报
    </button>
  </section>
</template>
<style scoped>
.plotted-item {
  padding: 8px;
  border-bottom: 1px solid #1c4c60;
}
.plotted-item small {
  display: block;
  color: #8eaabc;
}
.intelligence-actions {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.intelligence-actions button {
  font-size: 12px;
  padding: 6px 9px;
}
.intelligence-row {
  position: relative;
  display: grid;
  gap: 10px;
  min-width: 0;
  margin: 9px 0;
  padding: 12px;
  border: 1px solid #23658a;
  border-left: 3px solid #22b9e9;
  border-radius: 4px;
  background: linear-gradient(120deg, #112f46, #081f30);
}
.intelligence-row.selected {
  border-color: #5ad4df;
}
.intelligence-row > input {
  position: absolute;
  top: 15px;
  left: 12px;
  width: 16px;
  height: 16px;
  margin: 0;
  padding: 0;
  accent-color: #5ad4df;
}
.intelligence-content {
  display: grid;
  gap: 7px;
  min-width: 0;
  width: 100%;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
  text-align: left;
  line-height: 1.6;
}
.intelligence-content strong {
  min-height: 20px;
  margin-left: 25px;
  color: #88dcfb;
  font-size: 12px;
}
.intelligence-content span {
  font-size: 11px;
}
.intelligence-content small {
  color: #8eaabc;
  font-size: 11px;
}
.intelligence-content > * {
  min-width: 0;
  overflow-wrap: anywhere;
}
.intelligence-locate {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: end;
  gap: 4px;
  min-width: 32px;
  min-height: 32px;
  padding: 3px 8px;
  border-color: #23658a;
  background: #0b2b40;
  color: #88dcfb;
  font-size: 12px;
  line-height: 1;
}
.intelligence-locate > span {
  font-size: 18px;
}
.intelligence-content:focus-visible,
.intelligence-locate:focus-visible {
  outline: 2px solid #5ad4df;
}
</style>
