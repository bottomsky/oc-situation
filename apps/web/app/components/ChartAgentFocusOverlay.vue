<script setup lang="ts">
import type { AgentFocusResult } from '../../../../packages/contracts/agent-focus';
import { focusCoordinates } from '../../../../packages/domain/agent-focus';
import { placeFocusReply, type FocusSide } from '../utils/focusLayout';
import type { ChartMapControls } from '../types/chart';
import type { CurrentAgentReply } from '../composables/useAgentConversation';
import type { MapResponse } from '@ais/contracts';
import { createLiveFocusPresentation, createFocusCameraBudget } from '../utils/liveFocus';
const props = defineProps<{
  map: ChartMapControls | null;
  reply: CurrentAgentReply;
  focus: AgentFocusResult | null;
  fleet?: MapResponse | null;
  layoutKey?: string;
}>();
const presentFocus = createLiveFocusPresentation();
const presentation = computed(() => presentFocus(props.focus, props.fleet?.items ?? []));
const cameraBudget = createFocusCameraBudget();
const emit = defineEmits<{
  close: [];
  open: [];
  reference: [reference: string, taskId: string, version: number];
  displayed: [result: AgentFocusResult, displayStatus: AgentFocusResult['displayStatus']];
  crowded: [value: boolean];
}>();
const targetCount = computed(
  () => new Set(props.focus?.targets.map((target) => `${target.ref.kind}:${target.ref.id}`)).size,
);
const root = ref<HTMLElement | null>(null),
  card = ref<HTMLElement | null>(null),
  shapes = ref<SVGGElement | null>(null),
  frame = ref<SVGPathElement | null>(null),
  guide = ref<SVGPathElement | null>(null),
  labels = ref<SVGGElement | null>(null);
const compact = ref(false),
  offscreen = ref(false),
  crowded = ref(false);
let projectionStamp = '';
let side: FocusSide | undefined,
  raf = 0,
  unsubscribe: (() => void) | undefined,
  observer: ResizeObserver | undefined;
let focusIntent: ((request: Parameters<ChartMapControls['applyCamera']>[0]) => void) | undefined;
let acknowledged = '',
  disposed = false,
  hasMapFrame = false;
function mapRendered() {
  hasMapFrame = true;
  schedule();
}
function key() {
  const f = props.focus;
  return f ? `${f.sessionId}:${f.taskId}:${f.inputRevision}:${f.version}` : '';
}
function refocus() {
  projectionStamp = '';
  cameraBudget.reset();
  focusIntent = props.map?.cameraIntent({ reserveReply: true });
  schedule();
}
function schedule() {
  if (!raf) raf = requestAnimationFrame(draw);
}
function draw() {
  raf = 0;
  if (disposed || !root.value || !card.value) return;
  const mapView = props.map?.focusViewport() ?? {
    left: 12,
    top: 12,
    right: root.value.clientWidth - 12,
    bottom: root.value.clientHeight - 100,
  };
  const view = mapView;
  const focus = props.focus;
  const stamp = JSON.stringify([
    key(),
    props.map?.cameraState(),
    props.map?.interactionState().moving,
    view,
    card.value.offsetHeight,
    hasMapFrame,
  ]);
  if (stamp === projectionStamp) return;
  projectionStamp = stamp;
  const bounds = presentation.value?.bbox;
  const anchor = bounds
    ? (bounds[0] + bounds[2] + (bounds[0] > bounds[2] ? 360 : 0)) / 2
    : undefined;
  let box: { left: number; right: number; top: number; bottom: number } | null = null;
  const commands: string[] = [];
  const circleLabels: SVGTextElement[] = [];
  if (focus && props.map)
    for (const target of presentation.value?.targets ?? []) {
      if (target.region?.kind === 'circle') {
        const point = props.map.projectFocus(target.region.center, anchor);
        if (point) {
          commands.push(`M${point.x - 10},${point.y}h20 M${point.x},${point.y - 10}v20`);
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', String(point.x + 14));
          label.setAttribute('y', String(point.y - 14));
          label.textContent = `${target.region.radiusMeters / 1000} km`;
          circleLabels.push(label);
        }
      }
      let labeled = false;
      for (const line of focusCoordinates(target.geometry)) {
        const points = line
          .map((p) => props.map!.projectFocus(p, anchor))
          .filter(
            (p): p is { x: number; y: number } =>
              !!p && Number.isFinite(p.x) && Number.isFinite(p.y),
          );
        if (!labeled && points[0] && target.region?.kind !== 'circle') {
          const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          label.setAttribute('x', String(points[0].x + 16));
          label.setAttribute('y', String(points[0].y - 12));
          label.textContent = target.label.slice(0, 40);
          const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
          title.textContent = `${target.label}${target.observedAt ? ' · 观测 ' + target.observedAt : ''}`;
          label.append(title);
          circleLabels.push(label);
          labeled = true;
        }
        for (const p of points) {
          if (!box) box = { left: p.x, right: p.x, top: p.y, bottom: p.y };
          else {
            box.left = Math.min(box.left, p.x);
            box.right = Math.max(box.right, p.x);
            box.top = Math.min(box.top, p.y);
            box.bottom = Math.max(box.bottom, p.y);
          }
        }
        if (points.length === 1) {
          const p = points[0]!;
          commands.push(
            `M${p.x - 8},${p.y}h16 M${p.x},${p.y - 8}v16 M${p.x + 12},${p.y}a12,12 0 1,0 -24,0 a12,12 0 1,0 24,0`,
          );
        } else if (points.length)
          commands.push(points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' '));
      }
    }
  labels.value?.replaceChildren(...circleLabels);
  if (shapes.value) {
    shapes.value.firstElementChild?.setAttribute('d', commands.join(' '));
  }
  const outside =
    !!box &&
    (box.left < view.left ||
      box.right > view.right ||
      box.top < view.top ||
      box.bottom > view.bottom);
  if (offscreen.value !== outside) offscreen.value = outside;
  const visibleBox =
    box &&
    box.right >= view.left &&
    box.left <= view.right &&
    box.bottom >= view.top &&
    box.top <= view.bottom
      ? box
      : null;
  const height = Math.min(320, card.value.offsetHeight || 240);
  const layout = placeFocusReply(view, visibleBox, 360, height, side);
  const blocked = layout.width < 120;
  if (crowded.value !== blocked) {
    crowded.value = blocked;
    emit('crowded', blocked);
  }
  if (compact.value !== layout.compact) compact.value = layout.compact;
  side = layout.side;
  card.value.style.transform = `translate(${layout.left}px,${layout.top}px)`;
  card.value.style.width = `${layout.width}px`;
  card.value.style.visibility = blocked ? 'hidden' : 'visible';
  const captionHeight = card.value.querySelector<HTMLElement>('.focus-caption')?.offsetHeight ?? 0;
  card.value.style.setProperty(
    '--focus-card-max-height',
    `${Math.max(0, layout.maxHeight - captionHeight)}px`,
  );
  if (frame.value) {
    let d = '';
    if (box) {
      const l = box.left - 16,
        r = box.right + 16,
        t = box.top - 16,
        b = box.bottom + 16,
        c = 12;
      d = `M${l + c},${t}H${l}V${t + c} M${r - c},${t}H${r}V${t + c} M${l},${b - c}V${b}H${l + c} M${r - c},${b}H${r}V${b - c}`;
    }
    frame.value.setAttribute('d', d);
  }
  if (guide.value) {
    let d = '';
    if (visibleBox && !layout.compact) {
      const x =
          layout.side === 'right'
            ? visibleBox.right + 16
            : layout.side === 'left'
              ? visibleBox.left - 16
              : (visibleBox.left + visibleBox.right) / 2,
        y =
          layout.side === 'top'
            ? visibleBox.top - 16
            : layout.side === 'bottom'
              ? visibleBox.bottom + 16
              : (visibleBox.top + visibleBox.bottom) / 2;
      const cx = Math.max(layout.left, Math.min(x, layout.left + layout.width)),
        cy = Math.max(layout.top, Math.min(y, layout.top + height));
      d = `M${x},${y}L${(x + cx) / 2},${y}L${cx},${cy}`;
    }
    guide.value.setAttribute('d', d);
  }
  if (focus && hasMapFrame && props.map?.interactionState().ready) {
    const k = key();
    if (!blocked && focus.targets.length && cameraBudget.take()) {
      if (
        focus.targets.length &&
        (outside || (!layout.side && !layout.compact)) &&
        !props.map.interactionState().drawing &&
        bounds
      ) {
        focusIntent?.({ mode: 'bounds', bbox: bounds, maxZoom: 10 });
        projectionStamp = '';
        props.map.requestFocusRender();
        return;
      }
    }
    const actualStatus = !focus.targets.length
      ? 'unlocated'
      : outside || blocked
        ? 'partial'
        : focus.displayStatus;
    const receiptKey = `${k}:${actualStatus}`;
    if (!props.map.interactionState().moving && acknowledged !== receiptKey) {
      acknowledged = receiptKey;
      requestAnimationFrame(() => {
        if (!disposed && key() === k) emit('displayed', focus, actualStatus);
      });
    }
  }
}
watch(
  () => props.map,
  (map) => {
    unsubscribe?.();
    unsubscribe = map?.onFocusRender(mapRendered);
    focusIntent = map?.cameraIntent({ reserveReply: true });
    map?.requestFocusRender();
    schedule();
  },
  { flush: 'post' },
);
watch(
  presentation,
  () => {
    projectionStamp = '';
    hasMapFrame = false;
    props.map?.requestFocusRender();
    schedule();
  },
  { flush: 'post' },
);
watch(
  () => props.layoutKey,
  () => {
    projectionStamp = '';
    props.map?.requestFocusRender();
    schedule();
  },
  { flush: 'post' },
);
watch(
  () => props.focus,
  () => {
    projectionStamp = '';
    side = undefined;
    acknowledged = '';
    hasMapFrame = false;
    props.map?.requestFocusRender();
    schedule();
  },
  { flush: 'post' },
);
onMounted(() => {
  unsubscribe = props.map?.onFocusRender(mapRendered);
  focusIntent = props.map?.cameraIntent({ reserveReply: true });
  observer = new ResizeObserver(schedule);
  if (root.value) observer.observe(root.value);
  if (card.value) observer.observe(card.value);
  props.map?.requestFocusRender();
  schedule();
});
onBeforeUnmount(() => {
  disposed = true;
  emit('crowded', false);
  unsubscribe?.();
  observer?.disconnect();
  cancelAnimationFrame(raf);
});
</script>
<template>
  <div ref="root" class="chart-focus-overlay" data-testid="chart-focus-overlay">
    <svg class="focus-svg" aria-hidden="true">
      <g ref="shapes" class="focus-shapes"><path /></g>
      <path ref="frame" class="focus-frame" />
      <path ref="guide" class="focus-guide" />
      <g ref="labels" class="focus-labels" />
    </svg>
    <div ref="card" class="focus-reply-position">
      <div v-if="focus" class="focus-caption" role="status">
        {{ targetCount }} 个关注对象<span v-if="focus.missing.length">
          · {{ focus.missing.length }} 个未定位</span
        ><span v-if="focus.omittedCount"> · {{ focus.omittedCount }} 项超出展示上限</span
        ><span v-if="offscreen"> · 部分对象位于视野外</span
        ><button v-if="offscreen" type="button" @click="refocus">重新聚焦</button>
      </div>
      <ul v-if="focus" class="focus-details">
        <li
          v-for="(target, index) in presentation?.targets"
          :key="`${target.ref.kind}:${target.ref.id}:${index}`"
        >
          {{ target.label
          }}<template v-if="target.observedAt"> · 观测时间 {{ target.observedAt }}</template>
        </li>
      </ul>
      <ChartAgentReplyCard
        :reply="reply"
        :compact="compact"
        @close="emit('close')"
        @open="emit('open')"
        @reference="(r, t, v) => emit('reference', r, t, v)"
      />
    </div>
  </div>
</template>
<style scoped>
.focus-labels {
  fill: #9cefff;
  font-size: 12px;
}
.focus-details {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
.chart-focus-overlay {
  position: absolute;
  inset: 0;
  z-index: 35;
  pointer-events: none;
  overflow: hidden;
}
.focus-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.focus-shapes {
  stroke: #67e8fb;
  stroke-width: 2;
  fill: none;
  filter: drop-shadow(0 0 3px #27bbdd88);
}
.focus-frame {
  stroke: #66dff6;
  stroke-width: 2;
  fill: none;
}
.focus-guide {
  stroke: #51bed6;
  stroke-width: 1;
  fill: none;
  stroke-dasharray: 4 3;
}
.focus-reply-position {
  position: absolute;
  top: 0;
  left: 0;
  width: 360px;
  pointer-events: auto;
}
.focus-caption {
  font-size: 10px;
  color: #8ee3ef;
  background: #072637ed;
  padding: 5px 10px;
  border-radius: 8px 8px 0 0;
}
.focus-caption button {
  color: #a4f3ff;
  background: transparent;
  border: 0;
  text-decoration: underline;
  margin-left: 6px;
  cursor: pointer;
}
</style>
