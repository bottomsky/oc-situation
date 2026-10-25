<script setup lang="ts">
import { chartDetailPosition } from '../utils/chartDetailPosition';
defineOptions({ inheritAttrs: false });

const props = defineProps<{
  open: boolean;
  side: 'left' | 'right';
  fadeTo?: 'left' | 'right';
  title: string;
  subtitle?: string;
  ariaLabel?: string;
  anchorId?: string;
  width?: number;
  motion?: 'slide-left';
  closeLabel?: string;
  layer?: number;
}>();
const emit = defineEmits<{ close: [] }>();
const panel = useTemplateRef<HTMLElement>('panel');
const teleportTarget = ref<HTMLElement | null>(null);
const position = ref({ left: 12, top: 80, width: 420, height: 500 });
const positioned = ref(false);
const style = computed(() => ({
  ...Object.fromEntries(Object.entries(position.value).map(([key, value]) => [key, `${value}px`])),
  ...(props.layer ? { zIndex: props.layer } : {}),
}));
let observer: ResizeObserver | undefined;
let returnFocus: HTMLElement | null = null;
let frame: number | undefined;

function measure() {
  frame = undefined;
  const workspace = document.querySelector<HTMLElement>('[data-testid="chart-workspace"]');
  if (!workspace) return;
  const fullscreen = document.fullscreenElement as HTMLElement | null;
  teleportTarget.value = fullscreen ?? workspace;
  const bounds = (fullscreen ?? workspace).getBoundingClientRect();
  const slot = document.getElementById(props.anchorId ?? `chart-${props.side}-slot`);
  const anchor = slot?.querySelector<HTMLElement>(`.chart-${props.side}`) ?? slot;
  position.value = chartDetailPosition(
    props.side,
    bounds,
    !fullscreen && anchor?.getClientRects().length ? anchor.getBoundingClientRect() : null,
    window.innerWidth,
    window.innerHeight,
    props.width,
  );
  positioned.value = true;
}
function schedule() {
  if (frame === undefined) frame = requestAnimationFrame(measure);
}
function close() {
  emit('close');
}
function keydown(event: KeyboardEvent) {
  if (
    !props.open ||
    event.defaultPrevented ||
    event.key !== 'Escape' ||
    document.querySelector('dialog:modal')
  )
    return;
  event.preventDefault();
  event.stopPropagation();
  close();
}
function observe() {
  observer?.disconnect();
  const workspace = document.querySelector<HTMLElement>('[data-testid="chart-workspace"]');
  if (workspace) observer?.observe(workspace);
  for (const target of document.querySelectorAll<HTMLElement>(
    '.chart-left, .chart-right, .chart-center',
  ))
    observer?.observe(target);
}
function isVisible(element: HTMLElement | null): element is HTMLElement {
  return (
    !!element?.isConnected &&
    !!element.getClientRects().length &&
    getComputedStyle(element).visibility !== 'hidden'
  );
}
function restoreFocus() {
  if (isVisible(returnFocus)) {
    returnFocus.focus({ preventScroll: true });
    return;
  }
  const slot = document.getElementById(props.anchorId ?? `chart-${props.side}-slot`);
  const taskTrigger =
    slot?.querySelector<HTMLElement>('.agent-task-select[aria-pressed="true"]') ?? null;
  if (isVisible(taskTrigger)) {
    taskTrigger.focus({ preventScroll: true });
    return;
  }
  const selectedTab =
    slot?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? null;
  if (isVisible(selectedTab)) selectedTab.focus({ preventScroll: true });
  else {
    const fallback = slot?.querySelector<HTMLElement>(`.chart-${props.side}`) ?? null;
    if (isVisible(fallback)) {
      fallback.tabIndex = -1;
      fallback.focus({ preventScroll: true });
    }
  }
}
async function focusOpenedPanel() {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  await nextTick();
  if (!props.open) return;
  measure();
  observe();
  await nextTick();
  if (props.open)
    panel.value
      ?.querySelector<HTMLButtonElement>('.chart-detail-close')
      ?.focus({ preventScroll: true });
}
watch(
  () => props.open,
  async (open, previous) => {
    if (open) {
      await focusOpenedPanel();
    } else if (previous) {
      const activeInside = panel.value?.contains(document.activeElement);
      if (activeInside) restoreFocus();
    }
  },
);
watch(() => [props.side, props.width], schedule);
onMounted(() => {
  observer = new ResizeObserver(schedule);
  observe();
  measure();
  if (props.open) void focusOpenedPanel();
  document.addEventListener('keydown', keydown);
  document.addEventListener('fullscreenchange', schedule);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('fullscreenchange', schedule);
  window.removeEventListener('resize', schedule);
  window.removeEventListener('scroll', schedule, true);
});
</script>

<template>
  <Teleport v-if="teleportTarget" :to="teleportTarget">
    <Transition name="chart-detail-slide-left" :css="motion === 'slide-left'">
      <aside
        v-show="open && positioned"
        ref="panel"
        v-bind="$attrs"
        class="chart-detail-float"
        :style="style"
        :aria-label="ariaLabel ?? title"
        :inert="!open"
        :aria-hidden="!open ? 'true' : undefined"
        :data-side="side"
        :data-fade-to="fadeTo ?? 'right'"
        data-testid="chart-detail-float"
        role="dialog"
        aria-modal="false"
        @keydown="keydown"
        @wheel.stop
      >
        <header class="chart-detail-heading">
          <div class="chart-detail-heading-copy">
            <h2>{{ title }}</h2>
            <small v-if="subtitle">{{ subtitle }}</small>
          </div>
          <button
            type="button"
            class="chart-detail-close"
            :aria-label="closeLabel ?? '关闭详情'"
            @click="close"
          >
            <ChartIcon name="X" :size="16" />
          </button>
        </header>
        <div class="chart-detail-scroll" tabindex="0"><slot /></div>
      </aside>
    </Transition>
  </Teleport>
</template>

<style scoped>
.chart-detail-slide-left-enter-active,
.chart-detail-slide-left-leave-active {
  transition:
    transform 180ms ease-out,
    opacity 180ms ease-out;
}
.chart-detail-slide-left-enter-from,
.chart-detail-slide-left-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
.chart-detail-slide-left-leave-active {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .chart-detail-slide-left-enter-active,
  .chart-detail-slide-left-leave-active {
    transition: none;
  }
}
</style>
