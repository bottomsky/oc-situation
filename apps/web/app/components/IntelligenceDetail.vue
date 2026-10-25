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
  intelligencePublishedTimeLabel,
} from '../utils/intelligenceLabels';
import { intelligenceTimePending } from '../utils/intelligenceForm';
import { dateLabel } from '../utils/display';
const props = defineProps<{
  detail: { event: IntelligenceEvent; relations: IntelligenceRelation[]; history: unknown[] };
  geometry?: unknown;
  canDraw?: boolean;
  panelVisible?: boolean;
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
const initialDraft = ref(JSON.stringify(draft));
useUiComponent('intelligence.draft', {
  read: () =>
    uiProjection(canManage.value && props.panelVisible !== false, [], {
      dirty: !!editing.value || JSON.stringify(draft) !== initialDraft.value,
      loading: busy.value,
    }),
});
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
    initialDraft.value = JSON.stringify(draft);
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
    initialDraft.value = JSON.stringify(draft);
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
  <section class="intelligence-detail detail-content" aria-label="情报详情">
    <header class="detail-hero">
      <p class="detail-eyebrow">INTELLIGENCE / 证据与关系</p>
      <h2 class="detail-title">{{ detail.event.title }}</h2>
      <div class="detail-meta">
        <span class="detail-status">{{ statusLabels[detail.event.status] }}</span>
        <span
          class="detail-status"
          :data-tone="
            detail.event.reviewStatus === 'confirmed'
              ? 'success'
              : detail.event.reviewStatus === 'rejected'
                ? 'danger'
                : 'warning'
          "
          >{{ reviewLabels[detail.event.reviewStatus || 'candidate'] }}</span
        >
        <span>版本 {{ detail.event.version }}</span>
        <span v-if="sampleLabel" class="detail-status" data-tone="warning">{{ sampleLabel }}</span>
      </div>
      <p class="detail-summary">{{ detail.event.summary }}</p>
      <div class="detail-actions">
        <button type="button" class="detail-action-primary" @click="emit('locate')">
          定位情报 <span aria-hidden="true">⌖</span>
        </button>
        <a
          v-if="safeOriginalUrl(detail.event.originalUrl)"
          :href="safeOriginalUrl(detail.event.originalUrl)"
          target="_blank"
          rel="noopener noreferrer"
          >查看来源原文 <span aria-hidden="true">↗</span></a
        >
      </div>
    </header>
    <p
      v-if="
        detail.event.status !== 'active' ||
        (detail.event.effectiveTo && Date.parse(detail.event.effectiveTo) < Date.now())
      "
      class="intelligence-notice"
    >
      历史或失效情报：{{
        detail.event.status === 'withdrawn' ? '已撤回' : '请核对有效期与后续版本'
      }}
    </p>
    <p v-if="timePending" class="intelligence-notice">
      实际有效 / 发生时间待确认；当前时间为来源观测时间。完成修订并填写实际有效期后审核。
    </p>
    <FetchState :error="error" :busy="busy" />

    <ChartDetailSection title="来源与时效" eyebrow="SOURCE & VALIDITY">
      <dl class="detail-fields intelligence-source-fields">
        <div>
          <dt>情报来源</dt>
          <dd>{{ detail.event.sourceId }}</dd>
        </div>
        <div>
          <dt>来源标识</dt>
          <dd class="mono">{{ detail.event.externalId }}</dd>
        </div>
        <div>
          <dt>{{ intelligencePublishedTimeLabel(detail.event.raw) }} · UTC</dt>
          <dd class="mono">{{ dateLabel(detail.event.publishedAt) }}</dd>
        </div>
        <div>
          <dt>发生 / 适用 · UTC</dt>
          <dd class="mono">{{ dateLabel(detail.event.effectiveFrom) }}</dd>
          <dd class="detail-meta">
            至
            {{
              timePending
                ? '有效期待确认'
                : detail.event.effectiveTo
                  ? dateLabel(detail.event.effectiveTo)
                  : '持续有效'
            }}
          </dd>
        </div>
      </dl>
      <p
        v-if="
          (detail.event.raw as { applicabilityConfirmed?: unknown } | null)
            ?.applicabilityConfirmed === true
        "
        class="detail-meta"
      >
        适用条件：操作员已核验原文适用于全部船舶。
      </p>
      <div v-if="canManage" class="detail-actions intelligence-review-actions">
        <button :disabled="busy || timePending" @click="review(detail.event.id, 'confirmed')">
          确认公告
        </button>
        <button :disabled="busy" @click="review(detail.event.id, 'rejected')">驳回公告</button>
        <button @click="emit('revise', detail.event, 'revised')">修订公告</button>
        <button @click="emit('revise', detail.event, 'withdrawn')">撤回公告</button>
      </div>
    </ChartDetailSection>

    <ChartDetailSection
      title="原文段落"
      eyebrow="SOURCE EVIDENCE"
      :meta="`${detail.event.paragraphs.length} 段`"
    >
      <blockquote v-for="p in detail.event.paragraphs" :key="p.id" class="detail-quote">
        <small class="mono">{{ p.id }}</small>
        <p>{{ p.text }}</p>
      </blockquote>
      <p v-if="!detail.event.paragraphs.length" class="detail-empty">当前情报暂无原文段落。</p>
      <details class="detail-disclosure">
        <summary>完整原始数据与归档校验</summary>
        <dl class="detail-fields intelligence-archive-fields">
          <div>
            <dt>归档</dt>
            <dd class="mono">{{ detail.event.archiveKey }}</dd>
          </div>
          <div>
            <dt>校验</dt>
            <dd class="mono">{{ detail.event.checksum }}</dd>
          </div>
        </dl>
        <div v-if="detail.event.originalArchiveId" class="detail-actions">
          <button :disabled="archiveLoading" @click="readOriginal">读取采集归档原文</button>
        </div>
        <FetchState :busy="archiveLoading" :error="archiveError" />
        <pre v-if="archivedOriginal" class="detail-code">{{ archivedOriginal }}</pre>
        <pre class="detail-code">{{ JSON.stringify(detail.event.raw, null, 2) }}</pre>
      </details>
    </ChartDetailSection>

    <ChartDetailSection
      title="地理与对象关系"
      eyebrow="RELATIONS"
      :meta="`${detail.relations.length} 项`"
    >
      <p v-if="!detail.relations.length" class="detail-empty">当前情报暂无地理与对象关系。</p>
      <article v-for="r in detail.relations" :key="r.id" class="intelligence-relation">
        <header class="intelligence-relation-heading">
          <strong>{{ relationLabels[r.kind] }}</strong>
          <span
            class="detail-status"
            :data-tone="
              r.reviewStatus === 'confirmed'
                ? 'success'
                : r.reviewStatus === 'rejected'
                  ? 'danger'
                  : 'warning'
            "
            >{{ reviewLabels[r.reviewStatus] }}</span
          >
        </header>
        <p>{{ r.basis }}</p>
        <p class="detail-meta">
          {{ r.objectId || r.geometry?.type || '对象待补充' }} · {{ originLabels[r.origin] }} · 修订
          {{ r.revision }}
        </p>
        <p class="detail-meta">原文 {{ r.paragraphIds.join('、') || '未关联段落' }}</p>
        <p v-if="r.kind === 'impacts'" class="detail-meta">
          影响：{{ r.impactType }} · {{ dateLabel(r.effectiveFrom) }} →
          {{ r.effectiveTo ? dateLabel(r.effectiveTo) : '持续有效' }}
        </p>
        <div v-if="canManage" class="detail-actions">
          <button @click="edit(r)">修订关系</button>
          <button @click="review(r.id, 'confirmed', true)">确认关系</button>
          <button @click="review(r.id, 'rejected', true)">驳回关系</button>
        </div>
      </article>
    </ChartDetailSection>

    <details v-if="canManage" class="detail-disclosure intelligence-editor" open>
      <summary>{{ editing ? '修订关系' : '新增关联 / 影响认定' }}</summary>
      <form class="intelligence-relation-form" @submit.prevent="save">
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
        <label v-for="p in detail.event.paragraphs" :key="p.id" class="intelligence-reference"
          ><input v-model="draft.paragraphIds" type="checkbox" :value="p.id" />引用原文
          {{ p.id }}</label
        >
        <div v-if="canDraw" class="detail-actions">
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
        ><button class="detail-action-primary" :disabled="busy">
          {{ editing ? '保存关系修订' : '保存关联' }}
        </button>
      </form>
    </details>
    <details class="detail-disclosure" open>
      <summary>版本与审核历史（{{ detail.history.length }}）</summary>
      <p v-if="!detail.history.length" class="detail-empty">当前情报暂无版本与审核记录。</p>
      <article v-for="(entry, index) in detail.history" :key="index" class="intelligence-history">
        <strong>{{ historyLabel(entry) }}</strong>
        <p class="detail-meta">{{ historyTime(entry) }}</p>
        <button
          v-if="(entry as Record<string, unknown>).kind === 'event-version'"
          @click="emit('history', String((entry as Record<string, unknown>).eventId))"
        >
          查看版本证据
        </button>
      </article>
      <details class="detail-disclosure">
        <summary>完整历史数据</summary>
        <pre class="detail-code">{{ JSON.stringify(detail.history, null, 2) }}</pre>
      </details>
    </details>
  </section>
</template>
<style scoped>
.intelligence-source-fields,
.intelligence-archive-fields {
  grid-template-columns: minmax(0, 1fr);
}
.intelligence-notice {
  padding: 10px 12px;
  border-left: 2px solid #ceaa65;
  background: #5e482329;
  color: #e7cd91;
  font-size: 12px;
}
.intelligence-review-actions {
  margin-top: 14px;
}
.intelligence-relation,
.intelligence-history {
  display: grid;
  gap: 8px;
  padding-block: 14px;
}
.intelligence-relation + .intelligence-relation,
.intelligence-history + .intelligence-history {
  border-top: 1px solid #28607855;
}
.intelligence-relation-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.intelligence-relation-form {
  display: grid;
  gap: 14px;
  margin-top: 16px;
}
.intelligence-reference {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}
.intelligence-reference input {
  flex: 0 0 auto;
}
.intelligence-relation-form > button {
  justify-self: start;
}
.intelligence-history > button {
  justify-self: start;
}
</style>
