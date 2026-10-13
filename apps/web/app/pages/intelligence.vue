<script setup lang="ts">
import type { IntelligenceEvent, IntelligenceSource, IntelligenceRelation } from '@ais/contracts';
import { IntelligenceInputSchema, IntelligenceCategorySchema } from '@ais/contracts';
import { categoryLabels } from '../utils/intelligenceLabels';
import { safeOriginalUrl } from '../utils/intelligenceLabels';
import { createIntelligenceInput, parseIntelligenceGeoJSON } from '../utils/intelligenceForm';
const intelligence = reactive(useIntelligenceWorkspace());
const route = useRoute();
const mode = ref<'form' | 'json' | 'geojson'>('form');
const previous = ref<IntelligenceEvent>();
const previousRelations = ref<IntelligenceRelation[]>([]);
const inheritRelations = ref(true);
const formStatus = ref('active');
const form = reactive({
  sourceId: '',
  externalId: '',
  title: '',
  summary: '',
  category: 'notice',
  publishedAt: new Date().toISOString().slice(0, 16),
  effectiveFrom: new Date().toISOString().slice(0, 16),
  effectiveTo: '',
  text: '',
  reviewStatus: 'confirmed',
  originalUrl: '',
});
function revise(event: IntelligenceEvent, status: 'revised' | 'withdrawn') {
  previousRelations.value =
    intelligence.detail?.event.id === event.id ? intelligence.detail.relations : [];
  inheritRelations.value = true;
  previous.value = event;
  formStatus.value = status;
  Object.assign(form, {
    ...event,
    publishedAt: event.publishedAt.slice(0, 16),
    effectiveFrom:
      event.raw &&
      typeof event.raw === 'object' &&
      'requiresEffectiveTimeReview' in event.raw &&
      event.raw.requiresEffectiveTimeReview
        ? ''
        : event.effectiveFrom.slice(0, 16),
    effectiveTo: event.effectiveTo?.slice(0, 16) || '',
    text: event.paragraphs.map((p) => p.text).join('\n\n'),
    originalUrl: event.originalUrl || '',
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
async function saveForm() {
  busy.value = true;
  error.value = '';
  try {
    await api('/intelligence/events', {
      method: 'POST',
      body: createIntelligenceInput(
        form,
        previous.value,
        formStatus.value,
        inheritRelations.value ? previousRelations.value : [],
      ),
      idempotent: true,
    });
    notice.value = '情报已归档';
    previous.value = undefined;
    form.title = '';
    form.text = '';
    await intelligence.load();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
import { dateLabel } from '../utils/display';
const { api, session, notice } = usePlatform();
const items = ref<IntelligenceEvent[]>([]);
type SourceStatus = IntelligenceSource & {
  lastPolledAt?: string | null;
  lastSuccessfulAt?: string | null;
  lastError?: string | null;
  lastIngestion?: {
    imported?: number;
    unchanged?: number;
    failed?: number;
    discovered?: number;
    partialFailure?: boolean;
  };
};
const sources = ref<SourceStatus[]>([]);
const cursor = ref<string | null>(null);
const error = ref('');
const busy = ref(false);
const document = ref('');
const sourceId = ref('');
const sourceName = ref('');
const canManage = computed(() => session.value?.user.role !== 'viewer');
const canAdmin = computed(() => session.value?.user.role === 'admin');
interface Archive {
  id: string;
  sourceId: string;
  archiveKey: string;
  checksum: string;
  bytes: number;
  contentType: string;
  createdAt: string;
}
const archives = ref<Archive[]>([]);
const archiveCursor = ref<string | null>(null);
const archiveContent = ref('');
const archiveId = ref('');
const archiveError = ref('');
const archiveBusy = ref(false);
const sourceKind = ref<'manual' | 'json' | 'rss' | 'api'>('manual');
const sourceVisibility = ref<'public' | 'internal'>('internal');
const sourceAdapter = ref<NonNullable<IntelligenceSource['adapter']> | ''>('');
const sourceBbox = ref('');
const sourceEventTypes = ref<('TC' | 'TS' | 'FL')[]>([]);
const endpoint = ref('');
const authorizationConfirmed = ref(false);
async function loadArchives(more = false) {
  archiveBusy.value = true;
  archiveError.value = '';
  try {
    const response = await api<{ items: Archive[]; nextCursor: string | null }>(
      '/intelligence/archives?limit=30' +
        (more && archiveCursor.value ? '&cursor=' + encodeURIComponent(archiveCursor.value) : ''),
    );
    archives.value = more ? [...archives.value, ...response.items] : response.items;
    archiveCursor.value = response.nextCursor;
  } catch (e) {
    archiveError.value = (e as Error).message;
  } finally {
    archiveBusy.value = false;
  }
}
async function readArchive(id: string) {
  archiveId.value = id;
  archiveContent.value = '';
  archiveError.value = '';
  try {
    const response = await api<{ content: string }>(
      '/intelligence/archives/' + encodeURIComponent(id),
    );
    if (archiveId.value === id) archiveContent.value = response.content;
  } catch (e) {
    archiveError.value = (e as Error).message;
  }
}
async function toggleSource(source: IntelligenceSource) {
  busy.value = true;
  error.value = '';
  try {
    await api('/intelligence/sources/' + encodeURIComponent(source.sourceId), {
      method: 'PUT',
      body: {
        sourceId: source.sourceId,
        name: source.name,
        kind: source.kind,
        enabled: !source.enabled,
        endpoint: source.endpoint,
        allowedHosts: source.allowedHosts,
        authorizationConfirmed: source.authorizationConfirmed,
        pollSeconds: source.pollSeconds,
        timeoutSeconds: source.timeoutSeconds,
        adapter: source.adapter,
        visibility: source.visibility ?? 'internal',
        ...(source.bbox ? { bbox: source.bbox } : {}),
        ...(source.eventTypes ? { eventTypes: source.eventTypes } : {}),
        requestsPerMinute: source.requestsPerMinute,
        maxDocuments: source.maxDocuments,
        trust: source.trust,
      },
    });
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
const importHint =
  '{\n  "sourceId": "已登记来源标识",\n  "externalId": "原始公告编号",\n  "version": 1,\n  "status": "active",\n  "category": "port-restriction",\n  "title": "原始公告标题",\n  "summary": "公告摘要",\n  "publishedAt": "ISO 8601 UTC时间",\n  "effectiveFrom": "ISO 8601 UTC时间",\n  "effectiveTo": null,\n  "bbox": [西, 南, 东, 北],\n  "vesselTypes": [],\n  "mmsis": [],\n  "paragraphs": [{"id": "p1", "text": "原文段落"}],\n  "raw": {}\n}';
async function load(more = false) {
  busy.value = true;
  error.value = '';
  try {
    const response = await api<{ items: IntelligenceEvent[]; nextCursor: string | null }>(
      '/intelligence/events?limit=50' +
        (more && cursor.value ? '&cursor=' + encodeURIComponent(cursor.value) : ''),
    );
    items.value = more ? [...items.value, ...response.items] : response.items;
    cursor.value = response.nextCursor;
    sources.value = await api<SourceStatus[]>('/intelligence/sources');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function importDocument() {
  busy.value = true;
  error.value = '';
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(document.value);
    } catch {
      throw new Error('JSON 格式有误，请检查引号、逗号与括号');
    }
    const checked = IntelligenceInputSchema.safeParse(parsed);
    if (!checked.success)
      throw new Error(
        '公告字段校验失败：' +
          checked.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('；'),
      );
    await api('/intelligence/events', { method: 'POST', body: checked.data, idempotent: true });
    document.value = '';
    notice.value = '公告已归档并进入融合分析';
    await load();
    await intelligence.load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function importGeoJSON() {
  busy.value = true;
  error.value = '';
  let count = 0;
  try {
    const inputs = parseIntelligenceGeoJSON(JSON.parse(document.value));
    for (const input of inputs) {
      await api('/intelligence/events', { method: 'POST', body: input, idempotent: true });
      count++;
    }
    notice.value = '已导入 ' + count + ' 条情报';
    document.value = '';
    await intelligence.load();
  } catch (e) {
    error.value =
      (count ? '已完成 ' + count + ' 条归档；剩余导入中断：' : '') + (e as Error).message;
    if (count) await intelligence.load();
  } finally {
    busy.value = false;
  }
}
async function createSource() {
  busy.value = true;
  error.value = '';
  try {
    const bounds = sourceBbox.value.trim()
      ? sourceBbox.value.split(',').map((value) => Number(value.trim()))
      : undefined;
    if (
      bounds &&
      (bounds.length !== 4 ||
        !bounds.every(Number.isFinite) ||
        bounds[0]! < -180 ||
        bounds[0]! > 180 ||
        bounds[2]! < -180 ||
        bounds[2]! > 180 ||
        bounds[1]! < -90 ||
        bounds[3]! > 90 ||
        bounds[1]! >= bounds[3]!)
    )
      throw new Error('来源范围应为有效的西、南、东、北坐标，使用英文逗号分隔。');
    await api('/intelligence/sources', {
      method: 'POST',
      body: {
        sourceId: sourceId.value,
        name: sourceName.value,
        kind: sourceKind.value,
        visibility: sourceVisibility.value,
        ...(sourceAdapter.value && sourceKind.value !== 'manual'
          ? { adapter: sourceAdapter.value }
          : {}),
        ...(bounds ? { bbox: bounds } : {}),
        ...(sourceAdapter.value === 'gdacs' && sourceEventTypes.value.length
          ? { eventTypes: [...sourceEventTypes.value] }
          : {}),
        enabled: true,
        authorizationConfirmed: sourceKind.value === 'manual' || authorizationConfirmed.value,
        ...(sourceKind.value !== 'manual'
          ? { endpoint: endpoint.value, allowedHosts: [new URL(endpoint.value).hostname] }
          : {}),
      },
    });
    sourceId.value = '';
    sourceName.value = '';
    sourceBbox.value = '';
    sourceEventTypes.value = [];
    notice.value = '情报来源已登记';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  void load();
  void loadArchives();
  if (typeof route.query.revise === 'string')
    void intelligence.select(route.query.revise, false).then(() => {
      if (intelligence.detail) revise(intelligence.detail.event, 'revised');
    });
});
</script>
<template>
  <section class="page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">INTELLIGENCE / 原文与事件</div>
        <h1>海事情报工作台</h1>
        <p>归档结构化公告，保留来源、适用时段、原文段落与版本关系。</p>
      </div>
      <button :disabled="busy" @click="load()">刷新公告</button>
    </div>
    <FetchState :busy="busy" :error="error" @retry="load()" />
    <IntelligenceSearchPanel :sources="sources" />
    <details v-if="canAdmin" class="panel">
      <summary>登记情报来源</summary>
      <form class="editor-grid" @submit.prevent="createSource">
        <label>来源标识<input v-model="sourceId" required pattern="[a-zA-Z0-9._-]+" /></label
        ><label>来源名称<input v-model="sourceName" required /></label>
        <label
          >来源类型<select v-model="sourceKind">
            <option value="manual">手工结构化导入</option>
            <option value="json">JSON 公告接口</option>
            <option value="rss">RSS 原文归档</option>
            <option value="api">公开 API 接口</option>
          </select></label
        >
        <label
          >来源可见性<select v-model="sourceVisibility" aria-label="来源可见性">
            <option value="internal">内部资料</option>
            <option value="public">公开资料</option>
          </select></label
        >
        <label v-if="sourceKind !== 'manual'"
          >采集适配器<select v-model="sourceAdapter" aria-label="采集适配器">
            <option value="">通用结构化接口</option>
            <option value="maritime-html">海事网页</option>
            <option value="gdacs">GDACS 灾害</option>
            <option value="gdelt">GDELT 新闻</option>
            <option value="rss">RSS 资讯</option>
            <option value="usgs">USGS 地震</option>
            <option value="marine">海况预报</option>
          </select></label
        >
        <label v-if="sourceKind !== 'manual'"
          >采集范围（可选）<input v-model="sourceBbox" placeholder="西,南,东,北，例如 100,0,140,45"
        /></label>
        <fieldset v-if="sourceAdapter === 'gdacs'">
          <legend>灾害类型（不选则使用来源默认）</legend>
          <label><input v-model="sourceEventTypes" type="checkbox" value="TC" />热带气旋</label
          ><label><input v-model="sourceEventTypes" type="checkbox" value="TS" />海啸</label
          ><label><input v-model="sourceEventTypes" type="checkbox" value="FL" />洪水</label>
        </fieldset>
        <template v-if="sourceKind !== 'manual'"
          ><label
            >来源接口地址<input
              v-model="endpoint"
              type="url"
              required
              placeholder="https://授权来源地址" /></label
          ><label class="wide"
            ><span
              ><input v-model="authorizationConfirmed" type="checkbox" required />
              已确认该来源的访问授权</span
            ></label
          ></template
        >
        <div class="wide"><button :disabled="busy">登记来源</button></div>
      </form>
    </details>
    <section v-if="canManage" class="panel intelligence-entry">
      <div class="section-heading">
        <h2>{{ previous ? '修订 / 撤回公告' : '录入情报' }}</h2>
        <div class="actions">
          <button @click="mode = 'form'">表单录入</button
          ><button @click="mode = 'json'">JSON 导入</button
          ><button @click="mode = 'geojson'">GeoJSON 导入</button>
        </div>
      </div>
      <form v-if="mode === 'form'" class="editor-grid" @submit.prevent="saveForm">
        <label>情报标题<input v-model="form.title" required maxlength="500" /></label
        ><label
          >类别<select v-model="form.category" aria-label="情报录入类别">
            <option v-for="c in IntelligenceCategorySchema.options" :key="c" :value="c">
              {{ categoryLabels[c] }}
            </option>
          </select></label
        >
        <label
          >来源<select v-model="form.sourceId" required aria-label="情报录入来源">
            <option value="">选择已登记来源</option>
            <option
              v-for="s in sources.filter((s) => s.enabled)"
              :key="s.sourceId"
              :value="s.sourceId"
            >
              {{ s.name }}
            </option>
          </select></label
        ><label>原始公告编号<input v-model="form.externalId" required /></label>
        <label class="wide">摘要<textarea v-model="form.summary" rows="2" /></label
        ><label
          >发布时间（UTC）<input v-model="form.publishedAt" type="datetime-local" required /></label
        ><label
          >生效时间（UTC）<input
            v-model="form.effectiveFrom"
            type="datetime-local"
            required /></label
        ><label>失效时间（UTC）<input v-model="form.effectiveTo" type="datetime-local" /></label
        ><label>来源原文地址<input v-model="form.originalUrl" type="url" /></label>
        <label class="wide"
          >原文（空行分隔段落）<textarea v-model="form.text" rows="7" required /></label
        ><label
          >审核状态<select v-model="form.reviewStatus">
            <option value="candidate">待核实</option>
            <option value="confirmed">已确认</option>
            <option value="rejected">已驳回</option>
          </select></label
        ><label
          >公告状态<select v-model="formStatus">
            <option value="active">有效</option>
            <option v-if="previous" value="revised">修订</option>
            <option v-if="previous" value="withdrawn">撤回</option>
          </select></label
        >
        <label v-if="previous && formStatus !== 'withdrawn'" class="wide chart-layer-check"
          ><input v-model="inheritRelations" type="checkbox" />沿用上一版本关联（重新核实） ·
          {{ previousRelations.length }} 条</label
        >
        <div class="wide actions">
          <button :disabled="busy">{{ previous ? '归档新版本' : '归档情报' }}</button
          ><button
            v-if="previous"
            type="button"
            @click="
              previous = undefined;
              formStatus = 'active';
            "
          >
            取消修订</button
          ><span v-if="previous" class="detail-time"
            >前版本 {{ previous.version }} → {{ previous.version + 1 }}</span
          >
        </div>
      </form>
      <form v-else @submit.prevent="mode === 'geojson' ? importGeoJSON() : importDocument()">
        <p class="muted">
          JSON 接受结构化情报；GeoJSON 每个 Feature.properties 为完整情报字段，geometry
          生成待核实的发生位置关联。
        </p>
        <label
          >{{ mode === 'geojson' ? '情报 GeoJSON' : '公告 JSON'
          }}<textarea v-model="document" rows="12" required :placeholder="importHint" /></label
        ><button :disabled="busy">校验并导入</button>
      </form>
    </section>
    <IntelligenceObjects />
    <details class="panel">
      <summary>已登记情报来源（{{ sources.length }}）</summary>
      <div v-for="source in sources" :key="source.sourceId" class="topic-instance">
        <div class="section-heading">
          <div>
            <strong>{{ source.name }}</strong
            ><small class="muted"> {{ source.sourceId }} · {{ source.kind }}</small>
          </div>
          <span class="badge">{{ source.enabled ? '已启用' : '已停用' }}</span>
        </div>
        <p v-if="source.lastPolledAt" class="detail-time">
          最近尝试采集：{{ dateLabel(source.lastPolledAt) }}
        </p>
        <p class="detail-time">
          {{ source.visibility === 'public' ? '公开资料' : '内部资料' }} ·
          {{ source.adapter || '通用接口' }} ·
          {{
            !source.enabled
              ? '已停用'
              : source.lastError
                ? '采集异常'
                : source.lastSuccessfulAt
                  ? '已有采集记录'
                  : '尚未成功采集'
          }}
        </p>
        <a
          v-if="safeOriginalUrl(source.endpoint)"
          :href="safeOriginalUrl(source.endpoint)"
          target="_blank"
          rel="noopener noreferrer"
          >查看来源接口</a
        >
        <p class="detail-time">
          最后成功采集：{{
            source.lastSuccessfulAt ? dateLabel(source.lastSuccessfulAt) : '暂无成功记录'
          }}
        </p>
        <p v-if="source.lastIngestion" class="detail-time">
          最近采集：发现 {{ source.lastIngestion.discovered ?? 0 }} · 归档
          {{ source.lastIngestion.imported ?? 0 }} · 无变化
          {{ source.lastIngestion.unchanged ?? 0 }} · 失败 {{ source.lastIngestion.failed ?? 0
          }}<span v-if="source.lastIngestion.partialFailure"> · 部分采集失败</span>
        </p>
        <p v-if="source.lastError" class="error" role="alert">{{ source.lastError }}</p>
        <p v-if="source.kind === 'rss'" class="muted">
          RSS 原文先归档，完成结构化导入后进入专题分析。
        </p>
        <button v-if="canAdmin" :disabled="busy" @click="toggleSource(source)">
          {{ source.enabled ? '停用来源' : '启用来源' }}
        </button>
      </div>
    </details>
    <details class="panel">
      <summary>采集原文归档（{{ archives.length }}）</summary>
      <FetchState :busy="archiveBusy" :error="archiveError" @retry="loadArchives()" />
      <p v-if="!archives.length && !archiveError && !archiveBusy" class="empty-copy">
        暂无原文归档。
      </p>
      <button
        v-for="archive in archives"
        :key="archive.id"
        class="fusion-event"
        @click="readArchive(archive.id)"
      >
        <strong>{{ archive.sourceId }}</strong
        ><small
          >{{ dateLabel(archive.createdAt) }} · {{ archive.contentType }} ·
          {{ archive.bytes }} 字节</small
        ><span class="mono">{{ archive.id }}</span></button
      ><button v-if="archiveCursor" :disabled="archiveBusy" @click="loadArchives(true)">
        加载更多归档
      </button>
      <pre v-if="archiveContent" class="code-view" aria-label="归档原文">{{ archiveContent }}</pre>
    </details>
    <div class="intelligence-layout">
      <section class="panel">
        <IntelligenceList
          v-model:state="intelligence"
          @select="intelligence.select($event, false)"
          @locate="navigateTo('/?eventId=' + $event)"
        />
      </section>
      <section v-if="intelligence.detail" class="panel">
        <IntelligenceDetail
          :detail="intelligence.detail"
          @refresh="
            intelligence.select(intelligence.activeId, false);
            intelligence.load();
          "
          @revise="revise"
          @history="intelligence.select($event, false)"
          @locate="navigateTo('/?eventId=' + intelligence.activeId)"
        />
      </section>
      <section v-else class="panel empty-copy">
        选择情报，查看原文、对象关联、影响认定与版本历史。
      </section>
    </div>
  </section>
</template>
