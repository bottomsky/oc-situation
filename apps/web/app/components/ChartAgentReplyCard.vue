<script setup lang="ts">
import type {
  CurrentAgentReply,
  CurrentAgentReplyStatus,
} from '../composables/useAgentConversation';
import { agentStatusLabel } from '../composables/useAgentConversation';
import { dateLabel } from '../utils/display';

const props = defineProps<{ reply: CurrentAgentReply }>();
const emit = defineEmits<{ close: []; open: [] }>();
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
      <span class="reply-card-bot"><ChartIcon name="Bot" :size="23" /></span>
      <div class="reply-card-title">
        <h2>AI 回复</h2>
        <div class="reply-card-meta">
          <span role="status">{{ labels[reply.status] }}</span>
          <time :datetime="reply.assistant?.createdAt ?? reply.createdAt">{{
            dateLabel(reply.assistant?.createdAt ?? reply.createdAt)
          }}</time>
        </div>
      </div>
      <button
        type="button"
        class="reply-card-close"
        aria-label="关闭当前回复"
        @click="emit('close')"
      >
        <ChartIcon name="X" :size="18" />
      </button>
    </header>
    <div class="reply-card-body" tabindex="0" aria-label="当前回复内容">
      <p class="reply-card-question" :title="reply.question">{{ reply.question }}</p>
      <p v-if="reply.assistant" class="reply-card-answer" :data-message-id="reply.assistant.id">
        {{ reply.assistant.content }}
      </p>
      <p v-else-if="waitingText" class="reply-card-pending" role="status">{{ waitingText }}</p>
      <p v-if="reply.error" class="reply-card-error" role="alert">
        <template v-if="reply.taskId && !['failed', 'cancelled'].includes(reply.status)">
          问题已提交，状态读取失败：
        </template>
        {{ reply.error }}
      </p>
    </div>
    <footer class="reply-card-footer">
      <button type="button" @click="emit('open')">
        <ChartIcon name="MessageCircle" :size="14" />查看完整对话
        <ChartIcon name="ArrowRight" :size="14" />
      </button>
    </footer>
  </section>
</template>

<style scoped>
.chart-agent-reply-card {
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 360px;
  overflow: auto;
  border: 1px solid #38c9e9;
  border-radius: 17px;
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
.reply-card-bot {
  display: grid;
  place-items: center;
  width: 37px;
  height: 37px;
  flex: 0 0 37px;
  border: 1px solid #2c8aa5;
  border-radius: 11px;
  background: #0b405b;
  color: #67e3f8;
}
.reply-card-bot svg {
  width: 23px;
  height: 23px;
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
  font-size: 12px;
  color: #ffc2ad;
}
.reply-card-footer {
  display: flex;
  justify-content: flex-end;
  flex: 0 0 auto;
  margin: 0 17px;
  padding: 8px 0 10px;
  border-top: 1px solid rgb(65 128 149 / 25%);
}
.reply-card-footer button {
  border: 0;
  background: transparent;
  color: #71d9eb;
  padding: 4px 0 4px 8px;
  font-size: 11px;
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
  .reply-card-heading {
    gap: 8px;
    padding: 9px 12px 7px;
  }
  .reply-card-bot {
    width: 30px;
    height: 30px;
    flex-basis: 30px;
    border-radius: 8px;
  }
  .reply-card-title h2 {
    margin-bottom: 2px;
    font-size: 14px;
    line-height: 17px;
  }
  .reply-card-meta {
    font-size: 9px;
    line-height: 12px;
  }
  .reply-card-body {
    min-height: 40px;
  }
  .reply-card-footer {
    padding-block: 5px;
  }
  .reply-card-footer button {
    padding-block: 3px;
    font-size: 10px;
    line-height: 14px;
  }
}
</style>
