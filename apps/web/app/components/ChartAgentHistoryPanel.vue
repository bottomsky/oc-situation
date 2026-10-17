<script setup lang="ts">
import type { AgentConversationState } from '../composables/useAgentConversation';
import { agentHistoryTime, groupAgentHistory } from '../utils/agentHistory';

const props = defineProps<{ state: AgentConversationState; open: boolean }>();
const emit = defineEmits<{ close: [] }>();
const search = ref('');
const openedAt = ref(new Date());
const groups = computed(() =>
  groupAgentHistory(props.state.sessions, search.value, openedAt.value),
);
watch(
  () => props.open,
  (open) => {
    if (open) openedAt.value = new Date();
  },
);
function newSession() {
  props.state.newSession();
  emit('close');
}
function selectSession(id: string) {
  if (props.state.busy || props.state.loading) return;
  if (props.state.activeSession?.id !== id) void props.state.openSession(id);
  emit('close');
}
</script>

<template>
  <ChartDetailFloat
    id="chart-agent-history"
    :open="open"
    side="right"
    title="历史会话"
    subtitle="CONVERSATION HISTORY"
    aria-label="历史会话"
    close-label="关闭历史会话"
    :width="288"
    motion="slide-left"
    data-detail-kind="history"
    class="agent-history-float"
    @close="emit('close')"
  >
    <div class="agent-history-panel">
      <button
        class="agent-history-new"
        type="button"
        :disabled="state.busy || state.loading"
        @click="newSession"
      >
        <ChartIcon name="Plus" :size="18" />新建会话
      </button>
      <label class="agent-history-search">
        <ChartIcon name="Search" :size="17" />
        <input v-model="search" type="search" placeholder="搜索会话..." aria-label="搜索历史会话" />
      </label>
      <p v-if="!groups.length" class="agent-history-empty" role="status">
        {{
          state.loading
            ? '正在读取会话…'
            : search.trim()
              ? '没有匹配的会话'
              : '暂无历史会话，开始一次新的研判。'
        }}
      </p>
      <section
        v-for="group in groups"
        :key="group.label"
        class="agent-history-group"
        :aria-label="group.label"
      >
        <h3>{{ group.label }}</h3>
        <ul>
          <li v-for="session in group.items" :key="session.id">
            <button
              type="button"
              class="agent-history-item"
              :aria-current="state.activeSession?.id === session.id ? 'true' : undefined"
              :aria-label="`打开会话：${session.title}`"
              :disabled="state.busy || state.loading"
              @click="selectSession(session.id)"
            >
              <ChartIcon name="MessageCircle" :size="18" />
              <span class="agent-history-summary"
                ><strong>{{ session.title || '未命名会话' }}</strong
                ><small>创建时间</small></span
              >
              <time
                :datetime="session.createdAt"
                :title="new Date(session.createdAt).toLocaleString('zh-CN')"
                >{{ agentHistoryTime(session.createdAt, openedAt) }}</time
              >
            </button>
          </li>
        </ul>
      </section>
    </div>
  </ChartDetailFloat>
</template>

<style scoped>
:global(.chart-detail-float.agent-history-float) {
  background: linear-gradient(145deg, #0a2a40, #061725 72%);
}
.agent-history-panel {
  display: grid;
  gap: 18px;
  padding: 2px 4px 20px;
  color: #c8e3f0;
}
.agent-history-new {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
  min-height: 42px;
  border: 1px solid #28d3f0;
  border-radius: 9px;
  background: linear-gradient(130deg, #065477, #0870a4a8);
  box-shadow:
    inset 0 -2px 0 #17c7ed66,
    0 0 16px #009bc41a;
  color: #ecfaff;
  font-weight: 600;
}
.agent-history-search {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 0 12px;
  border: 1px solid #234b60;
  border-radius: 8px;
  background: #041522b3;
  color: #739eb6;
}
.agent-history-search input {
  width: 100%;
  min-width: 0;
  min-height: 40px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #d9f1fb;
  font-size: 13px;
}
.agent-history-search:focus-within {
  border-color: #30cbe9;
  box-shadow: 0 0 0 2px #30cbe926;
}
.agent-history-search input:focus-visible {
  outline: none;
}
.agent-history-group h3 {
  margin: 0 0 8px 4px;
  color: #8eacbd;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 1px;
}
.agent-history-group ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.agent-history-item {
  display: flex;
  align-items: flex-start;
  width: 100%;
  min-width: 0;
  gap: 9px;
  padding: 14px 9px;
  border: 1px solid transparent;
  border-left: 2px solid transparent;
  border-bottom-color: #173343b3;
  border-radius: 0 9px 9px 0;
  background: transparent;
  text-align: left;
  color: #c8e3f0;
}
.agent-history-item[aria-current='true'] {
  border-left-color: #1ed7ff;
  background: linear-gradient(90deg, #07567b80, #092f4652);
  box-shadow: inset 0 0 20px #19bce00d;
}
.agent-history-item:not(:disabled):hover {
  border-color: #23556c;
  background: #0a385080;
}
.agent-history-item > svg {
  flex-shrink: 0;
  margin-top: 2px;
  color: #8fd7ef;
}
.agent-history-summary {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: 7px;
}
.agent-history-summary strong {
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.6;
  font-weight: 550;
}
.agent-history-summary small,
.agent-history-item time {
  color: #7e9db0;
  font-size: 11px;
  line-height: 1.8;
}
.agent-history-item time {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.agent-history-empty {
  margin: 8px 4px;
  color: #87a8bc;
  font-size: 13px;
  line-height: 1.8;
}
</style>
