<script setup lang="ts">
import type { FocusTargetRef } from '@ais/contracts';
import type { ReplyObjectViewModel } from '../types/agentReply';
import { replyObjectIcons, replyObjectLabels, replyObjectsPage } from '../utils/replyObjects';
import { dateLabel } from '../utils/display';

const props = withDefaults(
  defineProps<{
    open: boolean;
    objects: ReplyObjectViewModel[];
    omittedCount?: number;
    replyKey: string;
    selectedKey?: string;
  }>(),
  { omittedCount: 0 },
);
const emit = defineEmits<{
  close: [];
  object: [object: ReplyObjectViewModel];
  locate: [object: ReplyObjectViewModel];
  business: [object: ReplyObjectViewModel];
}>();
const query = ref('');
const kind = ref<FocusTargetRef['kind'] | 'all'>('all');
const page = ref(1);
const target = ref<HTMLElement | null>(null);
const panel = useTemplateRef<HTMLElement>('panel');
const results = computed(() =>
  replyObjectsPage(props.objects, query.value, kind.value, page.value),
);
const located = computed(() => props.objects.filter((object) => object.located).length);
const selected = computed(() => props.objects.find((object) => object.key === props.selectedKey));
const kinds = computed(() => [...new Set(props.objects.map((object) => object.ref.kind))]);
watch(
  () => [query.value, kind.value],
  () => {
    page.value = 1;
  },
);
watch(
  () => props.replyKey,
  () => {
    query.value = '';
    kind.value = 'all';
    page.value = 1;
  },
);
function destination() {
  target.value =
    (document.fullscreenElement as HTMLElement | null) ??
    document.querySelector<HTMLElement>('[data-testid="chart-workspace"]');
}
watch(
  () => props.open,
  async (open) => {
    if (!open) return;
    destination();
    await nextTick();
    panel.value
      ?.querySelector<HTMLButtonElement>('.reply-objects-close')
      ?.focus({ preventScroll: true });
  },
);
onMounted(() => {
  destination();
  document.addEventListener('fullscreenchange', destination);
  if (props.open)
    nextTick(() =>
      panel.value
        ?.querySelector<HTMLButtonElement>('.reply-objects-close')
        ?.focus({ preventScroll: true }),
    );
});
onBeforeUnmount(() => document.removeEventListener('fullscreenchange', destination));
</script>

<template>
  <Teleport v-if="target" :to="target">
    <aside
      v-show="open"
      ref="panel"
      class="chart-agent-objects-panel"
      data-testid="reply-objects-panel"
      data-chart-overlay
      data-side="right"
      role="dialog"
      aria-modal="false"
      aria-label="本次回复关联对象"
      :inert="!open"
      :aria-hidden="!open ? 'true' : undefined"
      @pointerdown.stop
      @click.stop
      @dblclick.stop
      @wheel.stop
      @keydown.stop
    >
      <header class="reply-objects-heading">
        <div>
          <span class="reply-objects-eyebrow">REPLY REFERENCES</span>
          <h2>本次回复关联对象</h2>
        </div>
        <button
          type="button"
          class="reply-objects-close"
          aria-label="关闭关联对象面板"
          @click="emit('close')"
        >
          <ChartIcon name="X" :size="18" />
        </button>
      </header>
      <div class="reply-objects-summary" role="status">
        <strong>{{ objects.length }}</strong> 已关联<span>{{ located }} 已定位</span
        ><span>{{ objects.length - located }} 未定位</span>
      </div>
      <p v-if="omittedCount" class="reply-objects-warning">
        另有 {{ omittedCount }} 项超出本次快照范围，当前列表展示本次已取得引用的对象。
      </p>
      <div class="reply-objects-filters">
        <label class="reply-object-search"
          ><ChartIcon name="Search" :size="15" /><input
            v-model="query"
            type="search"
            aria-label="搜索回复关联对象"
            placeholder="搜索名称或标识"
        /></label>
        <label class="reply-object-type"
          >类型<select v-model="kind" aria-label="筛选回复对象类型">
            <option value="all">全部类型</option>
            <option v-for="value in kinds" :key="value" :value="value">
              {{ replyObjectLabels[value] }}
            </option>
          </select></label
        >
      </div>
      <div class="reply-objects-scroll" tabindex="0" aria-label="关联对象列表">
        <section
          v-if="selected && !['vessel', 'intelligence'].includes(selected.ref.kind)"
          class="reply-object-snapshot"
          aria-label="关联对象快照概要"
        >
          <h3>{{ selected.label }}</h3>
          <p>{{ replyObjectLabels[selected.ref.kind] }} · 本次回复引用快照</p>
          <p>
            {{
              selected.located ? `关联 ${selected.geometries.length} 段几何` : '本次快照尚未定位'
            }}
          </p>
          <p v-if="selected.ref.revision !== undefined">引用版本 {{ selected.ref.revision }}</p>
          <p class="mono">{{ selected.ref.id }}</p>
          <button
            v-if="['route', 'event'].includes(selected.ref.kind)"
            type="button"
            class="reply-object-business"
            @click="emit('business', selected)"
          >
            打开{{ replyObjectLabels[selected.ref.kind] }}详情<ChartIcon
              name="ExternalLink"
              :size="13"
            />
          </button>
        </section>
        <ul class="reply-objects-list">
          <li
            v-for="object in results.items"
            :key="object.key"
            class="reply-object-row"
            :class="{ selected: object.key === selectedKey }"
            :data-object-key="object.key"
          >
            <div class="reply-object-row-heading">
              <span class="reply-object-kind"
                ><ChartIcon :name="replyObjectIcons[object.ref.kind]" :size="17" />{{
                  replyObjectLabels[object.ref.kind]
                }}</span
              ><span class="reply-object-location" :class="{ missing: !object.located }">{{
                object.located ? '已定位' : '未定位'
              }}</span>
            </div>
            <div class="reply-object-row-actions">
              <button
                type="button"
                class="reply-object-detail"
                :aria-label="`查看${replyObjectLabels[object.ref.kind]}详情：${object.label}`"
                @click="emit('object', object)"
              >
                {{ object.label }}</button
              ><button
                type="button"
                class="reply-object-locate"
                :disabled="!object.located"
                :title="object.located ? '在地图上定位此对象' : '本次快照缺少可定位几何'"
                :aria-label="`定位${object.label}`"
                @click="emit('locate', object)"
              >
                <ChartIcon name="Compass" :size="14" />定位
              </button>
            </div>
            <dl class="reply-object-meta">
              <div>
                <dt>
                  {{
                    object.ref.kind === 'vessel' || object.ref.kind === 'track' ? 'MMSI' : '标识'
                  }}
                </dt>
                <dd class="mono">{{ object.ref.id }}</dd>
              </div>
              <div v-if="object.ref.revision !== undefined">
                <dt>引用版本</dt>
                <dd>{{ object.ref.revision }}</dd>
              </div>
              <div v-if="object.observedAt">
                <dt>观测时间</dt>
                <dd>{{ dateLabel(object.observedAt) }}</dd>
              </div>
              <div v-if="object.source">
                <dt>来源</dt>
                <dd>{{ object.source }}</dd>
              </div>
              <div v-if="object.ref.sourceTaskId">
                <dt>来源任务</dt>
                <dd class="mono">{{ object.ref.sourceTaskId }}</dd>
              </div>
            </dl>
            <p v-if="!object.located" class="reply-object-unlocated">
              本次快照缺少几何，可查看业务详情。
            </p>
          </li>
        </ul>
        <p v-if="!results.total" class="reply-objects-empty">
          {{ objects.length ? '没有符合搜索和类型条件的关联对象。' : '本次回复未关联具体对象。' }}
        </p>
      </div>
      <footer class="reply-objects-pagination">
        <span>匹配 {{ results.total }} 个 · {{ results.page }} / {{ results.pages }} 页</span>
        <div>
          <button
            type="button"
            :disabled="results.page === 1"
            aria-label="关联对象上一页"
            @click="page = results.page - 1"
          >
            <ChartIcon name="ChevronLeft" :size="15" /></button
          ><button
            type="button"
            :disabled="results.page === results.pages"
            aria-label="关联对象下一页"
            @click="page = results.page + 1"
          >
            <ChartIcon name="ChevronRight" :size="15" />
          </button>
        </div>
      </footer>
    </aside>
  </Teleport>
</template>

<style scoped>
.chart-agent-objects-panel {
  --control-bg: #081f32;
  --control-line: #24516b;
  --panel-bg: #092237;
  --quote-bg: #082739;
  --code-bg: #041421;
  --hover-bg: #0d314b;
  --selection-bg: #10394f;
  position: absolute;
  inset: 8px 8px 8px auto;
  z-index: 60;
  display: flex;
  flex-direction: column;
  width: 360px;
  max-width: calc(100% - 16px);
  min-width: 0;
  min-height: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid #28647d;
  border-top-color: #59cfe5;
  border-radius: 6px;
  background: linear-gradient(155deg, #09283e, #061d30 65%);
  color: #d7edf6;
  box-shadow: -12px 0 30px rgb(0 8 20 / 25%);
  pointer-events: auto;
  color-scheme: dark;
}
.reply-objects-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 17px 17px 13px;
}
.reply-objects-eyebrow {
  color: #6c9caf;
  font-size: 9px;
  letter-spacing: 0.15em;
}
.reply-objects-heading h2 {
  margin: 5px 0 0;
  font-size: 16px;
  letter-spacing: 0.03em;
}
.reply-objects-close {
  display: grid;
  place-items: center;
  width: 29px;
  height: 29px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #97bdcc;
}
.reply-objects-summary {
  display: flex;
  align-items: baseline;
  gap: 7px;
  padding: 0 17px 14px;
  color: #8aafbf;
  font-size: 11px;
  border-bottom: 1px solid #235069;
}
.reply-objects-summary strong {
  font-size: 21px;
  font-weight: 500;
  color: #96ecf5;
  font-variant-numeric: tabular-nums;
}
.reply-objects-summary > span {
  margin-left: 8px;
}
.reply-objects-warning {
  margin: 12px 17px 0;
  padding: 9px;
  background: #614c231f;
  color: #d3ba86;
  border-left: 2px solid #937845;
  font-size: 11px;
  line-height: 1.6;
}
.reply-objects-filters {
  display: flex;
  gap: 9px;
  padding: 14px 17px;
}
.reply-object-search {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  padding: 0 9px;
  border: 1px solid #2c536b;
  border-radius: 4px;
  background: #071e30;
  color: #6a9fb2;
}
.reply-object-search input {
  width: 100%;
  min-width: 0;
  padding: 8px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: #d8edf5;
  font-size: 11px;
}
.reply-object-search:focus-within {
  border-color: #65dbea;
}
.reply-object-type {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  color: #89afbf;
}
.reply-object-type select {
  max-width: 98px;
  border: 1px solid #2c536b;
  border-radius: 4px;
  padding: 7px 5px;
  background: #071e30;
  color: #b8d8e6;
  font-size: 11px;
}
.reply-objects-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 17px 14px;
  scrollbar-width: thin;
  scrollbar-color: #2e6983 transparent;
}
.reply-objects-list {
  display: grid;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.reply-object-row {
  padding: 12px;
  border: 1px solid #22485e;
  border-radius: 4px;
  background: #0b2b402b;
}
.reply-object-row.selected {
  border-color: #3e9eb6;
  background: #15445d55;
}
.reply-object-row-heading,
.reply-object-row-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.reply-object-kind {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #6cc3d7;
  font-size: 10px;
}
.reply-object-location {
  color: #79bca9;
  font-size: 10px;
}
.reply-object-location.missing {
  color: #bda777;
}
.reply-object-row-actions {
  align-items: flex-start;
  margin-top: 8px;
}
.reply-object-detail {
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: #d4edf7;
  text-align: left;
  font-size: 13px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.reply-object-detail:hover {
  color: #80e1ee;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.reply-object-locate {
  display: flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 4px 6px;
  border: 1px solid #325d72;
  border-radius: 4px;
  background: transparent;
  color: #8dccdb;
  font-size: 10px;
}
.reply-object-locate:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.reply-object-meta {
  display: grid;
  gap: 4px;
  margin: 8px 0 0;
  font-size: 10px;
  line-height: 1.5;
}
.reply-object-meta > div {
  display: flex;
  gap: 7px;
}
.reply-object-meta dt {
  flex-shrink: 0;
  color: #6e9bae;
}
.reply-object-meta dd {
  margin: 0;
  color: #9abcca;
  overflow-wrap: anywhere;
}
.reply-object-unlocated {
  margin: 8px 0 0;
  color: #a5926c;
  font-size: 10px;
  line-height: 1.5;
}
.reply-objects-empty {
  color: #81a8ba;
  font-size: 12px;
  line-height: 1.7;
}
.reply-object-snapshot {
  margin-bottom: 13px;
  padding: 12px;
  border: 1px solid #326b81;
  border-radius: 4px;
  background: #10354c;
}
.reply-object-snapshot h3 {
  margin: 0 0 8px;
  color: #c5e8f4;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.reply-object-snapshot p {
  margin: 4px 0;
  color: #8fb7c9;
  font-size: 11px;
  overflow-wrap: anywhere;
}
.reply-object-business {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 10px;
  padding: 5px 0;
  border: 0;
  background: transparent;
  color: #83dbea;
  font-size: 11px;
}
.reply-objects-pagination {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 17px;
  border-top: 1px solid #234c62;
  color: #83adbf;
  font-size: 10px;
}
.reply-objects-pagination > div {
  display: flex;
  gap: 5px;
}
.reply-objects-pagination button {
  display: grid;
  place-items: center;
  width: 27px;
  height: 25px;
  border: 1px solid #2d5b73;
  border-radius: 3px;
  background: transparent;
  color: #83cedf;
}
.reply-objects-pagination button:disabled {
  opacity: 0.35;
}
button:focus-visible,
select:focus-visible,
.reply-objects-scroll:focus-visible {
  outline: 1px solid #63def1;
  outline-offset: 2px;
}
@media (max-width: 767px) {
  .chart-agent-objects-panel {
    width: calc(100% - 16px);
  }
}
@media (prefers-reduced-motion: no-preference) {
  .chart-agent-objects-panel {
    animation: objects-enter 160ms ease-out;
  }
}
@keyframes objects-enter {
  from {
    opacity: 0;
    transform: translateX(12px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
