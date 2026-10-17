<script setup lang="ts">
import { skillDefinitionText } from '../composables/useSkills';
import { dateLabel } from '../utils/display';
const state = reactive(useSkills());
const route = useRoute();
const versionId = ref('');
const editor = ref(false);
const editorSkillId = ref<string>();
const candidate = ref('');
const localError = ref('');
const revokeOpen = ref(false);
const revokeReason = ref('');
const toolLabels: Record<string, string> = {
  query_vessels: '船舶查询',
  query_vessel_tracks: '历史航线',
  query_ais_heatmap: 'AIS 热力图',
  search_intelligence: '情报检索',
};
const artifactLabels: Record<string, string> = {
  vessel_list: '船舶清单',
  vessel_detail: '船舶详情',
  vessel_tracks: '航线快照',
  ais_heatmap: '热力快照',
  intelligence_search: '情报结果',
  analysis: '分析结果',
};
const version = computed(() =>
  state.detail?.versions.find((item) => item.binding.version === versionId.value),
);
watch(
  () => state.detail,
  (detail) => {
    const requested = typeof route.query.version === 'string' ? route.query.version : '';
    versionId.value = detail?.versions.some((item) => item.binding.version === requested)
      ? requested
      : (detail?.skill.currentVersion ?? detail?.versions[0]?.binding.version ?? '');
    revokeOpen.value = false;
    revokeReason.value = '';
  },
);
watch(
  () => state.canWrite,
  (allowed) => {
    if (!allowed) editor.value = false;
  },
);
onMounted(async () => {
  await state.load();
  if (typeof route.query.id === 'string') await state.select(route.query.id);
});
function openEditor(copy = false) {
  editorSkillId.value = copy ? state.detail?.skill.skillId : undefined;
  candidate.value =
    copy && version.value
      ? skillDefinitionText(version.value.definition)
      : JSON.stringify(
          {
            schemaVersion: 1,
            name: 'my-vessel-query',
            description: '查询当前任务范围内的船舶，形成可复核的船舶清单。',
            body: '使用任务确认的区域与筛选条件查询船舶，保留结果供后续步骤引用。',
            requiredInputs: ['region'],
            toolIds: ['query_vessels'],
            steps: [
              {
                id: 'vessels',
                toolId: 'query_vessels',
                input: { selection: { $ref: 'input.selection' } },
                artifactKind: 'vessel_list',
              },
            ],
          },
          null,
          2,
        );
  localError.value = '';
  editor.value = true;
}
async function publish() {
  let value: unknown;
  try {
    value = JSON.parse(candidate.value);
  } catch {
    localError.value = '定义需要使用有效的 JSON 格式，请检查逗号、引号与括号。';
    return;
  }
  localError.value = '';
  if (await state.publish(value, editorSkillId.value)) editor.value = false;
}
async function revoke() {
  if (!state.detail || !version.value || !revokeReason.value.trim()) return;
  if (
    await state.revoke(
      state.detail.skill.skillId,
      version.value.binding.version,
      revokeReason.value.trim(),
    )
  )
    revokeOpen.value = false;
}
useUiComponent('page.list', { read: () => uiProjection(true, [], { loading: state.busy }) });
useUiComponent('page.detail', {
  read: () => uiProjection(!!state.detail, [], { loading: state.detailBusy }),
});
useUiReadOnlyEditor(
  () => editor.value,
  () => ({ definition: candidate.value }),
  () => state.busy,
);
</script>

<template>
  <section class="page skills-page">
    <div class="page-heading">
      <div>
        <div class="eyebrow">PERSONAL SKILL LIBRARY</div>
        <h1>我的技能</h1>
        <p>将分析流程沉淀为技能，按版本复用每一步查询与海图展示。</p>
      </div>
      <div class="actions">
        <button :disabled="state.busy" @click="state.load">刷新目录</button
        ><button v-if="state.canWrite" class="skill-primary" @click="openEditor()">新建技能</button>
      </div>
    </div>
    <p v-if="!state.enabled" class="skill-status" role="status">
      动态技能发布与加载尚未启用。当前账号的目录和历史版本可继续查阅。
    </p>
    <p v-else-if="!state.canWrite" class="skill-status">当前账号拥有目录与历史版本的查看权限。</p>
    <FetchState :busy="state.busy" :error="state.error" @retry="state.load" />
    <p v-if="state.notice" class="skill-status" role="status">{{ state.notice }}</p>
    <form v-if="editor && state.canWrite" class="panel skill-editor" @submit.prevent="publish">
      <div class="skill-section-title">
        <h2>{{ editorSkillId ? '发布新版本' : '创建私有技能' }}</h2>
        <span class="badge">自动校验后发布</span>
      </div>
      <p class="muted">
        定义由技能说明、授权工具和有序步骤组成。区域、船舶与时间通过任务引用传入，每次发布形成独立版本。
      </p>
      <label
        >技能定义<textarea
          v-model="candidate"
          rows="18"
          spellcheck="false"
          required
          aria-label="技能定义 JSON"
        />
      </label>
      <p v-if="localError" role="alert" class="skill-error">{{ localError }}</p>
      <div class="actions">
        <button class="skill-primary" :disabled="state.busy">校验并发布</button
        ><button type="button" @click="editor = false">取消</button>
      </div>
    </form>
    <div class="skills-grid">
      <aside class="panel skill-catalog" aria-label="我的技能目录">
        <div class="skill-section-title">
          <h2>技能目录</h2>
          <small
            >{{ state.catalog.items.length }} 项 · 修订 {{ state.catalog.catalogRevision }}</small
          >
        </div>
        <p v-if="!state.busy && !state.catalog.items.length" class="skill-empty">
          暂无私有技能。可让智能体在分析过程中创建可复用流程，或新增技能定义。
        </p>
        <button
          v-for="item in state.catalog.items"
          :key="item.skillId"
          class="skill-entry"
          :aria-pressed="state.selectedId === item.skillId"
          @click="state.select(item.skillId)"
        >
          <span class="skill-entry-heading"
            ><strong>{{ item.name }}</strong
            ><span class="badge" :class="{ 'skill-disabled': !item.enabled }">{{
              item.enabled ? '已启用' : '已停用'
            }}</span></span
          >
          <span class="skill-description">{{ item.description }}</span>
          <span class="skill-entry-meta"
            >{{ item.currentVersion || '暂无活动版本' }} ·
            {{ item.source === 'agent' ? '智能体创建' : '手动创建' }}</span
          >
        </button>
      </aside>
      <section class="panel skill-detail" aria-label="技能版本详情">
        <p v-if="state.detailBusy" role="status">正在读取技能版本…</p>
        <template v-else-if="state.detail">
          <div class="skill-section-title">
            <div>
              <div class="eyebrow">PRIVATE SKILL</div>
              <h2>{{ state.detail.skill.name }}</h2>
            </div>
            <button
              v-if="state.canWrite"
              :disabled="state.busy"
              @click="state.setEnabled(state.detail.skill.skillId, !state.detail.skill.enabled)"
            >
              {{ state.detail.skill.enabled ? '停用技能' : '启用技能' }}
            </button>
          </div>
          <p>{{ state.detail.skill.description }}</p>
          <div class="skill-version-picker">
            <label
              >历史版本<select v-model="versionId">
                <option
                  v-for="item in state.detail.versions"
                  :key="item.binding.version"
                  :value="item.binding.version"
                >
                  {{ item.binding.version
                  }}{{
                    item.revokedAt
                      ? ' · 已撤销'
                      : item.binding.version === state.detail.skill.currentVersion
                        ? ' · 当前活动'
                        : ''
                  }}
                </option>
              </select></label
            ><span class="muted">更新于 {{ dateLabel(state.detail.skill.updatedAt) }}</span>
          </div>
          <template v-if="version">
            <div class="skill-version-meta">
              <span class="badge">{{ version.source === 'agent' ? '智能体创建' : '手动创建' }}</span
              ><span>{{ dateLabel(version.createdAt) }}</span
              ><span v-if="version.revokedAt" class="skill-error"
                >已撤销 · {{ dateLabel(version.revokedAt) }}</span
              >
            </div>
            <h3>技能说明</h3>
            <p class="skill-body">{{ version.definition.body }}</p>
            <div class="skill-tags">
              <span
                v-for="tool in version.definition.toolIds"
                :key="tool"
                class="badge"
                :title="tool"
                >{{ toolLabels[tool] ?? tool }}</span
              >
            </div>
            <h3>执行步骤</h3>
            <ol class="skill-steps">
              <li v-for="step in version.definition.steps" :key="step.id">
                <strong>{{ toolLabels[step.toolId] ?? step.toolId }}</strong
                ><span>步骤 {{ step.id }}</span
                ><small
                  >{{ artifactLabels[step.artifactKind ?? ''] || '工具结果'
                  }}{{ step.ui ? ' · 海图展示' : '' }}</small
                >
              </li>
            </ol>
            <details>
              <summary>完整定义与内容摘要</summary>
              <p class="skill-hash">SHA-256 {{ version.binding.contentHash }}</p>
              <pre>{{ skillDefinitionText(version.definition) }}</pre>
            </details>
            <div v-if="state.canWrite" class="actions skill-version-actions">
              <button :disabled="state.busy" @click="openEditor(true)">以此版本编辑</button
              ><button
                v-if="
                  !version.revokedAt &&
                  version.binding.version !== state.detail.skill.currentVersion
                "
                :disabled="state.busy"
                @click="state.activate(state.detail.skill.skillId, version.binding.version)"
              >
                设为活动版本</button
              ><button
                v-if="!version.revokedAt"
                :disabled="state.busy"
                @click="revokeOpen = !revokeOpen"
              >
                撤销此版本
              </button>
            </div>
            <form
              v-if="revokeOpen && state.canWrite && !version.revokedAt"
              class="skill-revoke"
              @submit.prevent="revoke"
            >
              <label>撤销原因<input v-model="revokeReason" required maxlength="500" /></label>
              <p class="muted">撤销后此版本保留在历史记录中，后续加载按目录状态校验。</p>
              <div class="actions">
                <button :disabled="state.busy || !revokeReason.trim()">确认撤销</button
                ><button type="button" @click="revokeOpen = false">取消</button>
              </div>
            </form>
          </template>
        </template>
        <div v-else class="skill-empty">
          <h2>查看流程与版本</h2>
          <p>从左侧选择技能，查阅执行步骤、历史版本与内容摘要。</p>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.skills-page {
  max-width: 1600px;
  margin: 0 auto;
}
.skills-grid {
  display: grid;
  grid-template-columns: minmax(270px, 0.8fr) minmax(0, 1.7fr);
  gap: 18px;
  align-items: start;
}
.skill-section-title,
.skill-entry-heading,
.skill-version-meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.skill-section-title {
  margin-bottom: 18px;
}
.skill-section-title small,
.skill-entry-meta,
.skill-version-meta {
  color: var(--muted);
  font-size: 12px;
}
.skill-entry {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  text-align: left;
  margin-top: 10px;
  padding: 16px;
  border-radius: 6px;
}
.skill-entry[aria-pressed='true'] {
  border-color: var(--teal);
  background: rgb(36 204 242 / 9%);
}
.skill-entry-heading {
  width: 100%;
}
.skill-description {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.7;
}
.skill-disabled {
  opacity: 0.65;
}
.skill-primary {
  background: rgb(36 204 242 / 15%);
  border-color: var(--teal);
}
.skill-status {
  padding: 12px 16px;
  border: 1px solid var(--line);
  border-left: 3px solid var(--teal);
  margin-bottom: 18px;
  font-size: 13px;
}
.skill-empty {
  display: grid;
  gap: 14px;
  padding: 28px 8px;
  color: var(--muted);
  line-height: 1.8;
}
.skill-detail {
  display: grid;
  gap: 18px;
  min-height: 360px;
}
.skill-detail .skill-section-title {
  margin-bottom: 0;
}
.skill-version-picker {
  display: flex;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: 16px;
}
.skill-version-picker label {
  min-width: 180px;
}
.skill-version-meta {
  justify-content: flex-start;
  flex-wrap: wrap;
}
.skill-body {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.8;
}
.skill-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.skill-steps {
  margin: 0;
  padding-left: 24px;
}
.skill-steps li {
  padding: 10px 0 10px 6px;
  border-bottom: 1px solid var(--line);
}
.skill-steps strong,
.skill-steps span,
.skill-steps small {
  margin-right: 12px;
}
.skill-steps small {
  color: var(--muted);
}
.skill-detail pre {
  padding: 16px;
  background: rgb(0 0 0 / 15%);
  max-height: 440px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
}
.skill-hash {
  overflow-wrap: anywhere;
  font-size: 11px;
  margin-top: 12px;
  color: var(--muted);
}
.skill-editor,
.skill-revoke {
  display: grid;
  gap: 16px;
  margin-bottom: 20px;
}
.skill-editor textarea {
  width: 100%;
}
.skill-error {
  color: #ffb7a1;
}
.skill-revoke {
  padding: 16px;
  border: 1px solid var(--line);
}
@media (max-width: 900px) {
  .skills-grid {
    grid-template-columns: 1fr;
  }
  .skill-entry-heading {
    flex-wrap: wrap;
  }
}
@media (max-width: 600px) {
  .page-heading {
    flex-direction: column;
    align-items: flex-start;
    gap: 16px;
  }
  .page-heading button {
    white-space: nowrap;
  }
}
</style>
