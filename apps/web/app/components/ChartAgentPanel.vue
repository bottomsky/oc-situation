<script setup lang="ts">
import type {
  AnalysisResult,
  Bbox,
  AgentHeatmapResult,
  AgentVesselTracksResult,
} from '@ais/contracts';
import type { AgentConversationState } from '../composables/useAgentConversation';
import {
  agentStatusLabel,
  agentTaskActive,
  agentTaskHasAnalysis,
  createAgentMessageFollow,
} from '../composables/useAgentConversation';
import { dateLabel, heatmapDateLabel } from '../utils/display';
import ChartDetailFloat from './ChartDetailFloat.vue';
import ChartAgentHistoryPanel from './ChartAgentHistoryPanel.vue';
import AgentMemoryPanel from './AgentMemoryPanel.vue';
import { useChartDetailHost } from '../composables/useChartDetail';

const props = defineProps<{ bbox: Bbox; state: AgentConversationState }>();
const emit = defineEmits<{
  locate: [result: AnalysisResult];
  heatmap: [result: AgentHeatmapResult];
  tracks: [result: AgentVesselTracksResult];
}>();
const state = props.state;
const detailHost = useChartDetailHost();
function openTask(id: string) {
  detailHost?.open('task', 'right');
  void state.loadTask(id);
}
watch(
  () => state.activeSession?.id,
  () => detailHost?.close('task'),
);
onBeforeUnmount(() => {
  detailHost?.close('task');
  detailHost?.close('history');
});
const selectedTask = computed(() => state.detail?.task);
const hasAnalysis = computed(
  () =>
    !!selectedTask.value &&
    ![
      'intelligence_search',
      'vessel_list',
      'vessel_detail',
      'ais_heatmap',
      'vessel_tracks',
      'skill',
    ].includes(selectedTask.value.intent ?? '') &&
    agentTaskHasAnalysis(selectedTask.value, state.detail?.steps ?? []),
);
const panel = useTemplateRef<HTMLElement>('panel');
const messageFollow = createAgentMessageFollow();
function followSnapshot(nearBottom: boolean) {
  return messageFollow.update(
    state.activeSession?.id ?? null,
    state.messages.map((message) => message.id),
    state.submittedMessageId,
    nearBottom,
  );
}
onMounted(() => followSnapshot(false));
watch(
  () => [
    state.activeSession?.id,
    state.messages.map((message) => message.id),
    state.submittedMessageId,
  ],
  async () => {
    const scroll = panel.value?.closest<HTMLElement>('.chart-panel-scroll');
    const last = panel.value?.querySelector<HTMLElement>('.agent-message:last-child');
    const viewport = scroll?.getBoundingClientRect();
    const bottom = last?.getBoundingClientRect().bottom;
    const nearBottom =
      !!scroll &&
      (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 64 ||
        (bottom !== undefined &&
          !!viewport &&
          bottom >= viewport.top &&
          bottom <= viewport.bottom + 64));
    if (!followSnapshot(nearBottom) || !scroll) return;
    const sessionId = state.activeSession?.id;
    await nextTick();
    if (state.activeSession?.id !== sessionId || !panel.value) return;
    const latest = panel.value.querySelector<HTMLElement>('.agent-message:last-child');
    if (latest)
      scroll.scrollTop +=
        latest.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom;
  },
);
const regionChanged = computed(
  () => state.region && state.region.some((value, index) => value !== props.bbox[index]),
);
const summaryCurrent = computed(
  () =>
    selectedTask.value?.summary &&
    selectedTask.value.summaryResultVersion === selectedTask.value.resultVersion &&
    (selectedTask.value.inputRevision === undefined ||
      selectedTask.value.summaryInputRevision === selectedTask.value.inputRevision),
);
const currentResults = computed(
  () =>
    selectedTask.value?.inputRevision === undefined ||
    selectedTask.value.resultInputRevision === selectedTask.value.inputRevision,
);
const queryResult = computed(() =>
  state.detail?.queryResult &&
  state.detail.queryResult.inputRevision === selectedTask.value?.inputRevision
    ? state.detail.queryResult
    : null,
);
const intelligenceResult = computed(() =>
  state.detail?.intelligenceResult?.inputRevision === selectedTask.value?.inputRevision
    ? state.detail?.intelligenceResult
    : null,
);
const heatmapResult = computed(() => {
  const result = state.detail?.heatmapResult;
  return result &&
    result.inputRevision === selectedTask.value?.inputRevision &&
    result.version === selectedTask.value.resultVersion
    ? result
    : null;
});
const tracksResult = computed(() => {
  const result = state.detail?.tracksResult;
  return result &&
    result.inputRevision === selectedTask.value?.inputRevision &&
    result.version === selectedTask.value.resultVersion
    ? result
    : null;
});
const tools: Record<string, string> = {
  render_vessel_tracks: '查询历史航线',
  render_ais_heatmap: '计算 AIS 热力图',
  list_algorithms: '查询可用算法',
  region_overview: '查询区域概况',
  related_notices: '查询相关公告',
  create_task: '创建分析任务',
  run_analysis: '执行区域算法',
  read_results: '读取分析结果',
  read_evidence: '读取证据摘要',
  ask_user: '补充分析条件',
  request_input: '补充任务条件',
  query_vessels: '查询船舶',
  search_intelligence: '检索本地情报',
};
const localHistoryOpen = ref(false);
const historyOpen = computed(() => detailHost?.isOpen('history') ?? localHistoryOpen.value);
function openHistory() {
  if (detailHost) detailHost.open('history', 'right');
  else localHistoryOpen.value = true;
}
function closeHistory() {
  detailHost?.close('history');
  localHistoryOpen.value = false;
}
const suggestions = [
  '查询当前海域的船舶动态',
  '显示过去 24 小时的 AIS 热力图',
  '绘制当前海域货船过去 24 小时的航线',
  '查询近期相关海事公告',
];
async function chooseSuggestion(question: string) {
  state.setDraft(question);
  await nextTick();
  document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
}
function messageTime(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}
const copiedMessageId = ref('');
const copyError = ref('');
async function copyMessage(id: string, content: string) {
  copyError.value = '';
  try {
    await navigator.clipboard.writeText(content);
    copiedMessageId.value = id;
  } catch {
    copyError.value = '复制失败，请选择回复文字后手动复制。';
  }
}
</script>

<template>
  <section
    ref="panel"
    class="agent-panel"
    aria-label="区域研判智能体"
    data-testid="agent-panel"
    tabindex="-1"
    @keydown.stop
  >
    <div class="agent-intro" data-testid="agent-chat-intro">
      <span class="agent-avatar agent-avatar-intro"><ChartIcon name="Bot" /></span>
      <div>
        <h3>区域研判助手</h3>
        <p>咨询信息，选定海域，循证研判。</p>
      </div>
    </div>
    <p v-if="state.loading" role="status">正在读取会话…</p>
    <p v-if="state.error" class="agent-error" role="alert">{{ state.error }}</p>
    <button v-if="!state.config && !state.loading" @click="state.initialize">重新连接</button>
    <p v-if="state.config && !state.config.enabled" class="agent-note" role="status">
      区域研判智能体尚未启用，请由管理员完成服务配置。现有专题结果可在主动推送中查看。
    </p>
    <template v-if="state.config?.enabled">
      <div class="agent-session-bar">
        <button
          id="chart-agent-history-trigger"
          class="agent-history-trigger"
          aria-label="历史会话"
          aria-controls="chart-agent-history"
          :aria-expanded="historyOpen"
          @click="openHistory"
        >
          <ChartIcon name="History" :size="17" />历史会话
          <span class="agent-session-count">{{ state.sessions.length }}</span>
        </button>
        <button class="agent-new-session" :disabled="state.busy" @click="state.newSession">
          <ChartIcon name="Plus" :size="15" />新建
        </button>
        <p
          class="agent-current-session"
          data-testid="agent-current-session"
          :data-session-id="state.activeSession?.id ?? ''"
          :title="state.activeSession?.title ?? '新会话'"
        >
          <span />{{ state.activeSession?.title ?? '新会话' }}
        </p>
      </div>
      <AgentMemoryPanel
        :session-id="state.activeSession?.id"
        :revision-key="state.tasks.map((task) => `${task.id}:${task.status}`).join(',')"
      />
      <section v-if="!state.messages.length" class="agent-welcome" aria-label="你可以这样问我">
        <h4><span aria-hidden="true">✧</span>你可以这样问我</h4>
        <p>从海图出发，查询船舶、航线与海事情报。</p>
        <button
          v-for="question in suggestions"
          :key="question"
          :disabled="!state.canWrite || state.busy || state.loading"
          @click="chooseSuggestion(question)"
        >
          <span>{{ question }}</span
          ><ChartIcon name="ChevronRight" :size="15" />
        </button>
        <small>点击填入海图下方输入框，可修改后发送。</small>
      </section>
      <p v-if="!state.canWrite" class="agent-note">当前账号为只读权限，可查看已有会话与证据。</p>
      <div class="agent-region">
        <div class="agent-row">
          <strong>分析区域</strong
          ><button
            :disabled="!state.canWrite || state.busy"
            @click="state.confirmRegion(props.bbox)"
          >
            {{ state.region ? '更新为当前视野' : '确认当前海图视野' }}
          </button>
        </div>
        <p v-if="state.region" class="agent-coordinates">
          西 {{ state.region[0].toFixed(3) }}° · 南 {{ state.region[1].toFixed(3) }}°<br />东
          {{ state.region[2].toFixed(3) }}° · 北 {{ state.region[3].toFixed(3) }}°
        </p>
        <p v-else>可直接咨询信息；开展区域研判时，移动、缩放海图并确认分析区域。</p>
        <p v-if="regionChanged" class="agent-note">视野已变化，本次仍使用上方已确认区域。</p>
        <label class="agent-row"
          >历史窗口（小时）<input
            v-model.number="state.historyHours"
            type="number"
            min="1"
            :max="state.config.maxHistoryHours"
            step="1"
            :disabled="!state.canWrite || state.busy"
            aria-label="历史窗口（小时）"
        /></label>
        <small
          >默认 24 小时，最长 {{ state.config.maxHistoryHours }} 小时，受在线数据保留期约束。</small
        >
      </div>
      <div
        v-if="state.messages.length"
        class="agent-messages"
        aria-label="研判对话记录"
        aria-live="polite"
      >
        <article
          v-for="message in state.messages"
          :key="message.id"
          class="agent-message"
          data-testid="agent-chat-message"
          :data-role="message.role"
          :class="message.role"
          :data-message-id="message.id"
          :data-task-id="message.taskId"
          tabindex="-1"
        >
          <span class="agent-avatar agent-message-avatar" aria-hidden="true">
            <ChartIcon v-if="message.role !== 'user'" name="Bot" :size="20" />
            <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
              <circle cx="12" cy="7" r="4" />
              <path d="M4 21v-3a8 8 0 0 1 16 0v3Z" />
            </svg>
          </span>
          <div class="agent-message-body">
            <div class="agent-message-meta">
              <small>{{ message.role === 'user' ? '你' : '研判助手' }}</small>
              <time :datetime="message.createdAt" :title="dateLabel(message.createdAt)">
                {{ messageTime(message.createdAt) }} UTC
              </time>
            </div>
            <div class="agent-message-bubble">
              <p><AgentMessageText :message="message" @reference="state.openSource" /></p>
              <div v-if="message.role === 'assistant'" class="agent-message-actions">
                <button
                  :aria-label="copiedMessageId === message.id ? '已复制回复' : '复制回复'"
                  @click="copyMessage(message.id, message.content)"
                >
                  <ChartIcon v-if="copiedMessageId === message.id" name="Check" :size="15" />
                  <svg
                    v-else
                    width="15"
                    height="15"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.6"
                    aria-hidden="true"
                  >
                    <rect x="8" y="7" width="12" height="15" rx="2" />
                    <path d="M16 7V3H4v15h4M11 11h6M11 15h6" />
                  </svg>
                  {{ copiedMessageId === message.id ? '已复制' : '复制' }}
                </button>
              </div>
            </div>
          </div>
        </article>
      </div>
      <p v-if="copyError" class="agent-note" role="status">{{ copyError }}</p>
      <small
        >在海图下方输入问题或继续追问。区域研判的坐标与船舶标识由本地平台处理，模型接收脱敏摘要和证据引用。</small
      >
      <article
        v-for="request in state.inputRequests"
        :key="request.id"
        class="agent-summary"
        aria-label="待补充条件"
        :data-request-id="request.id"
      >
        <strong>等待补充任务条件</strong>
        <p>选择区域、对象或时间后，将继续原任务。</p>
        <button :disabled="!state.canWrite || state.busy" @click="state.showInput(request.id)">
          继续选择
        </button>
      </article>
      <section v-if="state.tasks.length" class="agent-tasks" aria-label="智能体任务">
        <h4>本会话任务</h4>
        <div v-for="task in [...state.tasks].reverse()" :key="task.id" class="agent-task-row">
          <button
            class="agent-task-select"
            :aria-pressed="state.selectedTaskId === task.id"
            @click="openTask(task.id)"
          >
            <span>{{ task.goal }}</span
            ><small>{{ agentStatusLabel[task.status] }}</small>
          </button>
          <button
            v-if="state.canWrite && (agentTaskActive(task) || task.status === 'awaiting_input')"
            :disabled="state.busy"
            aria-label="取消分析任务"
            @click="state.cancel(task.id)"
          >
            取消
          </button>
          <button
            v-if="state.canWrite && task.status === 'failed' && task.inputRevision !== undefined"
            :disabled="state.busy || state.activeTask"
            @click="state.retryTask(task.id)"
          >
            重试任务
          </button>
        </div>
      </section>
      <button v-if="detailHost && selectedTask" @click="detailHost.open('task', 'right')">
        查看任务详情
      </button>
      <component
        :is="detailHost ? ChartDetailFloat : 'div'"
        :open="detailHost?.isOpen('task')"
        side="right"
        title="智能体任务详情"
        subtitle="AGENT TASK EVIDENCE"
        aria-label="智能体任务详情浮层"
        anchor-id="chart-right-slot"
        data-detail-kind="task"
        @close="detailHost?.close('task')"
      >
        <div
          :class="detailHost ? 'agent-panel agent-task-detail-content' : undefined"
          @keydown="if (detailHost && $event.key !== 'Escape') $event.stopPropagation();"
        >
          <p v-if="state.detailLoading" role="status">正在读取任务证据…</p>
          <section
            v-if="state.detail && selectedTask"
            class="agent-detail"
            aria-label="智能体任务详情"
          >
            <div class="agent-row">
              <h4>{{ agentStatusLabel[selectedTask.status] }}</h4>
              <small>结果版本 {{ selectedTask.resultVersion }}</small>
            </div>
            <p v-if="selectedTask.error" class="agent-error">{{ selectedTask.error }}</p>
            <AgentSkillResults
              :execution="state.detail.dynamicSkill"
              :artifacts="state.detail.artifacts ?? state.detail.dynamicSkill?.artifacts ?? []"
              :input-revision="selectedTask.inputRevision ?? 0"
              @heatmap="emit('heatmap', $event)"
              @tracks="emit('tracks', $event)"
            />
            <p
              v-if="
                selectedTask.status === 'awaiting_input' &&
                !state.inputRequests.some((item) => item.taskId === selectedTask?.id)
              "
              class="agent-note"
            >
              请按助手提示补充本次分析所需条件后继续发送；区域分析可在上方确认范围。
              <button
                v-if="state.canWrite"
                :disabled="state.busy || state.activeTask"
                @click="state.retryTask(selectedTask.id)"
              >
                按原条件重新开始
              </button>
            </p>
            <details>
              <summary>任务参数与调用记录</summary>
              <p v-if="hasAnalysis">
                分析时段：{{ dateLabel(selectedTask.from) }} → {{ dateLabel(selectedTask.to) }}
              </p>
              <p>
                模型 {{ selectedTask.modelCalls }}/{{ state.config.maxModelCalls }} 次 · 工具
                {{ selectedTask.toolCalls }}/{{ state.config.maxToolCalls }} 次
              </p>
              <p v-if="selectedTask.definitionId">
                算法：{{
                  selectedTask.definitionId === 'port-restriction'
                    ? '港口限制船舶识别'
                    : '区域低速活动与公告关联'
                }}
              </p>
              <ol v-if="state.detail.steps.length">
                <li v-for="step in state.detail.steps" :key="step.key">
                  {{ tools[step.name] ?? step.name }} · 已完成
                </li>
              </ol>
              <p v-else>暂无工具调用记录。</p>
            </details>
            <div v-if="summaryCurrent" class="agent-summary">
              <h4>{{ hasAnalysis ? '智能体研判' : '助手回复' }}</h4>
              <p>{{ selectedTask.summary }}</p>
              <small v-if="hasAnalysis"
                >结合下方证据复核观测事实、规则匹配与推测；共现关联需要额外证据支持原因判断。</small
              >
            </div>
            <p v-else-if="selectedTask.summary" class="agent-note">
              结果已更新，摘要正在重新核对。
            </p>
            <p
              v-if="
                hasAnalysis && selectedTask.status === 'completed' && !state.detail.results.length
              "
              class="agent-note"
            >
              本次算法未形成匹配结果，请结合数据覆盖说明调整范围。
            </p>
            <section v-if="intelligenceResult" class="agent-summary" aria-label="情报检索结果">
              <h4>情报检索结果</h4>
              <p>共 {{ intelligenceResult.total }} 条 · {{ dateLabel(intelligenceResult.asOf) }}</p>
              <p v-if="intelligenceResult.spec.locationKeyword" class="agent-note">
                {{
                  intelligenceResult.spec.locationKeyword
                }}：粗略检索范围，非官方海域界线；文字提及不代表已确认位置。
              </p>
              <p v-for="note in intelligenceResult.coverageNotes" :key="note" class="agent-note">
                {{ note }}
              </p>
              <p v-if="intelligenceResult.truncated" class="agent-note">
                当前展示部分结果，请缩小主题或时间范围。
              </p>
              <p v-if="!intelligenceResult.evidence.length">
                未找到匹配的已入库情报，请结合来源覆盖与采集状态调整条件。
              </p>
              <IntelligenceSourceHealth :sources="intelligenceResult.sourceHealth" />
              <button
                v-for="item in intelligenceResult.evidence"
                :key="item.reference"
                @click="
                  state.openSource(item.reference, selectedTask.id, intelligenceResult.version)
                "
              >
                [{{ item.reference }}]
                {{
                  item.kind === 'event' ? item.event.title : item.forecast.pointName + ' · 海况预报'
                }}
              </button>
            </section>
            <section v-if="tracksResult" class="agent-summary" aria-label="历史航线结果">
              <h4>历史航线 · {{ tracksResult.returnedVessels }} 艘</h4>
              <p>
                {{ heatmapDateLabel(tracksResult.query.from) }} ～
                {{ heatmapDateLabel(tracksResult.query.to) }}
              </p>
              <p>按历史经过区域选船，展示时段完整可用航线；AIS 船型按当前资料。</p>
              <p v-if="tracksResult.hasMoreVessels">
                至少匹配 {{ tracksResult.matchedVesselsLowerBound }} 艘，已达展示数量上限。
              </p>
              <p v-if="!tracksResult.tracks.length">
                没有匹配观测；具体型号资料尚未收录也可能导致空结果。
              </p>
              <p v-for="track in tracksResult.tracks" :key="track.mmsi">
                {{ track.name || track.mmsi }} · {{ track.returned }}/{{ track.total }} 点<span
                  v-if="track.sampled"
                >
                  · 已抽样</span
                ><span v-if="track.truncated"> · 已截断</span>
              </p>
              <button @click="emit('tracks', tracksResult)">在海图展示此航线快照</button>
            </section>
            <section v-if="heatmapResult" class="agent-summary" aria-label="AIS 热力图结果">
              <h4>AIS 热力图计算完成</h4>
              <p>
                {{ heatmapResult.totalVessels }} 艘去重船舶 ·
                {{ heatmapResult.cells.length }} 个非空网格
              </p>
              <p>
                {{ heatmapDateLabel(heatmapResult.query.from) }} ～
                {{ heatmapDateLabel(heatmapResult.query.to) }}
              </p>
              <p>
                每格去重船数；全区总数独立去重，船型按当前资料筛选。地图绘制状态请查看海图图例。
              </p>
              <p>生成于 {{ heatmapDateLabel(heatmapResult.generatedAt) }}</p>
              <p v-if="!heatmapResult.cells.length">所选区域和时段没有符合条件的观测。</p>
              <button @click="emit('heatmap', heatmapResult)">在海图展示此快照</button>
            </section>
            <section v-if="queryResult" class="agent-summary" aria-label="船舶查询结果">
              <h4>{{ queryResult.kind === 'vessel_detail' ? '船舶基本信息' : '区域船舶列表' }}</h4>
              <p>共 {{ queryResult.total }} 艘 · {{ dateLabel(queryResult.asOf) }}</p>
              <p v-if="queryResult.selection.bbox">
                范围：{{ queryResult.selection.bbox.map((value) => value.toFixed(3)).join('，') }}
              </p>
              <p v-if="queryResult.selection.filters?.hours">
                最新报告：最近 {{ queryResult.selection.filters.hours }} 小时
              </p>
              <p v-if="queryResult.truncated" class="agent-note">
                仅展示前 {{ queryResult.items.length }} 艘，请缩小范围查看其余船舶。
              </p>
              <p v-if="queryResult.selection.filters?.sourceId">
                数据来源：{{ queryResult.selection.filters.sourceId }}
              </p>
              <p v-if="queryResult.selection.filters?.shipType">
                船型筛选：{{ queryResult.selection.filters.shipType }}
              </p>
              <p v-if="!queryResult.items.length">所选范围和条件内没有匹配船舶。</p>
              <article v-for="vessel in queryResult.items" :key="vessel.mmsi" class="agent-result">
                <strong>{{ vessel.name || '未命名船舶' }}</strong>
                <p>
                  MMSI {{ vessel.mmsi }} · IMO {{ vessel.imo || '—' }} · 船型
                  {{ vessel.shipType ?? '—' }}
                </p>
                <p v-if="vessel.latestPosition">
                  {{ vessel.latestPosition.lon.toFixed(4) }}°，{{
                    vessel.latestPosition.lat.toFixed(4)
                  }}° · {{ vessel.latestPosition.sogKnots ?? '—' }} kn<br />最新报告
                  {{ dateLabel(vessel.latestPosition.observedAt) }}
                </p>
                <p v-else>暂无船位报告</p>
              </article>
            </section>
            <p v-if="!currentResults && state.detail.results.length" class="agent-note">
              分析条件已更新，等待新的结果。
            </p>
            <article
              v-for="(result, resultIndex) in currentResults ? state.detail.results : []"
              :key="result.id"
              class="agent-result"
            >
              <div class="agent-row">
                <h4>[E{{ resultIndex + 1 }}] {{ result.title }}</h4>
                <button @click="emit('locate', result)">定位海图</button>
              </div>
              <p>{{ result.summary }}</p>
              <p
                v-for="limitation in result.evidence.limitations"
                :key="limitation"
                class="agent-note"
              >
                {{ limitation }}
              </p>
              <details>
                <summary>本地证据 · {{ result.evidence.ais.length }} 条观测</summary>
                <p>MMSI {{ result.mmsi }} · 规则版本 {{ result.definitionVersion }}</p>
                <h5>观测事实</h5>
                <ul>
                  <li v-for="point in result.evidence.ais" :key="point.recordId">
                    {{ dateLabel(point.occurredAt) }}<br />{{ point.longitude.toFixed(4) }}°,
                    {{ point.latitude.toFixed(4) }}° · {{ point.speedOverGround ?? '—' }} kn
                  </li>
                </ul>
                <h5>规则匹配</h5>
                <ol>
                  <li v-for="step in result.evidence.steps" :key="step.id">
                    <strong>{{ step.rule }}</strong>
                    <p>{{ step.outcome }}</p>
                    <small>证据：{{ step.references.join(' · ') }}</small>
                  </li>
                </ol>
                <h5>公告依据</h5>
                <article v-for="document in result.evidence.documents" :key="document.id">
                  <strong>{{ document.title }}</strong>
                  <p v-for="paragraph in document.paragraphs" :key="paragraph.id">
                    {{ paragraph.text }}
                  </p>
                </article>
                <details>
                  <summary>实际运行参数</summary>
                  <pre>{{ JSON.stringify(result.evidence.parameters, null, 2) }}</pre>
                </details>
              </details>
            </article>
          </section>
        </div>
      </component>
      <ChartAgentHistoryPanel :state="state" :open="historyOpen" @close="closeHistory" />
    </template>
  </section>
</template>

<style scoped>
.agent-panel {
  display: grid;
  gap: 18px;
  min-width: 0;
  padding: 18px 7px 24px;
  font-size: 12px;
  color: #c1d9e7;
}
.agent-panel p {
  margin: 4px 0;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.agent-panel h3,
.agent-panel h4,
.agent-panel h5 {
  margin: 0;
  color: #e0f4ff;
}
.agent-panel h5 {
  margin-top: 12px;
}
.agent-panel small {
  color: #80aabd;
  line-height: 1.5;
}
.agent-intro {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 2px 0 0;
}
.agent-avatar {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  border: 1px solid #427591;
  border-radius: 50%;
  color: #b9edff;
  background: radial-gradient(circle at 35% 20%, #1c526e, #071c2b 72%);
}
.agent-avatar-intro {
  width: 42px;
  height: 42px;
  color: #cff8ff;
  border: 3px solid #3d8caf;
  box-shadow:
    0 0 0 3px #3e507c55,
    0 0 18px #17b8dc33;
}
.agent-avatar-intro svg {
  width: 23px;
  height: 23px;
}
.agent-intro h3 {
  font-size: 17px;
  letter-spacing: 0.6px;
}
.agent-intro p {
  font-size: 11px;
  color: #8db8ca;
}
.agent-session-bar {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  margin-top: -4px;
}
.agent-history-trigger,
.agent-new-session {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 34px;
  border-radius: 7px;
}
.agent-history-trigger {
  color: #c7efff;
  border-color: #2786a3;
  background: linear-gradient(115deg, #10415a, #0a2537);
}
.agent-new-session {
  color: #9fc7da;
  border-color: #23465b;
  background: #071d2b;
  padding-inline: 10px;
}
.agent-session-count {
  min-width: 18px;
  padding: 1px 5px;
  border-radius: 9px;
  color: #7de3f5;
  background: #092b3d;
  font-variant-numeric: tabular-nums;
}
.agent-current-session {
  display: flex;
  align-items: center;
  gap: 7px;
  grid-column: 1 / -1;
  min-width: 0;
  color: #83adbf;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: 11px;
}
.agent-current-session > span {
  width: 5px;
  height: 5px;
  flex-shrink: 0;
  border-radius: 50%;
  background: #29bfd6;
  box-shadow: 0 0 7px #29bfd655;
}
.agent-welcome {
  display: grid;
  gap: 9px;
  padding: 15px 12px;
  border: 1px solid #3a486e;
  border-radius: 13px;
  background: radial-gradient(ellipse at top left, #18364470, transparent 70%), #091b29;
  box-shadow: inset 0 1px 0 #b2d8fc08;
}
.agent-welcome h4 {
  display: flex;
  align-items: center;
  gap: 9px;
  font-size: 14px;
}
.agent-welcome h4 > span {
  color: #f7ce63;
  font-size: 24px;
  line-height: 1;
}
.agent-welcome > p {
  font-size: 11px;
  color: #90aebe;
}
.agent-welcome > button {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  width: fit-content;
  max-width: 100%;
  padding: 8px 10px;
  text-align: left;
  border-radius: 19px;
  border-color: #344b70;
  color: #c5dce9;
  background: linear-gradient(100deg, #172f40, #10283a);
}
.agent-welcome > button > span {
  overflow-wrap: anywhere;
}
.agent-welcome > button > svg {
  flex-shrink: 0;
  color: #70bed8;
}
.agent-panel button:disabled {
  cursor: not-allowed;
  opacity: 0.48;
}
.agent-panel button:not(:disabled):hover {
  border-color: #39b2d0;
  color: #e2faff;
}
.agent-panel select,
.agent-panel textarea,
.agent-panel input {
  min-width: 0;
  background: #082436;
  color: #d8effc;
  border: 1px solid #275369;
  border-radius: 4px;
  padding: 7px;
}
.agent-panel button {
  font-size: 11px;
}
.agent-panel button:focus-visible,
.agent-panel select:focus-visible,
.agent-panel textarea:focus-visible,
.agent-panel input:focus-visible {
  outline: 2px solid #56d9f5;
  outline-offset: 2px;
}
.agent-region {
  display: grid;
  gap: 8px;
  padding: 11px;
  border: 1px solid #1c3c50;
  border-radius: 9px;
  background: #081b2a99;
}
.agent-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.agent-row h4 {
  flex: 1;
}
.agent-row input {
  width: 72px;
}
.agent-coordinates {
  color: #77ccdb;
  font-variant-numeric: tabular-nums;
}
.agent-messages {
  display: grid;
  gap: 22px;
  min-width: 0;
  padding-top: 3px;
}
.agent-message {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.agent-message.user {
  flex-direction: row-reverse;
  margin-left: 20px;
}
.agent-message-avatar {
  width: 28px;
  height: 28px;
  margin-top: 23px;
}
.agent-message.assistant .agent-message-avatar {
  border: 2px solid #397f9f;
  box-shadow:
    0 0 0 2px #3e507c55,
    0 0 12px #17b8dc2b;
}
.agent-message.user .agent-message-avatar {
  color: #a8cce9;
  border-color: #31506d;
  background: #102536;
}
.agent-message-body {
  min-width: 0;
  max-width: calc(100% - 36px);
}
.agent-message-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin: 0 4px 6px;
  color: #7198ae;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.agent-message-meta > small {
  font-size: 10px;
}
.agent-message.user .agent-message-meta {
  justify-content: flex-end;
}
.agent-message-bubble {
  min-width: 0;
  padding: 11px 12px;
  border: 1px solid #203e50;
  border-radius: 3px 12px 12px;
  background: linear-gradient(135deg, #102a3a, #0b1e2c);
  box-shadow: 0 5px 16px #00000016;
}
.agent-message.user .agent-message-bubble {
  border-color: #18a9d5;
  border-radius: 12px 12px 3px;
  color: #e7f8ff;
  background: linear-gradient(115deg, #075b7f, #08405e);
  box-shadow: inset 0 0 16px #049bc822;
}
.agent-message p,
.agent-summary p {
  white-space: pre-wrap;
}
.agent-message-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 8px;
}
.agent-message-actions > button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 5px;
  border: 1px solid transparent;
  background: transparent;
  color: #8bb2ca;
  font-size: 10px;
}
.agent-tasks,
.agent-detail {
  display: grid;
  gap: 10px;
  border-top: 1px solid #19485d;
  padding-top: 12px;
}
.agent-task-row {
  display: flex;
  gap: 6px;
}
.agent-task-select {
  flex: 1;
  min-width: 0;
  text-align: left;
  display: grid;
  gap: 4px;
}
.agent-task-select span {
  overflow-wrap: anywhere;
}
.agent-task-select[aria-pressed='true'] {
  border-color: #31b5cf;
  background: #123f55;
}
.agent-summary {
  padding: 12px;
  border: 1px solid #26718a;
  background: #0c3045;
}
.agent-result {
  border-top: 1px solid #205166;
  padding-top: 12px;
}
.agent-panel details {
  line-height: 1.7;
}
.agent-panel summary {
  cursor: pointer;
  color: #80cee1;
}
.agent-panel li {
  margin: 6px 0;
  overflow-wrap: anywhere;
}
.agent-panel pre {
  overflow-x: auto;
  max-width: 100%;
  font-size: 11px;
}
.agent-note {
  color: #d3bc85;
  font-size: 11px;
}
.agent-error {
  color: #ffb6ac;
  border-left: 2px solid #da806f;
  padding-left: 8px;
}
</style>
