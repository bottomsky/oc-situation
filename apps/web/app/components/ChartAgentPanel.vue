<script setup lang="ts">
import type { AnalysisResult, Bbox } from '@ais/contracts';
import type { AgentConversationState } from '../composables/useAgentConversation';
import {
  agentStatusLabel,
  agentTaskActive,
  agentTaskHasAnalysis,
  createAgentMessageFollow,
} from '../composables/useAgentConversation';
import { dateLabel } from '../utils/display';

const props = defineProps<{ bbox: Bbox; state: AgentConversationState }>();
const emit = defineEmits<{ locate: [result: AnalysisResult] }>();
const state = props.state;
const selectedTask = computed(() => state.detail?.task);
const hasAnalysis = computed(
  () => !!selectedTask.value && agentTaskHasAnalysis(selectedTask.value, state.detail?.steps ?? []),
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
    selectedTask.value.summaryResultVersion === selectedTask.value.resultVersion,
);
const tools: Record<string, string> = {
  list_algorithms: '查询可用算法',
  region_overview: '查询区域概况',
  related_notices: '查询相关公告',
  create_task: '创建分析任务',
  run_analysis: '执行区域算法',
  read_results: '读取分析结果',
  read_evidence: '读取证据摘要',
  ask_user: '补充分析条件',
};
function changeSession(event: Event) {
  const id = (event.target as HTMLSelectElement).value;
  if (id) void state.openSession(id);
  else state.newSession();
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
    <div class="agent-intro">
      <ChartIcon name="Bot" />
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
        <label for="agent-session">研判会话</label>
        <select
          id="agent-session"
          :value="state.activeSession?.id ?? ''"
          :disabled="state.busy"
          @change="changeSession"
        >
          <option value="">新会话</option>
          <option v-for="item in state.sessions" :key="item.id" :value="item.id">
            {{ item.title }}
          </option>
        </select>
        <button :disabled="state.busy" @click="state.newSession">新建</button>
      </div>
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
          :class="message.role"
          :data-message-id="message.id"
          :data-task-id="message.taskId"
          tabindex="-1"
        >
          <small>{{ message.role === 'user' ? '你' : '研判助手' }}</small>
          <p>{{ message.content }}</p>
        </article>
      </div>
      <small
        >在海图下方输入问题或继续追问。区域研判的坐标与船舶标识由本地平台处理，模型接收脱敏摘要和证据引用。</small
      >
      <section v-if="state.tasks.length" class="agent-tasks" aria-label="智能体任务">
        <h4>本会话任务</h4>
        <div v-for="task in [...state.tasks].reverse()" :key="task.id" class="agent-task-row">
          <button
            class="agent-task-select"
            :aria-pressed="state.selectedTaskId === task.id"
            @click="state.loadTask(task.id)"
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
        </div>
      </section>
      <p v-if="state.detailLoading" role="status">正在读取任务证据…</p>
      <section v-if="state.detail && selectedTask" class="agent-detail" aria-label="智能体任务详情">
        <div class="agent-row">
          <h4>{{ agentStatusLabel[selectedTask.status] }}</h4>
          <small>结果版本 {{ selectedTask.resultVersion }}</small>
        </div>
        <p v-if="selectedTask.error" class="agent-error">{{ selectedTask.error }}</p>
        <p v-if="selectedTask.status === 'awaiting_input'" class="agent-note">
          请按助手提示补充本次分析所需条件后继续发送；区域分析可在上方确认范围。
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
        <p v-else-if="selectedTask.summary" class="agent-note">结果已更新，摘要正在重新核对。</p>
        <p
          v-if="hasAnalysis && selectedTask.status === 'completed' && !state.detail.results.length"
          class="agent-note"
        >
          本次算法未形成匹配结果，请结合数据覆盖说明调整范围。
        </p>
        <article
          v-for="(result, resultIndex) in state.detail.results"
          :key="result.id"
          class="agent-result"
        >
          <div class="agent-row">
            <h4>[E{{ resultIndex + 1 }}] {{ result.title }}</h4>
            <button @click="emit('locate', result)">定位海图</button>
          </div>
          <p>{{ result.summary }}</p>
          <p v-for="limitation in result.evidence.limitations" :key="limitation" class="agent-note">
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
    </template>
  </section>
</template>

<style scoped>
.agent-panel {
  display: grid;
  gap: 16px;
  padding: 16px 12px 24px;
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
  border-bottom: 1px solid #19485d;
  padding-bottom: 12px;
}
.agent-intro > svg {
  width: 30px;
  height: 30px;
  color: #45d4ff;
  flex-shrink: 0;
}
.agent-intro h3 {
  font-size: 15px;
}
.agent-session-bar {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  gap: 8px;
  align-items: center;
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
  padding: 10px;
  border: 1px solid #1b4a60;
  border-radius: 5px;
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
  gap: 10px;
}
.agent-message {
  padding: 10px 12px;
  background: #0b2b40;
  border-left: 2px solid #3ba7ba;
}
.agent-message.user {
  background: #10354a;
  border-left-color: #557c95;
  margin-left: 16px;
}
.agent-message p,
.agent-summary p {
  white-space: pre-wrap;
}
.agent-compose {
  display: grid;
  gap: 8px;
}
.agent-compose textarea {
  width: 100%;
  resize: vertical;
}
.agent-compose button {
  background: #125068;
  border-color: #2389a3;
  padding: 9px;
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
