<script setup lang="ts">
import type { AgentFocusResult } from '../../../../packages/contracts/agent-focus';
import { focusCoordinates } from '../../../../packages/domain/agent-focus';
import {
  placeFocusReply,
  FOCUS_CARD_WIDTH,
  FOCUS_CARD_HEIGHT,
  focusObjectViewport,
  needsFocusComposition,
  focusReplyOccludes,
  type FocusSide,
} from '../utils/focusLayout';
import type { ChartMapControls } from '../types/chart';
import type { CurrentAgentReply } from '../composables/useAgentConversation';
import type { MapResponse } from '@ais/contracts';
import { createLiveFocusPresentation, createFocusCameraBudget } from '../utils/liveFocus';
import type { ReplyObjectViewModel } from '../types/agentReply';
import { replyObjectKey } from '../utils/replyObjects';
import { resolveVesselDirection } from '../utils/vesselMarkers';
const props = defineProps<{
  map: ChartMapControls | null;
  reply: CurrentAgentReply;
  focus: AgentFocusResult | null;
  fleet?: MapResponse | null;
  layoutKey?: string;
  objects?: ReplyObjectViewModel[];
  omittedCount?: number;
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
  object: [value: ReplyObjectViewModel];
  objects: [];
}>();
const targetCount = computed(
  () => new Set(props.focus?.targets.map((target) => replyObjectKey(target.ref))).size,
);
const vesselDirections = computed(() => {
  const selected = new Set(
    props.focus?.targets
      .filter((target) => target.ref.kind === 'vessel')
      .map((target) => target.ref.id),
  );
  return new Map(
    (props.fleet?.items ?? []).flatMap((point) =>
      point.kind === 'point' && selected.has(point.mmsi)
        ? [[point.mmsi, resolveVesselDirection(point)] as const]
        : [],
    ),
  );
});
const areaPaths = shallowRef<{ key: string; path: string }[]>([]);
const root = ref<HTMLElement | null>(null),
  card = ref<HTMLElement | null>(null),
  shapes = ref<SVGGElement | null>(null),
  labels = ref<SVGGElement | null>(null);
const compact = ref(false),
  shortViewport = ref(false),
  offscreen = ref(false),
  crowded = ref(false),
  pageHidden = ref(false),
  attentionArmed = ref(false);
const attentionKey = computed(() => `${props.reply.createdAt}:${props.reply.inputRevision ?? 0}`);
const replyScope = computed(() => ({
  createdAt: props.reply.createdAt,
  sessionId: props.reply.sessionId,
  taskId: props.reply.taskId,
  revision: props.reply.inputRevision ?? 0,
}));
watch(attentionKey, () => (attentionArmed.value = false), { flush: 'sync' });
const reservation = {
  reserveReply: true,
  replyPlacement: 'right' as FocusSide,
  cardWidth: FOCUS_CARD_WIDTH,
  cardHeight: FOCUS_CARD_HEIGHT,
  objectMinHeight: 80,
};
const detached = ref(false);
function updateVisibility() {
  pageHidden.value = document.hidden;
}
let projectionStamp = '';
let topCardLimit: number | undefined;
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
  topCardLimit = undefined;
  side = undefined;
  focusIntent = props.map?.cameraIntent(reservation);
  schedule();
}
function schedule() {
  if (!raf) raf = requestAnimationFrame(draw);
}
function draw() {
  raf = 0;
  if (disposed || !root.value || !card.value) return;
  shortViewport.value = root.value.clientHeight < 360;
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
  const areas: { key: string; path: string }[] = [];
  const circleLabels: SVGTextElement[] = [];
  if (focus && props.map)
    for (const target of presentation.value?.targets ?? []) {
      const targetAreas: string[] = [];
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
          commands.push(`M${p.x + 12},${p.y}a12,12 0 1,0 -24,0 a12,12 0 1,0 24,0`);
          const direction =
            target.ref.kind === 'vessel' ? vesselDirections.value.get(target.ref.id) : undefined;
          if (direction && direction.directionSource !== 'unknown' && line[0]) {
            const [lon, lat] = line[0];
            const radians = (direction.bearing * Math.PI) / 180;
            const forward = props.map.projectFocus(
              [
                lon + (Math.sin(radians) * 0.01) / Math.max(0.01, Math.cos((lat * Math.PI) / 180)),
                Math.max(-90, Math.min(90, lat + Math.cos(radians) * 0.01)),
              ],
              anchor,
            );
            if (forward) {
              const length = Math.hypot(forward.x - p.x, forward.y - p.y);
              if (Number.isFinite(length) && length > 0) {
                const ux = (forward.x - p.x) / length,
                  uy = (forward.y - p.y) / length;
                const vertex = (along: number, across: number) =>
                  `${p.x + ux * along - uy * across},${p.y + uy * along + ux * across}`;
                commands.push(
                  `M${vertex(9, 0)}L${vertex(-6, 5)}L${vertex(-3, 0)}L${vertex(-6, -5)}Z`,
                );
              }
            }
          }
        } else if (points.length) {
          const path = points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join(' ');
          commands.push(path);
          if (target.geometry.type === 'Polygon' || target.geometry.type === 'MultiPolygon')
            targetAreas.push(`${path} Z`);
        }
      }
      if (targetAreas.length)
        areas.push({
          key: `${replyObjectKey(target.ref)}:${areas.length}`,
          path: targetAreas.join(' '),
        });
    }
  labels.value?.replaceChildren(...circleLabels);
  if (shapes.value) {
    shapes.value.firstElementChild?.setAttribute('d', commands.join(' '));
  }
  areaPaths.value = areas;
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
  const height = card.value.offsetHeight || 240;
  const layout = placeFocusReply(
    view,
    visibleBox,
    FOCUS_CARD_WIDTH,
    height,
    side,
    targetCount.value,
    targetCount.value > 0,
    topCardLimit,
  );
  shortViewport.value = root.value.clientHeight < 360 || layout.shortHeader;
  const blocked = layout.width < 120;
  if (crowded.value !== blocked) {
    crowded.value = blocked;
    emit('crowded', blocked);
  }
  if (compact.value !== layout.compact) compact.value = layout.compact;
  if (visibleBox && hasMapFrame) side = layout.side;
  detached.value = !!visibleBox && layout.side === 'top';
  card.value.style.transform = `translate(${layout.left}px,${layout.top}px)`;
  card.value.style.width = `${layout.width}px`;
  card.value.style.visibility = blocked ? 'hidden' : 'visible';
  card.value.dataset.placement = layout.side;
  const covered = focusReplyOccludes(visibleBox, layout, height);
  const captionHeight = shortViewport.value
    ? 0
    : (card.value.querySelector<HTMLElement>('.focus-caption')?.offsetHeight ?? 0);
  card.value.style.setProperty(
    '--focus-card-max-height',
    `${Math.max(0, layout.maxHeight - captionHeight)}px`,
  );
  if (focus && hasMapFrame && props.map?.interactionState().ready) {
    const k = key();
    const interaction = props.map.interactionState();
    if (
      !blocked &&
      bounds &&
      focus.targets.length &&
      !interaction.moving &&
      !interaction.drawing &&
      cameraBudget.take()
    ) {
      const reservedHeight = layout.side === 'top' ? layout.maxHeight : height;
      const plan = props.map.estimateFocusCamera(bounds, {
        cardWidth: layout.width,
        cardHeight: reservedHeight,
        objectMinHeight: layout.objectMinHeight,
        topCardLimit,
      });
      if (plan) {
        reservation.replyPlacement = plan.placement;
        reservation.cardWidth = layout.width;
        reservation.cardHeight = plan.cardHeight;
        reservation.objectMinHeight = plan.objectMinHeight;
        if (plan.placement === 'top') {
          topCardLimit = plan.cardHeight;
          shortViewport.value = root.value.clientHeight < 360 || plan.shortHeader;
          card.value.style.setProperty(
            '--focus-card-max-height',
            `${Math.max(0, plan.cardHeight - (shortViewport.value ? 0 : captionHeight))}px`,
          );
        }
        const groupView = focusObjectViewport(
          view,
          plan.placement,
          layout.width,
          plan.cardHeight,
          plan.objectMinHeight,
        );
        const needsComposition = needsFocusComposition(
          box,
          groupView,
          plan.placement,
          layout.side,
          targetCount.value,
        );
        side = plan.placement;
        if (needsComposition && plan.compositionFits) {
          focusIntent?.(plan.request);
          projectionStamp = '';
          props.map.requestFocusRender();
          return;
        }
        projectionStamp = '';
        props.map.requestFocusRender();
      }
    }
    const actualStatus = !focus.targets.length
      ? 'unlocated'
      : outside || blocked || covered || !layout.compositionFits
        ? 'partial'
        : focus.displayStatus;
    if (!blocked && visibleBox && !props.map.interactionState().moving) attentionArmed.value = true;
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
    focusIntent = map?.cameraIntent(reservation);
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
    acknowledged = '';
    hasMapFrame = false;
    props.map?.requestFocusRender();
    schedule();
  },
  { flush: 'post' },
);
watch(replyScope, (next, previous) => {
  // Learning the server's task id after submission is still the same question.
  // Keep its original intent token so intervening user camera input wins.
  if (
    previous &&
    next.createdAt === previous.createdAt &&
    next.revision === previous.revision &&
    (!next.taskId || !previous.taskId || next.taskId === previous.taskId) &&
    (!next.sessionId || !previous.sessionId || next.sessionId === previous.sessionId)
  )
    return;
  side = undefined;
  cameraBudget.reset();
  topCardLimit = undefined;
  attentionArmed.value = false;
  focusIntent = props.map?.cameraIntent(reservation);
  projectionStamp = '';
  schedule();
});
onMounted(() => {
  updateVisibility();
  document.addEventListener('visibilitychange', updateVisibility);
  unsubscribe = props.map?.onFocusRender(mapRendered);
  focusIntent = props.map?.cameraIntent(reservation);
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
  document.removeEventListener('visibilitychange', updateVisibility);
  cancelAnimationFrame(raf);
});
</script>
<template>
  <div ref="root" class="chart-focus-overlay" data-testid="chart-focus-overlay">
    <svg class="focus-svg" aria-hidden="true">
      <g
        :key="`shapes:${attentionKey}`"
        ref="shapes"
        class="focus-shapes"
        :class="{ 'focus-attention': attentionArmed }"
        :style="{ animationPlayState: pageHidden ? 'paused' : 'running' }"
      >
        <path />
      </g>
      <path
        v-for="area in areaPaths"
        :key="area.key"
        :d="area.path"
        class="focus-area"
        fill-rule="evenodd"
      />
      <g ref="labels" class="focus-labels" />
    </svg>
    <div ref="card" class="focus-reply-position">
      <div
        v-if="focus"
        class="focus-caption"
        :class="{ 'focus-caption-sr': shortViewport }"
        role="status"
      >
        {{ targetCount }} 个关注对象<span v-if="focus.missing.length">
          · {{ focus.missing.length }} 个未定位</span
        ><span v-if="focus.omittedCount"> · {{ focus.omittedCount }} 项超出展示上限</span
        ><span v-if="offscreen"> · 部分对象位于视野外</span
        ><button v-if="!shortViewport && (offscreen || detached)" type="button" @click="refocus">
          重新聚焦
        </button>
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
        :objects="objects"
        :omitted-count="omittedCount"
        :short-viewport="shortViewport"
        :refocus="offscreen || detached"
        @close="emit('close')"
        @open="emit('open')"
        @reference="(r, t, v) => emit('reference', r, t, v)"
        @object="emit('object', $event)"
        @objects="emit('objects')"
        @refocus="refocus"
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
.focus-caption.focus-caption-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  padding: 0;
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
.focus-area {
  fill: rgb(70 213 237 / 9%);
  stroke: none;
}
.focus-attention {
  animation: focus-acquire 600ms ease-out both;
}
@keyframes focus-acquire {
  0% {
    opacity: 0.4;
  }
  100% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .focus-attention {
    animation: none;
  }
}
.focus-reply-position {
  position: absolute;
  top: 0;
  left: 0;
  width: 420px;
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
