<script setup lang="ts">
import { AgentMemoryValueSchema } from '../../../../packages/contracts/agent-memory';
import { useAgentMemories, type AgentMemoryEntryView } from '../composables/useAgentMemories';
import { dateLabel } from '../utils/display';

const state = reactive(useAgentMemories());
const { session } = usePlatform();
const search = ref('');
const tab = ref<'active' | 'proposed'>('active');
const editor = ref(false);
const editingId = ref<string>();
const category = ref('偏好');
const key = ref('');
const value = ref('');
const confirmation = ref<{ kind: 'delete' | 'clear'; id?: string; label: string } | null>(null);
const filtered = computed(() =>
  state.catalog.entries.filter(
    (entry) =>
      entry.status === tab.value &&
      `${entry.category} ${entry.key} ${textValue(entry.value)}`
        .toLocaleLowerCase()
        .includes(search.value.trim().toLocaleLowerCase()),
  ),
);
const activeCount = computed(
  () => state.catalog.entries.filter((entry) => entry.status === 'active').length,
);
const proposedCount = computed(
  () => state.catalog.entries.filter((entry) => entry.status === 'proposed').length,
);
const enabled = computed(() => state.settings?.features.account !== false);
watch(
  () => session.value?.user.id,
  () => {
    editor.value = false;
    key.value = '';
    value.value = '';
    editingId.value = undefined;
    confirmation.value = null;
    search.value = '';
  },
  { flush: 'sync' },
);
onMounted(state.load);
function textValue(input: unknown) {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}
function edit(entry?: AgentMemoryEntryView) {
  editingId.value = entry?.id;
  category.value = entry?.category ?? '偏好';
  key.value = entry?.key ?? '';
  value.value = entry ? textValue(entry.value) : '';
  editor.value = true;
}
async function save() {
  if (!key.value.trim() || !value.value.trim() || !category.value.trim()) return;
  // Text fields are saved as text; existing structured values remain structured when edited.
  const existing = state.catalog.entries.find((entry) => entry.id === editingId.value);
  let nextValue: unknown = value.value.trim();
  if (existing && typeof existing.value !== 'string') {
    try {
      nextValue = JSON.parse(value.value);
    } catch {
      state.error = '该记录使用结构化内容，请输入有效的 JSON。';
      return;
    }
  }
  if (!AgentMemoryValueSchema.safeParse(nextValue).success) {
    state.error = '记忆内容超出保存范围，请精简至 16 KiB 以内。';
    return;
  }
  if (
    await state.save(
      { category: category.value.trim(), key: key.value.trim(), value: nextValue },
      editingId.value,
    )
  )
    editor.value = false;
}
async function confirmRemoval() {
  const pending = confirmation.value;
  if (!pending) return;
  const success =
    pending.kind === 'clear' ? await state.clear() : await state.act(pending.id!, 'delete');
  if (success) confirmation.value = null;
}
</script>

<template>
  <section class="page memory-page" aria-label="我的记忆">
    <div class="page-heading">
      <div>
        <div class="eyebrow">PERSONAL MEMORY</div>
        <h1>我的记忆</h1>
        <p>管理研判助手为当前账号保留的偏好与事实，逐条确认每次沉淀。</p>
      </div>
      <div class="actions">
        <button :disabled="state.busy" @click="state.load">刷新</button
        ><button
          class="memory-primary"
          :disabled="state.busy || !state.settings || !enabled"
          @click="edit()"
        >
          新建记忆
        </button>
      </div>
    </div>
    <FetchState :busy="state.busy" :error="state.error" @retry="state.load" />
    <p v-if="state.notice" class="memory-notice" role="status">{{ state.notice }}</p>
    <div v-if="state.settings" class="panel memory-settings">
      <div>
        <h2>使用与提取</h2>
        <p class="muted">正式记忆在后续研判中按需采用；自动提取的内容先进入候选。</p>
      </div>
      <label
        ><input
          type="checkbox"
          :checked="state.settings.readEnabled"
          :disabled="state.busy"
          @change="
            state.updateSettings(
              ($event.target as HTMLInputElement).checked,
              state.settings.proposalsEnabled,
            )
          "
        />采用账号记忆</label
      >
      <label
        ><input
          type="checkbox"
          :checked="state.settings.proposalsEnabled"
          :disabled="state.busy"
          @change="
            state.updateSettings(
              state.settings.readEnabled,
              ($event.target as HTMLInputElement).checked,
            )
          "
        />自动提取候选</label
      >
      <p v-if="!enabled || !state.settings.features.proposals" class="memory-system" role="status">
        {{
          !enabled
            ? '系统已暂停账号记忆使用，现有记录可继续查看、删除和清空。'
            : '系统已暂停自动候选提取，仍可手动维护个人记忆。'
        }}
      </p>
    </div>
    <form v-if="editor" class="panel memory-editor" @submit.prevent="save">
      <div class="memory-section-title">
        <h2>{{ editingId ? '编辑记忆' : '新建记忆' }}</h2>
        <button type="button" :disabled="state.busy" @click="editor = false">取消</button>
      </div>
      <div class="memory-fields">
        <label>分类<input v-model="category" required maxlength="100" /></label
        ><label
          >名称<input v-model="key" required maxlength="200" placeholder="例如：研判报告语言"
        /></label>
      </div>
      <label
        >内容<textarea
          v-model="value"
          required
          rows="4"
          maxlength="12000"
          placeholder="例如：使用中文，保留船舶 MMSI 和查询时间。"
        />
      </label>
      <div class="actions">
        <button class="memory-primary" :disabled="state.busy || !enabled">保存记忆</button>
      </div>
    </form>
    <div class="memory-toolbar">
      <div class="memory-tabs" role="tablist" aria-label="记忆状态">
        <button role="tab" :aria-selected="tab === 'active'" @click="tab = 'active'">
          正式记忆 <span>{{ activeCount }}</span></button
        ><button role="tab" :aria-selected="tab === 'proposed'" @click="tab = 'proposed'">
          待确认候选 <span>{{ proposedCount }}</span>
        </button>
      </div>
      <input
        v-model="search"
        type="search"
        aria-label="检索我的记忆"
        placeholder="检索名称、内容或分类"
      />
      <button
        class="memory-danger"
        :disabled="state.busy || !state.catalog.entries.length"
        @click="confirmation = { kind: 'clear', label: '全部正式记忆与候选' }"
      >
        清空全部
      </button>
    </div>
    <div
      v-if="confirmation"
      class="panel memory-confirm"
      role="alertdialog"
      aria-label="确认遗忘记忆"
    >
      <p>确定遗忘{{ confirmation.label }}？确认后会清除记录正文，后续研判将停止采用。</p>
      <div class="actions">
        <button :disabled="state.busy" @click="confirmation = null">取消</button
        ><button class="memory-danger" :disabled="state.busy" @click="confirmRemoval">
          确认遗忘
        </button>
      </div>
    </div>
    <p v-if="!state.busy && !filtered.length" class="panel memory-empty">
      {{
        search
          ? '没有匹配的记忆，请调整检索词。'
          : tab === 'proposed'
            ? '暂无待确认候选。助手提出的候选会出现在这里。'
            : '暂无正式记忆。添加常用偏好，或前往候选逐条确认。'
      }}
    </p>
    <div
      class="memory-list"
      role="tabpanel"
      :aria-label="tab === 'active' ? '正式记忆' : '待确认候选'"
    >
      <article
        v-for="entry in filtered"
        :key="entry.id"
        class="panel memory-entry"
        :data-memory-id="entry.id"
      >
        <div class="memory-entry-head">
          <span class="badge">{{ entry.category }}</span
          ><span class="muted">{{ dateLabel(entry.updatedAt) }}</span>
        </div>
        <h2>{{ entry.key }}</h2>
        <pre>{{ textValue(entry.value) }}</pre>
        <div class="memory-source">
          <span
            >来源：{{
              entry.source.description || (entry.source.taskId ? '会话研判' : '账号记忆')
            }}</span
          ><span v-if="entry.source.taskId" :title="entry.source.taskId"
            >任务 {{ entry.source.taskId.slice(0, 8) }}</span
          ><span v-if="entry.expiresAt">有效期至 {{ dateLabel(entry.expiresAt) }}</span>
        </div>
        <div class="actions">
          <template v-if="entry.status === 'proposed'"
            ><button
              class="memory-primary"
              :disabled="state.busy || !enabled"
              @click="state.act(entry.id, 'confirm')"
            >
              确认记住</button
            ><button :disabled="state.busy" @click="state.act(entry.id, 'dismiss')">
              拒绝候选
            </button></template
          ><button :disabled="state.busy || !enabled" @click="edit(entry)">编辑</button
          ><button
            class="memory-danger"
            :disabled="state.busy"
            @click="confirmation = { kind: 'delete', id: entry.id, label: `「${entry.key}」` }"
          >
            遗忘
          </button>
        </div>
      </article>
    </div>
  </section>
</template>

<style scoped>
.memory-page {
  max-width: 1380px;
  margin: 0 auto;
}
.memory-page > * + * {
  margin-top: 20px;
}
.memory-settings {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 24px;
  padding: 22px;
}
.memory-settings > div {
  flex: 1;
  min-width: 240px;
}
.memory-settings h2 {
  font-size: 16px;
  margin-bottom: 8px;
}
.memory-settings label {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}
.memory-settings input {
  accent-color: var(--teal);
}
.memory-system {
  flex-basis: 100%;
  color: #f0cc87;
  font-size: 13px;
}
.memory-editor {
  padding: 22px;
  display: grid;
  gap: 18px;
  border-top: 2px solid var(--teal);
}
.memory-section-title,
.memory-toolbar,
.memory-entry-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.memory-fields {
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: 18px;
}
.memory-toolbar {
  flex-wrap: wrap;
}
.memory-toolbar input {
  flex: 1;
  min-width: 200px;
  max-width: 460px;
}
.memory-tabs {
  display: flex;
  border-bottom: 1px solid var(--line);
}
.memory-tabs button {
  border: 0;
  border-radius: 0;
  background: transparent;
  padding: 12px 16px;
  border-bottom: 2px solid transparent;
}
.memory-tabs [aria-selected='true'] {
  color: var(--teal);
  border-bottom-color: var(--teal);
}
.memory-tabs span {
  padding-left: 8px;
  font-size: 12px;
}
.memory-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 16px;
}
.memory-entry {
  padding: 22px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
}
.memory-entry h2 {
  font-size: 17px;
  overflow-wrap: anywhere;
}
.memory-entry pre {
  font: inherit;
  font-size: 14px;
  line-height: 1.75;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  flex: 1;
  margin: 0;
}
.memory-entry-head {
  font-size: 12px;
}
.memory-source {
  font-size: 12px;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  overflow-wrap: anywhere;
}
.memory-entry .actions {
  justify-content: flex-end;
  flex-wrap: wrap;
  border-top: 1px solid var(--line);
  padding-top: 14px;
}
.memory-primary {
  border-color: var(--teal);
  color: var(--teal);
}
.memory-danger {
  color: var(--error-text, #e99588);
}
.memory-empty {
  padding: 42px;
  color: var(--muted);
  text-align: center;
}
.memory-notice {
  color: var(--teal);
}
.memory-confirm {
  padding: 20px;
  display: grid;
  gap: 18px;
  border-color: #a5674d;
}
@media (max-width: 640px) {
  .memory-fields {
    grid-template-columns: 1fr;
  }
  .memory-list {
    grid-template-columns: 1fr;
  }
}
</style>
