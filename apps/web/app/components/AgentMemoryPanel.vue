<script setup lang="ts">
import { explainMemoryConditions, useAgentMemories } from '../composables/useAgentMemories';
const props = defineProps<{ sessionId?: string; revisionKey?: string }>();
const state = reactive(useAgentMemories());
const open = ref(false);
const resetting = ref(false);
const conditionRows = computed(() =>
  explainMemoryConditions(state.sessionMemory?.conditions ?? {}),
);
watch(
  () => [props.sessionId, props.revisionKey],
  () => {
    resetting.value = false;
    void state.loadSession(props.sessionId ?? '');
  },
  { immediate: true },
);
function valueLabel(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}
async function reset() {
  if (await state.resetSession()) resetting.value = false;
}
</script>
<template>
  <section class="agent-memory" aria-label="会话记忆与当前对象">
    <div class="memory-line">
      <button :aria-expanded="open" @click="open = !open">
        {{ open ? '收起' : '查看' }}会话记忆<span v-if="state.sessionMemory?.objectSets?.length">
          · {{ state.sessionMemory.objectSets[0]?.label }}</span
        ></button
      ><NuxtLink to="/memories">我的记忆</NuxtLink>
    </div>
    <div v-if="open" class="memory-content">
      <p v-if="state.sessionBusy" role="status">正在读取当前会话记忆…</p>
      <p v-else-if="state.sessionError" role="alert">
        {{ state.sessionError }} <button @click="state.loadSession(sessionId ?? '')">重试</button>
      </p>
      <template v-else-if="state.sessionMemory">
        <p v-if="!state.sessionMemory.features.session" class="muted">
          系统已暂停会话记忆使用，现有记录可重置。
        </p>
        <h4>当前讨论对象</h4>
        <ul v-if="state.sessionMemory.objectSets.length">
          <li v-for="set in state.sessionMemory.objectSets" :key="set.id">
            <strong>{{ set.label }}</strong> · {{ set.memberCount }} 个对象
            <small>第 {{ set.turnSeq }} 轮 · {{ set.source.description || '会话查询' }}</small>
          </li>
        </ul>
        <p v-else class="muted">当前会话尚未形成讨论对象。</p>
        <p v-if="state.sessionMemory.summary">{{ state.sessionMemory.summary }}</p>
        <dl v-if="conditionRows.length">
          <template v-for="row in conditionRows" :key="row.label"
            ><dt>{{ row.label }}</dt>
            <dd>{{ row.value }}</dd></template
          >
        </dl>
        <h4>最近一轮检索到的账号记忆</h4>
        <ul v-if="state.sessionMemory.appliedAccountMemories.length">
          <li v-for="entry in state.sessionMemory.appliedAccountMemories" :key="entry.id">
            <strong>{{ entry.key }}</strong
            >：{{ valueLabel(entry.value)
            }}<small>{{ entry.source.description || '账号记忆' }}</small>
          </li>
        </ul>
        <p v-else class="muted">最近一轮未检索到账号记忆。</p>
        <p v-if="state.error" role="alert">{{ state.error }}</p>
        <div v-if="resetting" class="memory-reset">
          <p>重置后，后续对话将重新建立讨论对象和条件。</p>
          <button :disabled="state.busy" @click="reset">确认重置</button
          ><button :disabled="state.busy" @click="resetting = false">取消</button>
        </div>
        <button v-else :disabled="state.busy || state.sessionBusy" @click="resetting = true">
          重置会话记忆
        </button>
      </template>
      <p v-else class="muted">创建会话后，可在此核对讨论对象和本轮检索到的记忆。</p>
    </div>
  </section>
</template>
<style scoped>
.agent-memory {
  margin: 8px 0 14px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: #081e2c;
  font-size: 12px;
}
.memory-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 6px 10px;
}
.memory-line button {
  border: 0;
  padding: 5px 0;
  background: transparent;
  font-size: 12px;
  text-align: left;
}
.memory-line a {
  color: var(--teal);
  white-space: nowrap;
}
.memory-line span {
  color: var(--muted);
}
.memory-content {
  border-top: 1px solid var(--line);
  padding: 12px;
  display: grid;
  gap: 10px;
  max-height: 360px;
  overflow: auto;
  overflow-wrap: anywhere;
}
h4 {
  color: var(--muted);
  font-weight: 500;
  margin: 2px 0;
}
ul {
  padding-left: 18px;
  margin: 0;
  display: grid;
  gap: 8px;
}
small {
  display: block;
  color: var(--muted);
  margin-top: 4px;
}
dl {
  display: grid;
  grid-template-columns: minmax(50px, auto) 1fr;
  gap: 6px;
  margin: 0;
}
dt {
  color: var(--muted);
}
dd {
  margin: 0;
}
.memory-reset {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.memory-reset p {
  flex-basis: 100%;
}
</style>
