<script setup lang="ts">
import { isUiIntent } from '../../../../packages/domain/agent-ui-intent';
import type { AgentConversationState } from '../composables/useAgentConversation';
const props = withDefaults(defineProps<{ state: AgentConversationState; floating?: boolean }>(), {
  floating: false,
});
const emit = defineEmits<{ open: []; submit: [] }>();
const composing = ref(false);
const inputFocused = ref(false);
const isActive = computed(() => inputFocused.value || props.state.draft.length > 0);
const draftInput = computed({
  get: () => props.state.draft,
  set: (value: string) => props.state.setDraft(value),
});
const canSend = computed(
  () =>
    props.state.canWrite &&
    props.state.config?.enabled &&
    !props.state.loading &&
    !props.state.busy &&
    (!props.state.activeTask || isUiIntent(props.state.draft)) &&
    props.state.draft.trim().length > 0 &&
    props.state.draft.trim().length <= 4000,
);
const inputDisabled = computed(
  () =>
    !props.state.canWrite ||
    !props.state.config?.enabled ||
    props.state.loading ||
    props.state.busy,
);
const status = computed(
  () =>
    props.state.error ||
    (props.state.loading
      ? '正在连接区域研判助手…'
      : !props.state.config
        ? '智能体连接尚未就绪，可打开协同面板重试。'
        : !props.state.config.enabled
          ? '区域研判助手尚未启用，请由管理员完成服务配置。'
          : !props.state.canWrite
            ? '当前账号为只读权限，可查看已有会话与证据。'
            : props.state.activeTask
              ? '助手正在处理问题；仍可发送关闭图层或面板等界面指令。'
              : ''),
);
const placeholder = computed(() =>
  props.state.loading
    ? '正在连接区域研判助手…'
    : !props.state.config
      ? '连接尚未就绪，点击机器人查看'
      : !props.state.config.enabled
        ? '区域研判助手未启用'
        : !props.state.canWrite
          ? '只读账号可在右侧查看已有研判'
          : props.state.busy
            ? '正在发送问题…'
            : '输入问题，咨询信息或分析海域…',
);
async function submit() {
  if (!canSend.value || composing.value) return;
  emit('submit');
  await props.state.send();
}
function keydown(event: KeyboardEvent) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    composing.value ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  void submit();
}
</script>
<template>
  <div class="chart-agent-composer" :class="{ floating }" data-testid="chart-agent-composer">
    <p
      v-if="status"
      class="composer-status"
      :class="{ error: state.error }"
      :role="state.error ? 'alert' : 'status'"
    >
      {{ status }}
    </p>
    <form
      class="composer-capsule"
      :class="{ active: isActive }"
      :data-active="isActive"
      aria-label="海图智能体输入"
      @submit.prevent="submit"
      @pointerdown.stop
      @click.stop
      @dblclick.stop
    >
      <button
        type="button"
        class="composer-bot"
        aria-label="打开智能体对话"
        title="打开智能体协同与区域确认"
        @click="emit('open')"
      >
        <ChartIcon name="Bot" :size="25" />
      </button>
      <textarea
        v-model="draftInput"
        class="composer-input"
        aria-label="分析问题或继续追问"
        :placeholder="placeholder"
        rows="1"
        maxlength="4000"
        :disabled="inputDisabled"
        @focus="inputFocused = true"
        @blur="inputFocused = false"
        @keydown="keydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
      />
      <button
        type="submit"
        class="composer-send"
        aria-label="发送分析问题"
        :title="state.activeTask ? '任务执行完成后继续追问' : '发送问题（Enter），Shift+Enter 换行'"
        :disabled="!canSend"
        :aria-busy="state.busy"
      >
        <ChartIcon :name="state.busy ? 'Clock' : 'Send'" :size="21" />
      </button>
    </form>
  </div>
</template>
<style scoped>
.chart-agent-composer {
  width: 100%;
  pointer-events: none;
  color: #c1dfe9;
}
.composer-status {
  margin: 0 14px 9px;
  padding: 8px 12px;
  border: 1px solid #275367;
  border-radius: 8px;
  background: rgb(5 26 43 / 96%);
  font-size: 11px;
  line-height: 1.6;
  pointer-events: auto;
}
.composer-status.error {
  color: #ffc9a9;
  border-color: #97674d;
}
.floating .composer-status {
  background: rgb(5 26 43 / 20%);
  border-color: rgb(39 83 103 / 28%);
}
.floating .composer-status.error {
  background: rgb(37 24 17 / 70%);
  border-color: #97674d;
}
.composer-capsule {
  display: flex;
  align-items: center;
  gap: 13px;
  min-height: 68px;
  padding: 10px 13px;
  border: 1px solid rgb(49 87 106 / 40%);
  border-radius: 999px;
  background: rgb(5 27 44 / 12%);
  box-shadow: none;
  pointer-events: auto;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    box-shadow 140ms ease;
}
.composer-capsule.active {
  border-color: #45d8ff;
  background: rgb(5 27 44 / 22%);
  box-shadow:
    0 0 0 2px rgb(20 140 191 / 8%),
    0 6px 18px rgb(0 0 0 / 18%);
}
.composer-bot,
.composer-send {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  flex: 0 0 44px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgb(82 132 160 / 35%);
  color: #c3dce6;
  background: rgb(7 33 54 / 20%);
  box-shadow: none;
}
.composer-bot {
  position: relative;
}
.composer-bot::after {
  content: '';
  position: absolute;
  width: 5px;
  height: 5px;
  bottom: 5px;
  right: 4px;
  border-radius: 50%;
  background: rgb(120 193 210 / 50%);
  box-shadow: none;
}
.composer-capsule.active .composer-bot,
.composer-capsule.active .composer-send {
  color: #e0faff;
  background: rgb(9 70 108 / 35%);
  border-color: rgb(57 183 225 / 60%);
}
.composer-capsule.active .composer-send {
  background: rgb(11 107 153 / 40%);
}
.composer-capsule.active .composer-bot::after {
  background: #58e0ed;
}
.composer-send:disabled {
  opacity: 0.45;
  cursor: default;
}
.composer-input {
  display: block;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 24px;
  max-height: 96px;
  padding: 2px 0 2px 13px;
  border: 0;
  border-left: 1px solid rgb(36 69 81 / 53%);
  border-radius: 0;
  resize: none;
  background: transparent;
  color: #dbf1f8;
  font: inherit;
  font-size: 14px;
  line-height: 24px;
  outline: none;
  box-shadow: none;
}
.composer-input::placeholder {
  color: #8eaec1;
  opacity: 1;
}
.composer-input:disabled {
  color: #99bac8;
}
.composer-bot:focus-visible,
.composer-send:focus-visible {
  outline: 2px solid #8cecff;
  outline-offset: 3px;
}
@media (max-width: 600px) {
  .composer-capsule {
    min-height: 58px;
    gap: 8px;
    padding: 8px;
  }
  .composer-bot,
  .composer-send {
    width: 36px;
    height: 36px;
    flex-basis: 36px;
  }
  .composer-input {
    font-size: 12px;
    padding-left: 9px;
    line-height: 23px;
  }
  .composer-status {
    margin-right: 6px;
    margin-left: 6px;
    font-size: 10px;
  }
}
</style>
