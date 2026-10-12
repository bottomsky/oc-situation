<script setup lang="ts">
import type {
  IntelligenceEvent,
  IntelligenceRelation,
  IntelligenceGeoObject,
  IntelligenceGeometry,
} from '@ais/contracts';
import { RelationInputSchema } from '@ais/contracts';
import {
  reviewLabels,
  intelligenceSampleLabel,
  statusLabels,
  relationLabels,
  originLabels,
  objectLabels,
  safeOriginalUrl,
} from '../utils/intelligenceLabels';
import { intelligenceTimePending } from '../utils/intelligenceForm';
import { dateLabel } from '../utils/display';
const props = defineProps<{
  detail: { event: IntelligenceEvent; relations: IntelligenceRelation[]; history: unknown[] };
  geometry?: unknown;
  canDraw?: boolean;
}>();
const emit = defineEmits<{
  refresh: [];
  revise: [event: IntelligenceEvent, status: 'revised' | 'withdrawn'];
  draw: [mode: 'point' | 'linestring' | 'polygon' | 'select' | 'cancel'];
  locate: [];
  history: [id: string];
  editGeometry: [geometry: IntelligenceGeometry];
}>();
const { api, session } = usePlatform();
const canManage = computed(() => session.value?.user.role !== 'viewer');
const sampleLabel = computed(() =>
  intelligenceSampleLabel((props.detail.event.raw as { synthetic?: unknown } | null)?.synthetic),
);
const timePending = computed(() => intelligenceTimePending(props.detail.event.raw));
const archivedOriginal = ref('');
const archiveError = ref('');
const archiveLoading = ref(false);
let archiveGeneration = 0;
let disposed = false;
async function readOriginal() {
  const current = ++archiveGeneration;
  const id = props.detail.event.id;
  archivedOriginal.value = '';
  archiveError.value = '';
  archiveLoading.value = true;
  try {
    const response = await api<{ content: string }>(
      '/intelligence/archives/' + props.detail.event.originalArchiveId,
    );
    if (!disposed && current === archiveGeneration && id === props.detail.event.id)
      archivedOriginal.value = response.content;
  } catch (e) {
    if (!disposed && current === archiveGeneration) archiveError.value = (e as Error).message;
  } finally {
    if (!disposed && current === archiveGeneration) archiveLoading.value = false;
  }
}
onBeforeUnmount(() => {
  disposed = true;
  archiveGeneration++;
});
const error = ref('');
const busy = ref(false);
const objects = ref<IntelligenceGeoObject[]>([]);
const draft = reactive({
  kind: 'mentions',
  objectId: '',
  basis: '',
  paragraphIds: [] as string[],
  reviewStatus: 'candidate',
  impactType: '',
  effectiveFrom: '',
  effectiveTo: '',
  geometry: '',
});
const editing = ref('');
watch(
  () => props.geometry,
  (v) => {
    draft.geometry = v ? JSON.stringify(v, null, 2) : '';
  },
);
watch(
  () => props.detail.event.id,
  () => {
    archiveGeneration++;
    archivedOriginal.value = '';
    archiveError.value = '';
    archiveLoading.value = false;
    editing.value = '';
    draft.geometry = '';
    draft.basis = '';
    draft.paragraphIds = [];
    emit('draw', 'cancel');
  },
);
async function review(id: string, reviewStatus: string, relation = false) {
  busy.value = true;
  error.value = '';
  try {
    await api(
      '/intelligence/' + (relation ? 'relations/' : 'events/') + encodeURIComponent(id) + '/review',
      { method: 'POST', body: { reviewStatus } },
    );
    emit('refresh');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const checked = RelationInputSchema.parse({
      kind: draft.kind,
      basis: draft.basis,
      paragraphIds: draft.paragraphIds,
      reviewStatus: draft.reviewStatus,
      origin: 'manual',
      ...(draft.objectId ? { objectId: draft.objectId } : {}),
      ...(draft.geometry ? { geometry: JSON.parse(draft.geometry) } : {}),
      ...(draft.kind === 'impacts'
        ? {
            impactType: draft.impactType,
            effectiveFrom: new Date(draft.effectiveFrom + 'Z').toISOString(),
            effectiveTo: draft.effectiveTo ? new Date(draft.effectiveTo + 'Z').toISOString() : null,
          }
        : {}),
    });
    await api(
      editing.value
        ? '/intelligence/relations/' + encodeURIComponent(editing.value)
        : '/intelligence/events/' + encodeURIComponent(props.detail.event.id) + '/relations',
      { method: editing.value ? 'PUT' : 'POST', body: checked },
    );
    editing.value = '';
    draft.basis = '';
    draft.geometry = '';
    emit('draw', 'cancel');
    emit('refresh');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function edit(r: IntelligenceRelation) {
  editing.value = r.id;
  Object.assign(draft, {
    kind: r.kind,
    objectId: r.objectId || '',
    basis: r.basis,
    paragraphIds: [...r.paragraphIds],
    reviewStatus: 'candidate',
    impactType: r.impactType || '',
    effectiveFrom: r.effectiveFrom?.slice(0, 16) || '',
    effectiveTo: r.effectiveTo?.slice(0, 16) || '',
    geometry: r.geometry ? JSON.stringify(r.geometry, null, 2) : '',
  });
  if (r.geometry && props.canDraw && canManage.value) emit('editGeometry', r.geometry);
  else if (props.canDraw) emit('draw', 'cancel');
}
function historyLabel(value: unknown) {
  const h = value as Record<string, unknown>;
  return [
    h.action
      ? (
          {
            created: '创建公告',
            reviewed: '审核公告',
            revised: '修订公告',
            withdrawn: '撤回公告',
          } as Record<string, string>
        )[String(h.action)] || '操作记录'
      : h.kind
        ? h.kind === 'event-version'
          ? '公告版本'
          : relationLabels[String(h.kind)] || '关系记录'
        : '审核记录',
    h.version ? '版本 ' + h.version : '',
    h.revision ? '修订 ' + h.revision : '',
    h.reviewStatus ? reviewLabels[String(h.reviewStatus)] : '',
    h.actor || h.reviewedBy || '',
  ]
    .filter(Boolean)
    .join(' · ');
}
function historyTime(value: unknown) {
  const h = value as Record<string, unknown>;
  return dateLabel(String(h.recordedAt || h.createdAt || h.changedAt || ''));
}
onMounted(async () => {
  try {
    const response = await api<IntelligenceGeoObject[] | { items: IntelligenceGeoObject[] }>(
      '/intelligence/objects',
    );
    objects.value = Array.isArray(response) ? response : response.items;
  } catch (e) {
    error.value = (e as Error).message;
  }
});
</script>
<template>
  <section class="document-evidence intelligence-detail" aria-label="情报详情">
    <div class="eyebrow">INTELLIGENCE / 证据与关系</div>
    <h2>{{ detail.event.title }}</h2>
    <span v-if="sampleLabel" class="badge sample">{{ sampleLabel }}</span>
    <p>{{ detail.event.summary }}</p>
    <p class="detail-time">
      {{ detail.event.sourceId }} · {{ detail.event.externalId }} · 版本
      {{ detail.event.version }} · {{ statusLabels[detail.event.status] }} ·
      {{ reviewLabels[detail.event.reviewStatus || 'candidate'] }}
    </p>
    <p
      v-if="
        detail.event.status !== 'active' ||
        (detail.event.effectiveTo && Date.parse(detail.event.effectiveTo) < Date.now())
      "
      class="chart-caution"
    >
      历史或失效情报：{{
        detail.event.status === 'withdrawn' ? '已撤回' : '请核对有效期与后续版本'
      }}
    </p>
    <p v-if="timePending" class="chart-caution">
      实际有效 / 发生时间待确认；当前时间为来源观测时间。完成修订并填写实际有效期后审核。
    </p>
    <p class="detail-time">
      发布 {{ dateLabel(detail.event.publishedAt) }}<br />有效
      {{ dateLabel(detail.event.effectiveFrom) }} →
      {{
        timePending
          ? '有效期待确认'
          : detail.event.effectiveTo
            ? dateLabel(detail.event.effectiveTo)
            : '持续有效'
      }}
    </p>
    <a
      v-if="safeOriginalUrl(detail.event.originalUrl)"
      :href="safeOriginalUrl(detail.event.originalUrl)"
      target="_blank"
      rel="noopener noreferrer"
      >查看来源原文 ↗</a
    >
    <button @click="emit('locate')">定位情报</button>
    <div v-if="canManage" class="actions">
      <button :disabled="busy || timePending" @click="review(detail.event.id, 'confirmed')">
        确认公告</button
      ><button :disabled="busy" @click="review(detail.event.id, 'rejected')">驳回公告</button
      ><button @click="emit('revise', detail.event, 'revised')">修订公告</button
      ><button @click="emit('revise', detail.event, 'withdrawn')">撤回公告</button>
    </div>
    <FetchState :error="error" :busy="busy" />
    <h3>原文段落</h3>
    <blockquote v-for="p in detail.event.paragraphs" :key="p.id">
      <small class="mono">{{ p.id }}</small
      >{{ p.text }}
    </blockquote>
    <details>
      <summary>完整原始数据与归档校验</summary>
      <p class="mono">归档 {{ detail.event.archiveKey }}</p>
      <p class="mono">校验 {{ detail.event.checksum }}</p>
      <button
        v-if="detail.event.originalArchiveId"
        :disabled="archiveLoading"
        @click="readOriginal"
      >
        读取采集归档原文
      </button>
      <FetchState :busy="archiveLoading" :error="archiveError" />
      <pre v-if="archivedOriginal" class="code-view">{{ archivedOriginal }}</pre>
      <pre class="code-view">{{ JSON.stringify(detail.event.raw, null, 2) }}</pre>
    </details>
    <h3>地理与对象关系</h3>
    <article v-for="r in detail.relations" :key="r.id" class="topic-instance">
      <strong>{{ relationLabels[r.kind] }} · {{ reviewLabels[r.reviewStatus] }}</strong>
      <p>{{ r.basis }}</p>
      <small class="detail-time"
        >{{ r.objectId || r.geometry?.type }} · {{ originLabels[r.origin] }} · 修订
        {{ r.revision }} · 原文 {{ r.paragraphIds.join('、') || '未关联段落' }}</small
      >
      <p v-if="r.kind === 'impacts'">
        影响：{{ r.impactType }} · {{ dateLabel(r.effectiveFrom) }} →
        {{ r.effectiveTo ? dateLabel(r.effectiveTo) : '持续有效' }}
      </p>
      <div v-if="canManage" class="actions">
        <button @click="edit(r)">修订关系</button
        ><button @click="review(r.id, 'confirmed', true)">确认关系</button
        ><button @click="review(r.id, 'rejected', true)">驳回关系</button>
      </div>
    </article>
    <details v-if="canManage" open>
      <summary>{{ editing ? '修订关系' : '新增关联 / 影响认定' }}</summary>
      <form class="track-form" @submit.prevent="save">
        <label
          >关系类型<select v-model="draft.kind">
            <option value="occurs-at">发生位置</option>
            <option value="mentions">提及对象</option>
            <option value="involves">涉及对象</option>
            <option value="applies-to">适用范围</option>
            <option value="impacts">影响认定</option>
          </select></label
        >
        <label
          >目录对象<select v-model="draft.objectId">
            <option value="">使用绘制几何</option>
            <option v-for="o in objects" :key="o.id" :value="o.id">
              {{ o.name }} · {{ objectLabels[o.kind] }}
            </option>
          </select></label
        >
        <label>认定依据<textarea v-model="draft.basis" required rows="3" /></label>
        <label v-for="p in detail.event.paragraphs" :key="p.id" class="chart-layer-check"
          ><input v-model="draft.paragraphIds" type="checkbox" :value="p.id" />引用原文
          {{ p.id }}</label
        >
        <div v-if="canDraw" class="actions">
          <button type="button" @click="emit('draw', 'point')">绘制点</button
          ><button type="button" @click="emit('draw', 'linestring')">绘制线</button
          ><button type="button" @click="emit('draw', 'polygon')">绘制面</button
          ><button type="button" @click="emit('draw', 'select')">编辑绘制</button
          ><button
            type="button"
            @click="
              draft.geometry = '';
              emit('draw', 'cancel');
            "
          >
            取消绘制
          </button>
        </div>
        <label
          >GeoJSON 几何<textarea
            v-model="draft.geometry"
            rows="4"
            placeholder="绘制后自动填入，也可粘贴 Point / LineString / Polygon"
          />
        </label>
        <template v-if="draft.kind === 'impacts'"
          ><label>影响类型<input v-model="draft.impactType" required /></label
          ><label
            >影响起始（UTC）<input
              v-model="draft.effectiveFrom"
              type="datetime-local"
              required /></label
          ><label>影响结束（UTC）<input v-model="draft.effectiveTo" type="datetime-local" /></label
        ></template>
        <label
          >审核<select v-model="draft.reviewStatus">
            <option value="candidate">待核实</option>
            <option value="confirmed">已确认</option>
            <option value="rejected">已驳回</option>
          </select></label
        ><button :disabled="busy">{{ editing ? '保存关系修订' : '保存关联' }}</button>
      </form>
    </details>
    <details open>
      <summary>版本与审核历史（{{ detail.history.length }}）</summary>
      <article v-for="(entry, index) in detail.history" :key="index" class="topic-instance">
        <strong>{{ historyLabel(entry) }}</strong>
        <p class="detail-time">{{ historyTime(entry) }}</p>
        <button
          v-if="(entry as Record<string, unknown>).kind === 'event-version'"
          @click="emit('history', String((entry as Record<string, unknown>).eventId))"
        >
          查看版本证据
        </button>
      </article>
      <details>
        <summary>完整历史数据</summary>
        <pre class="code-view">{{ JSON.stringify(detail.history, null, 2) }}</pre>
      </details>
    </details>
  </section>
</template>
<style scoped>
.intelligence-detail {
  padding: 16px;
}
.intelligence-detail h2 {
  margin: 12px 0;
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.actions button {
  padding: 6px 8px;
  font-size: 12px;
}
.intelligence-detail a {
  display: block;
  margin: 10px 0;
  color: #70d9e6;
}
</style>
