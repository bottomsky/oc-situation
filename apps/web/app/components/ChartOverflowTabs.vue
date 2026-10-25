<script setup lang="ts">
import { partitionChartTabs } from '../utils/chartOverflowTabs';

const tabs = [
  { id: 'situation', name: '海洋态势' },
  { id: 'search', name: '船舶搜索' },
  { id: 'prediction', name: '航行预测' },
  { id: 'intelligence', name: '情报标绘' },
  { id: 'layers', name: '图层控制' },
  { id: 'playback', name: '时间回放' },
  { id: 'history-tracks', name: '历史航线' },
  { id: 'heatmap', name: 'AIS 热力图' },
] as const;
type TabId = (typeof tabs)[number]['id'];
const selected = defineModel<TabId>({ required: true });
const root = useTemplateRef<HTMLElement>('root');
const measurements = useTemplateRef<HTMLElement>('measurements');
const menuOpen = ref(false);
const ready = ref(false);
const sizes = ref({ width: 0, gap: 4, widths: tabs.map(() => 0) });
const partition = computed(() =>
  partitionChartTabs(
    tabs.map((tab, index) => ({ id: tab.id, width: sizes.value.widths[index]! })),
    selected.value,
    sizes.value.width,
    sizes.value.gap,
    32,
  ),
);
const visibleTabs = computed(() => tabs.filter((tab) => partition.value.visible.includes(tab.id)));
const menuItems = computed(() =>
  tabs
    .filter((tab) => partition.value.overflow.includes(tab.id))
    .map((tab) => ({
      label: tab.name,
      onSelect: () => selectTab(tab.id),
    })),
);
let focusSelectedOnClose = false;
let focusTriggerOnClose = false;
let menuGeneration = 0;
let observer: ResizeObserver | undefined;
let frame: number | undefined;
let stopped = false;

function focusSelected() {
  root.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus();
}
function selectTab(id: TabId) {
  const fromMenu = menuOpen.value;
  focusSelectedOnClose = fromMenu;
  selected.value = id;
  menuOpen.value = false;
  if (!fromMenu) void nextTick(focusSelected);
}
function closeAutoFocus(event: Event) {
  // Presence retains the menu through its exit animation. Restore focus after that
  // scope unmounts so a keyboard reopen receives a fresh menu entry focus.
  event.preventDefault();
  const focus = focusSelectedOnClose
    ? focusSelected
    : focusTriggerOnClose
      ? focusTrigger
      : undefined;
  const generation = menuGeneration;
  focusSelectedOnClose = false;
  focusTriggerOnClose = false;
  if (menuOpen.value || !focus) return;
  void nextTick(() => {
    if (!menuOpen.value && menuGeneration === generation) focus();
  });
}
function focusTrigger() {
  root.value?.querySelector<HTMLButtonElement>('.chart-function-more')?.focus();
}
function onEscapeKeyDown() {
  focusSelectedOnClose = false;
  focusTriggerOnClose = true;
  menuOpen.value = false;
}
function onTabKeydown(event: KeyboardEvent, id: TabId) {
  const list = visibleTabs.value;
  const index = list.findIndex((tab) => tab.id === id);
  let target: (typeof list)[number] | undefined;
  if (event.key === 'ArrowRight') target = list[(index + 1) % list.length];
  else if (event.key === 'ArrowLeft') target = list[(index + list.length - 1) % list.length];
  else if (event.key === 'Home') target = list[0];
  else if (event.key === 'End') target = list.at(-1);
  if (!target) return;
  event.preventDefault();
  selectTab(target.id);
}
function measure() {
  if (stopped || !root.value || !measurements.value) return;
  const style = getComputedStyle(root.value);
  const width = Math.max(
    0,
    root.value.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
  );
  const widths = Array.from(
    measurements.value.children,
    (element) => element.getBoundingClientRect().width,
  );
  const gap = parseFloat(style.columnGap) || 0;
  if (
    width !== sizes.value.width ||
    gap !== sizes.value.gap ||
    widths.some((value, index) => value !== sizes.value.widths[index])
  ) {
    menuOpen.value = false;
    sizes.value = { width, gap, widths };
  }
  ready.value = width > 0 && widths.every((value) => value > 0);
}
function schedule() {
  if (stopped || frame !== undefined) return;
  frame = requestAnimationFrame(() => {
    frame = undefined;
    measure();
  });
}
function onLayoutChange() {
  menuOpen.value = false;
  schedule();
}
watch(selected, () => {
  menuOpen.value = false;
});
watch(
  menuOpen,
  (open) => {
    if (open) {
      menuGeneration++;
      focusSelectedOnClose = false;
      focusTriggerOnClose = false;
    }
  },
  { flush: 'sync' },
);
onMounted(() => {
  observer = new ResizeObserver(schedule);
  if (root.value) observer.observe(root.value);
  if (measurements.value) {
    observer.observe(measurements.value);
    for (const element of measurements.value.children) observer.observe(element);
  }
  window.addEventListener('resize', onLayoutChange);
  document.fonts.addEventListener('loadingdone', onLayoutChange);
  void document.fonts.ready.then(schedule);
  measure();
});
onBeforeUnmount(() => {
  stopped = true;
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  window.removeEventListener('resize', onLayoutChange);
  document.fonts.removeEventListener('loadingdone', onLayoutChange);
});
</script>

<template>
  <div
    ref="root"
    class="chart-tabs chart-overflow-tabs"
    role="tablist"
    aria-label="操作面板功能"
    data-testid="chart-function-tabs"
    :data-ready="ready"
  >
    <button
      v-for="tab in visibleTabs"
      :key="tab.id"
      type="button"
      class="chart-function-tab"
      role="tab"
      :aria-selected="selected === tab.id"
      :tabindex="selected === tab.id ? 0 : -1"
      @click="selectTab(tab.id)"
      @keydown="onTabKeydown($event, tab.id)"
    >
      {{ tab.name }}
    </button>
    <UDropdownMenu
      v-if="menuItems.length && ready"
      v-model:open="menuOpen"
      :items="menuItems"
      :modal="false"
      :portal="true"
      :content="{
        side: 'bottom',
        align: 'end',
        sideOffset: 4,
        collisionPadding: 8,
        avoidCollisions: false,
        onEscapeKeyDown,
        onCloseAutoFocus: closeAutoFocus,
      }"
      :ui="{
        content: 'chart-function-menu min-w-36',
        viewport: 'min-h-0 p-0',
        group: 'p-0',
        item: 'cursor-pointer',
      }"
    >
      <button type="button" class="chart-function-more" aria-label="更多功能" title="更多功能">
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <path
            d="m5 7.5 5 5 5-5"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </UDropdownMenu>
    <div ref="measurements" class="chart-function-measurements" aria-hidden="true" inert>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="chart-function-tab"
        tabindex="-1"
      >
        {{ tab.name }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.chart-overflow-tabs {
  position: relative;
  min-width: 0;
  align-items: stretch;
  flex-wrap: nowrap;
}
.chart-overflow-tabs .chart-function-tab {
  flex: 0 0 auto;
  min-width: max-content;
  padding: 9px 8px;
  white-space: nowrap;
}
.chart-overflow-tabs .chart-function-more {
  flex: 0 0 32px;
  width: 32px;
  min-width: 32px;
  margin-left: auto;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.chart-function-more[data-state='open'] {
  border-color: #28c6f2;
  color: #e6f8ff;
}
.chart-function-measurements {
  position: absolute;
  width: max-content;
  display: flex;
  visibility: hidden;
  pointer-events: none;
  top: 0;
  left: 0;
}
:global(.chart-function-menu) {
  max-height: var(--reka-dropdown-menu-content-available-height);
  overflow: hidden;
  z-index: 80;
  background: #082438;
  color: #dceef7;
  border: 1px solid #28617b;
  box-shadow: 0 8px 24px #0008;
  scrollbar-width: thin;
  color-scheme: dark;
}
:global(.chart-function-menu [data-slot='item']) {
  background: #082438;
  color: #dceef7;
  border-color: transparent;
  padding: 8px 12px;
  font-size: 12px;
  line-height: 1.5;
}
:global(.chart-function-menu [data-slot='item']::before) {
  background: transparent;
}
:global(.chart-function-menu [data-slot='item']:hover),
:global(.chart-function-menu [data-slot='item'][data-highlighted]),
:global(.chart-function-menu [data-slot='item']:focus-visible) {
  background: #125b86;
  color: #e6f8ff;
  border-color: #28c6f2;
}
:global(.chart-function-menu [data-slot='item']:focus-visible) {
  outline: 2px solid #28c6f2;
  outline-offset: -2px;
}
</style>
