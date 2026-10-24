<script setup lang="ts">
import { useId } from 'vue';
import type {
  CurrentAgentReply,
  CurrentAgentReplyStatus,
} from '../composables/useAgentConversation';
import { agentStatusLabel } from '../composables/useAgentConversation';
import { dateLabel } from '../utils/display';
import type { ReplyObjectViewModel } from '../types/agentReply';
import {
  placeReplyObjectTooltip,
  replyBusinessType,
  replyObjectIcons,
  replyObjectLabels,
} from '../utils/replyObjects';

const props = withDefaults(
  defineProps<{
    reply: CurrentAgentReply;
    compact?: boolean;
    shortViewport?: boolean;
    refocus?: boolean;
    objects?: ReplyObjectViewModel[];
    omittedCount?: number;
  }>(),
  { objects: () => [], omittedCount: 0 },
);
const expanded = ref(false);
const narrow = ref(false);
const tooltipId = useId();
const activeTooltip = shallowRef<{ object: ReplyObjectViewModel; anchor: HTMLElement } | null>(
  null,
);
const tooltipTarget = shallowRef<HTMLElement | null>(null);
const tooltipElement = useTemplateRef<HTMLElement>('objectTooltip');
const tooltipReady = ref(false);
const tooltipStyle = ref({ left: '0px', top: '0px', maxWidth: '300px', maxHeight: '300px' });
let tooltipFrame = 0;
let tooltipHide: ReturnType<typeof setTimeout> | undefined;
let tooltipHovered = false;
function clearTooltip() {
  clearTimeout(tooltipHide);
  cancelAnimationFrame(tooltipFrame);
  tooltipFrame = 0;
  activeTooltip.value = null;
  tooltipReady.value = false;
}
function positionTooltip() {
  tooltipFrame = 0;
  const current = activeTooltip.value;
  if (!current?.anchor.isConnected) {
    clearTooltip();
    return;
  }
  tooltipTarget.value = (document.fullscreenElement as HTMLElement | null) ?? document.body;
  const overlay = current.anchor.closest('.chart-focus-overlay')?.getBoundingClientRect();
  const bounds = {
    left: Math.max(0, overlay?.left ?? 0),
    top: Math.max(0, overlay?.top ?? 0),
    right: Math.min(window.innerWidth, overlay?.right ?? window.innerWidth),
    bottom: Math.min(window.innerHeight, overlay?.bottom ?? window.innerHeight),
  };
  const size = tooltipElement.value?.getBoundingClientRect();
  const placement = placeReplyObjectTooltip(bounds, current.anchor.getBoundingClientRect(), {
    width: size?.width ?? 300,
    height: size?.height ?? 30,
  });
  const next = {
    left: `${placement.left}px`,
    top: `${placement.top}px`,
    maxWidth: `${Math.min(300, placement.maxWidth)}px`,
    maxHeight: `${placement.maxHeight}px`,
  };
  if (
    Object.keys(next).some(
      (key) => next[key as keyof typeof next] !== tooltipStyle.value[key as keyof typeof next],
    )
  )
    tooltipStyle.value = next;
  tooltipReady.value = true;
  tooltipFrame = requestAnimationFrame(positionTooltip);
}
async function showTooltip(event: Event, object: ReplyObjectViewModel) {
  const anchor = event.currentTarget;
  if (!(anchor instanceof HTMLElement)) return;
  clearTimeout(tooltipHide);
  cancelAnimationFrame(tooltipFrame);
  tooltipHovered = false;
  tooltipReady.value = false;
  const tooltip = { object, anchor };
  activeTooltip.value = tooltip;
  tooltipTarget.value = (document.fullscreenElement as HTMLElement | null) ?? document.body;
  await nextTick();
  if (activeTooltip.value === tooltip) positionTooltip();
}
function queueHideTooltip() {
  clearTimeout(tooltipHide);
  tooltipHide = setTimeout(() => {
    const active = document.activeElement;
    if (
      !tooltipHovered &&
      active !== activeTooltip.value?.anchor &&
      !tooltipElement.value?.contains(active)
    )
      clearTooltip();
  }, 100);
}
function holdTooltip() {
  tooltipHovered = true;
  clearTimeout(tooltipHide);
}
function leaveTooltip() {
  tooltipHovered = false;
  queueHideTooltip();
}
const title = computed(() => replyBusinessType(props.reply.intent, props.objects));
const inlineObjects = computed(() => props.objects.slice(0, narrow.value ? 1 : 3));
const remaining = computed(() => props.objects.length - inlineObjects.value.length);
const identifying = computed(() =>
  ['sending', 'queued', 'running', 'waiting_result', 'waiting_ui'].includes(props.reply.status),
);
let media: MediaQueryList | undefined;
function measureNarrow() {
  narrow.value = media?.matches ?? false;
}
onMounted(() => {
  media = window.matchMedia('(max-width: 767px)');
  measureNarrow();
  media.addEventListener('change', measureNarrow);
});
onBeforeUnmount(() => {
  media?.removeEventListener('change', measureNarrow);
  clearTooltip();
});
watch(() => [props.reply.taskId, props.reply.inputRevision], clearTooltip);
const emit = defineEmits<{
  close: [];
  open: [];
  reference: [reference: string, taskId: string, resultVersion: number];
  object: [object: ReplyObjectViewModel];
  objects: [];
  refocus: [];
}>();
const labels: Record<CurrentAgentReplyStatus, string> = {
  ...agentStatusLabel,
  sending: '正在发送问题',
  send_failed: '发送失败',
};
const waitingText = computed(() => {
  if (props.reply.error) return '';
  switch (props.reply.status) {
    case 'completed':
      return '正在同步助手回复…';
    case 'failed':
      return '本次请求执行失败，可在完整对话中查看任务记录。';
    case 'cancelled':
      return '本次任务已取消。';
    case 'awaiting_input':
      return '助手正在同步需要补充的条件。';
    default:
      return '助手正在处理本次问题，回复将在这里显示。';
  }
});
</script>

<template>
  <section
    class="chart-agent-reply-card"
    :class="{
      compact: compact && !expanded,
      'compact-layout': compact,
      'short-viewport': shortViewport,
    }"
    aria-label="当前问题的 AI 回复"
    data-testid="chart-agent-current-reply"
    :data-task-id="reply.taskId ?? undefined"
    :data-status="reply.status"
    @pointerdown.stop
    @click.stop
    @dblclick.stop
    @wheel.stop
    @keydown.stop
    @keydown.esc.stop.prevent="emit('close')"
  >
    <header class="reply-card-heading">
      <ChartHolographicAvatar :status="reply.status" />
      <div class="reply-card-title">
        <div class="reply-title-line">
          <span class="reply-ai-label">AI 回复</span>
          <h2 :title="title">{{ title }}</h2>
        </div>
        <div class="reply-card-meta">
          <span role="status">{{ labels[reply.status] }}</span>
          <time :datetime="reply.assistant?.createdAt ?? reply.createdAt">{{
            dateLabel(reply.assistant?.createdAt ?? reply.createdAt)
          }}</time>
        </div>
      </div>
      <div class="reply-card-tools">
        <button
          v-if="shortViewport && refocus"
          type="button"
          class="reply-card-close"
          aria-label="重新聚焦"
          title="重新聚焦"
          @click="emit('refocus')"
        >
          <ChartIcon name="Compass" :size="16" />
        </button>
        <button
          v-if="compact"
          class="reply-card-close reply-expand"
          type="button"
          :aria-label="expanded ? '收起回复' : '展开回复'"
          :title="expanded ? '收起回复' : '展开回复'"
          :aria-expanded="expanded"
          @click="expanded = !expanded"
        >
          <ChartIcon :name="expanded ? 'ChevronUp' : 'ChevronDown'" :size="16" />
        </button>
        <button
          type="button"
          class="reply-card-close"
          aria-label="查看完整对话"
          title="查看完整对话"
          @click="emit('open')"
        >
          <ChartIcon name="MessageCircle" :size="16" />
        </button>
        <button
          type="button"
          class="reply-card-close"
          aria-label="关闭当前回复"
          @click="emit('close')"
        >
          <ChartIcon name="X" :size="18" />
        </button>
      </div>
    </header>
    <div class="reply-card-body" tabindex="0" aria-label="当前回复内容">
      <p class="reply-card-question" :title="reply.question">{{ reply.question }}</p>
      <p v-if="reply.assistant" class="reply-card-answer" :data-message-id="reply.assistant.id">
        <AgentMessageText
          :message="reply.assistant"
          @reference="(reference, taskId, version) => emit('reference', reference, taskId, version)"
        />
      </p>
      <p v-else-if="waitingText" class="reply-card-pending" role="status">{{ waitingText }}</p>
    </div>
    <p
      v-if="reply.error"
      class="reply-card-error"
      role="alert"
      tabindex="0"
      aria-label="当前回复错误"
    >
      <template v-if="reply.taskId && !['failed', 'cancelled'].includes(reply.status)">
        问题已提交，状态读取失败：
      </template>
      {{ reply.error }}
    </p>
    <footer class="reply-card-footer" aria-label="回复关联对象">
      <template v-if="objects.length">
        <div class="reply-object-names">
          <span v-for="object in inlineObjects" :key="object.key" class="reply-object-entry">
            <button
              type="button"
              class="reply-object-name"
              :aria-label="`查看${replyObjectLabels[object.ref.kind]}：${object.label}`"
              :aria-describedby="
                activeTooltip?.object.key === object.key ? `${tooltipId}-name` : undefined
              "
              @mouseenter="showTooltip($event, object)"
              @focus="showTooltip($event, object)"
              @mouseleave="queueHideTooltip"
              @blur="queueHideTooltip"
              @click="emit('object', object)"
            >
              <ChartIcon :name="replyObjectIcons[object.ref.kind]" :size="13" /><span>{{
                object.label
              }}</span>
            </button>
          </span>
          <span
            v-if="remaining > 0"
            class="reply-object-ellipsis"
            :aria-label="`另有 ${remaining} 个已关联对象`"
            >…</span
          >
        </div>
        <button
          type="button"
          class="reply-objects-more"
          :aria-label="`查看更多关联对象，已关联 ${objects.length} 个`"
          @click="emit('objects')"
        >
          查看更多 <span>{{ objects.length }}</span
          ><ChartIcon name="ChevronRight" :size="13" />
        </button>
      </template>
      <p v-else class="reply-object-empty" role="status">
        {{ identifying ? '正在识别关联对象' : '本次回复未关联具体对象' }}
      </p>
      <p v-if="omittedCount" class="reply-object-omitted">
        另有 {{ omittedCount }} 项超出本次快照范围
      </p>
    </footer>
  </section>
  <Teleport v-if="activeTooltip && tooltipTarget" :to="tooltipTarget">
    <span
      :id="`${tooltipId}-name`"
      ref="objectTooltip"
      role="tooltip"
      class="reply-object-tooltip"
      tabindex="0"
      :style="{ ...tooltipStyle, visibility: tooltipReady ? 'visible' : 'hidden' }"
      @mouseenter="holdTooltip"
      @mouseleave="leaveTooltip"
      @blur="queueHideTooltip"
      @pointerdown.stop
      @click.stop
      @wheel.stop
      @keydown.stop
      >{{ replyObjectLabels[activeTooltip.object.ref.kind] }} ·
      {{ activeTooltip.object.label }}</span
    >
  </Teleport>
</template>

<style scoped>
.chart-agent-reply-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: min(360px, var(--focus-card-max-height, 360px));
  overflow: hidden;
  border: 1px solid rgb(67 157 183 / 36%);
  border-top-color: #57d6ed;
  border-bottom-color: #48cce4;
  border-radius: 5px;
  background: linear-gradient(135deg, rgb(9 42 62 / 98%), rgb(5 26 44 / 96%));
  color: #d4edf8;
  box-shadow:
    0 8px 30px rgb(0 8 20 / 28%),
    inset 0 1px 0 rgb(111 232 255 / 12%);
  pointer-events: auto;
  scrollbar-width: thin;
  scrollbar-color: #276e87 transparent;
}
.reply-card-heading {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 15px 17px 10px;
  flex: 0 0 auto;
}
.reply-card-heading .holographic-avatar {
  width: 42px;
  height: 48px;
  flex: 0 0 42px;
}
.reply-title-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px 9px;
}
.reply-ai-label {
  color: #8caebf;
  font-size: 10px;
  letter-spacing: 0.1em;
}
.reply-card-title {
  flex: 1;
  min-width: 0;
}
.reply-card-title h2 {
  margin: 0 0 4px;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.5px;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 3px 10px;
  color: #78a9bc;
  font-size: 10px;
  line-height: 1.5;
}
.reply-card-meta span {
  color: #6fd7e8;
}
.reply-card-close {
  align-self: flex-start;
  border: 0;
  border-radius: 50%;
  padding: 6px;
  background: transparent;
  color: #a4c8d7;
}
.reply-card-tools {
  display: flex;
  align-self: flex-start;
  gap: 0;
  flex: 0 0 auto;
}
.reply-card-body {
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 18px;
  scrollbar-width: thin;
  scrollbar-color: #276e87 transparent;
}
.reply-card-body:focus-visible {
  outline: 1px solid #43dcff;
  outline-offset: -1px;
}
.reply-card-body p {
  margin: 0 0 10px;
  overflow-wrap: anywhere;
}
.reply-card-question {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #87b2c4;
  font-size: 11px;
}
.reply-card-answer {
  white-space: pre-wrap;
  font-size: 13px;
  line-height: 1.8;
}
.reply-card-pending {
  font-size: 12px;
  color: #a6c9d8;
}
.reply-card-error {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 76px;
  margin: 0 18px 10px;
  overflow-y: auto;
  overscroll-behavior: contain;
  overflow-wrap: anywhere;
  font-size: 12px;
  line-height: 1.6;
  color: #ffc2ad;
}
.reply-card-error:focus-visible {
  outline: 1px solid #43dcff;
  outline-offset: 2px;
}
.reply-card-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 5px 8px;
  flex: 0 0 auto;
  margin: 0 17px;
  padding: 8px 0 10px;
  border-top: 1px solid rgb(65 128 149 / 25%);
}
.reply-objects-more {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  border: 0;
  background: transparent;
  color: #71d9eb;
  padding: 4px 0 4px 8px;
  font-size: 11px;
}
.reply-object-names {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 4px;
}
.reply-object-entry {
  position: relative;
  min-width: 0;
}
.reply-object-name {
  display: flex;
  gap: 4px;
  align-items: center;
  max-width: 86px;
  width: 100%;
  padding: 4px 2px;
  border: 0;
  background: transparent;
  color: #97d6e3;
  font-size: 11px;
}
.reply-object-name svg {
  flex: 0 0 13px;
}
.reply-object-name > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.reply-object-name:hover {
  color: #d7f8ff;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.reply-object-tooltip {
  position: fixed;
  z-index: 95;
  box-sizing: border-box;
  max-width: 300px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 5px 8px;
  border: 1px solid #317c96;
  border-radius: 4px;
  background: #082c40;
  color: #d5f5ff;
  font-size: 11px;
  overflow-wrap: anywhere;
  line-height: 1.5;
}
.reply-object-ellipsis {
  color: #7eafc2;
}
.reply-objects-more > span {
  color: #86afbf;
  font-variant-numeric: tabular-nums;
}
.reply-object-empty,
.reply-object-omitted {
  margin: 0;
  color: #82a8ba;
  font-size: 10px;
  line-height: 1.5;
}
.reply-object-omitted {
  flex-basis: 100%;
  color: #c0a971;
}
@media (max-width: 600px) {
  .reply-card-heading {
    padding: 12px 12px 8px;
  }
  .reply-card-body {
    padding: 0 13px;
  }
  .reply-card-footer {
    margin-inline: 12px;
  }
  .reply-card-answer {
    font-size: 12px;
  }
}
@media (max-height: 650px) {
  .chart-agent-reply-card .holographic-avatar {
    width: 24px;
    height: 28px;
    flex: 0 0 24px;
  }
  .reply-card-question {
    display: none;
  }
  .reply-card-close {
    padding: 4px;
  }
  .reply-card-heading {
    gap: 6px;
    padding: 4px 8px;
  }
  .reply-card-title h2 {
    margin-bottom: 2px;
    font-size: 12px;
    line-height: 14px;
  }
  .reply-card-meta {
    font-size: 10px;
    line-height: 12px;
  }
  .reply-card-body {
    min-height: 40px;
    flex: 1 1 auto;
  }
  .reply-card-footer {
    margin-inline: 8px;
    padding-block: 3px;
  }
  .reply-card-footer button {
    padding-block: 2px;
    font-size: 10px;
    line-height: 14px;
  }
}
.compact .reply-card-body {
  display: none;
}
.compact-layout .reply-card-footer {
  margin-inline: 10px;
  padding-block: 5px;
}
.compact-layout .reply-card-error {
  max-height: 64px;
  margin: 0 10px 7px;
  font-size: 11px;
  line-height: 1.5;
}
@media (max-width: 767px) {
  .reply-object-name {
    max-width: 180px;
  }
}
.compact-layout .reply-card-heading {
  gap: 8px;
  padding: 5px 10px;
}
.compact-layout .reply-ai-label {
  display: none;
}
.compact-layout .holographic-avatar {
  width: 28px;
  height: 32px;
  flex: 0 0 28px;
}
.compact-layout .reply-card-title h2 {
  margin-bottom: 2px;
  font-size: 12px;
  line-height: 14px;
}
.compact-layout .reply-card-meta {
  font-size: 10px;
  line-height: 12px;
}
.compact-layout .reply-card-close {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 3px;
}
.reply-expand {
  color: #72ddef;
}
.short-viewport .reply-card-heading {
  gap: 6px;
  padding: 3px 8px;
}
.short-viewport .reply-ai-label {
  display: none;
}
.short-viewport .holographic-avatar {
  width: 28px;
  height: 32px;
  flex: 0 0 28px;
}
.short-viewport .reply-card-title h2 {
  margin-bottom: 2px;
  font-size: 12px;
  line-height: 14px;
}
.short-viewport .reply-card-meta {
  font-size: 10px;
  line-height: 12px;
}
.short-viewport .reply-card-tools .reply-card-close {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 2px;
}
.short-viewport .reply-card-footer {
  margin-inline: 8px;
  padding-block: 3px;
}
.short-viewport .reply-object-name {
  padding-block: 2px;
  font-size: 11px;
}
.short-viewport .reply-objects-more {
  padding-block: 2px;
  font-size: 10px;
}
.short-viewport .reply-card-body {
  min-height: 40px;
  flex: 1 1 auto;
}
</style>
