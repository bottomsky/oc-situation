<script setup lang="ts">
import type { ChartMapControls } from '../types/chart';
import type { ChartEffectSelection, ChartEffectViewportPort } from '../composables/useChartEffects';
import {
  chartAttentionIcon,
  chartAttentionRequest,
  chartAttentionVisibility,
  releaseChartAttentionRequests,
  intersectChartEffectViewports,
  chartAttentionFeedbackVisible,
  chartAttentionHasPermanentGlyph,
} from '../composables/useChartEffects';
import type {
  MapAttentionRequest,
  MapEffectBounds,
  MapEffectFrame,
  MapEffectTarget,
} from '../types/mapEffects';
import {
  MAP_EFFECT_COLOR,
  mapEffectCornerPath,
  mapEffectGlyphPath,
  mapEffectGlyphPaint,
  mapEffectGlyphBearing,
  mapEffectTargetIcon,
  projectMapEffect,
} from '../utils/mapEffects';
import { createMapEffectClock } from '../utils/mapEffectsClock';
const props = defineProps<{
  map: (ChartMapControls & ChartEffectViewportPort) | null;
  selected: ChartEffectSelection | null;
  targets: MapEffectTarget[];
  requests: MapAttentionRequest[];
  viewport?: MapEffectBounds | null;
  anchorLongitude?: number;
}>();
const emit = defineEmits<{
  hidden: [keys: string[]];
  muted: [keys: string[]];
  frame: [frame: MapEffectFrame];
  settled: [id: string];
}>();
const root = ref<HTMLElement | null>(null);
type Projection = NonNullable<ReturnType<typeof projectMapEffect>> & {
  target: MapEffectTarget;
  bearing: number;
};
const projected = shallowRef<Projection[]>([]);
const selection = shallowRef<ReturnType<typeof projectMapEffect>>(null);
const frame = shallowRef<MapEffectFrame>({
  request: null,
  elapsed: 0,
  visible: false,
  size: 24,
  phase: 'done',
});
const hidden = ref(false),
  reduced = ref(false);
let remove: (() => void) | undefined;
let observer: ResizeObserver | undefined;
let motion: MediaQueryList | undefined;
let hiddenStamp = '',
  mutedStamp = '';
const seen = new Set<string>();
const completed = new Set<string>();
let requestIds = new Set<string>();
const standalone = shallowRef<MapAttentionRequest[]>([]);
function view() {
  const available = props.map?.effectViewport() ??
    props.map?.focusViewport() ?? {
      left: 0,
      top: 0,
      right: root.value?.clientWidth ?? 0,
      bottom: root.value?.clientHeight ?? 0,
    };
  return intersectChartEffectViewports(available, props.viewport);
}
const activeTargets = computed(() => {
  const keys = new Set(frame.value.request?.targets.map((target) => target.key));
  return projected.value.filter((target) => keys.has(target.target.key));
});
function updateHidden() {
  const value = frame.value;
  const visibility = chartAttentionVisibility(
    value,
    projected.value.map((item) => ({ key: item.target.key, isPoint: item.isPoint })),
    hidden.value || reduced.value,
  );
  const keys = visibility.hidden;
  const nextHidden = keys.join('\n');
  if (nextHidden !== hiddenStamp) {
    hiddenStamp = nextHidden;
    emit('hidden', keys);
  }
  const muted = visibility.muted;
  const nextMuted = muted.join('\n');
  if (nextMuted !== mutedStamp) {
    mutedStamp = nextMuted;
    emit('muted', muted);
  }
}
const clock = createMapEffectClock({
  frames: {
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
  shortSide: () => {
    const v = view();
    return Math.max(0, Math.min(v.right - v.left, v.bottom - v.top));
  },
  onFrame(value) {
    frame.value = value;
    updateHidden();
    emit('frame', value);
    if (value.phase === 'done' && value.request) settle(value.request.id);
    props.map?.requestFocusRender();
  },
});
function project(target: MapEffectTarget): Projection | null {
  if (!props.map) return null;
  const viewport = view();
  if (viewport.right <= viewport.left || viewport.bottom <= viewport.top) return null;
  const value = projectMapEffect(target, {
    viewport,
    project: props.map.projectFocus,
    anchorLongitude: props.anchorLongitude,
  });
  if (!value) return null;
  let bearing = 0;
  const geometry = target.geometries.find((geometry) => geometry.type === 'Point');
  if (target.icon === 'vessel' && geometry?.type === 'Point') {
    const [lon, lat] = geometry.coordinates;
    const radians = ((target.bearing ?? 0) * Math.PI) / 180;
    const forward = props.map.projectFocus(
      [
        lon + (Math.sin(radians) * 0.01) / Math.max(0.01, Math.cos((lat * Math.PI) / 180)),
        Math.max(-90, Math.min(90, lat + Math.cos(radians) * 0.01)),
      ],
      props.anchorLongitude ?? lon,
    );
    if (forward)
      bearing =
        (Math.atan2(forward.x - value.center.x, value.center.y - forward.y) * 180) / Math.PI;
  }
  return { target, ...value, bearing };
}
function draw() {
  if (!props.map?.interactionState().ready) {
    projected.value = [];
    selection.value = null;
    updateHidden();
    return;
  }
  const requests = [...props.requests, ...standalone.value].filter(
    (request) => !completed.has(request.id),
  );
  const nextIds = new Set(requests.map((request) => request.id));
  for (const id of requestIds) if (!nextIds.has(id)) clock.cancel(id);
  requestIds = nextIds;
  // Pending standalone attention is projected too; it need not create a permanent highlight.
  const current = new Map(
    requests.flatMap((request) => request.targets).map((target) => [target.key, target]),
  );
  for (const target of props.targets) current.set(target.key, target);
  projected.value = [...current.values()].flatMap((target) => {
    const value = project(target);
    return value ? [value] : [];
  });
  const viewport = view();
  selection.value =
    props.selected && viewport.right > viewport.left && viewport.bottom > viewport.top
      ? projectMapEffect(props.selected, {
          viewport: view(),
          project: props.map.projectFocus,
          anchorLongitude: props.anchorLongitude,
        })
      : null;
  const visible = new Set(projected.value.map((target) => target.target.key));
  for (const request of requests) {
    if (seen.has(request.id)) continue;
    seen.add(request.id);
    const batch = chartAttentionRequest(request, visible);
    if (batch) clock.enqueue(batch);
    else settle(request.id);
  }
  updateHidden();
}
const persistent = computed(() => {
  const keys = new Set(props.targets.map((target) => target.key));
  const active =
    !hidden.value && !reduced.value && frame.value.phase === 'blink'
      ? new Set(frame.value.request?.targets.map((target) => target.key))
      : new Set<string>();
  return projected.value.filter(
    (item) => keys.has(item.target.key) && !item.isPoint && !active.has(item.target.key),
  );
});
const attentionCenter = computed(() => {
  const values = activeTargets.value;
  if (!values.length) return null;
  return {
    x:
      (Math.min(...values.map((v) => v.bounds.left)) +
        Math.max(...values.map((v) => v.bounds.right))) /
      2,
    y:
      (Math.min(...values.map((v) => v.bounds.top)) +
        Math.max(...values.map((v) => v.bounds.bottom))) /
      2,
  };
});
const emphasis = computed(() => {
  const current = frame.value;
  if (!current.request || !chartAttentionFeedbackVisible(current, hidden.value, reduced.value))
    return [];
  if (current.phase === 'contract') {
    if (!attentionCenter.value) return [];
    const single = activeTargets.value.length === 1 ? activeTargets.value[0] : undefined;
    const icon = chartAttentionIcon(
      current.request.icon,
      single ? mapEffectTargetIcon(single.target) : undefined,
    );
    return [
      {
        key: current.request.id,
        center: attentionCenter.value,
        icon,
        bearing: mapEffectGlyphBearing(icon, single?.bearing ?? 0),
      },
    ];
  }
  const targets =
    current.phase === 'static'
      ? activeTargets.value.filter(
          (value) =>
            !chartAttentionHasPermanentGlyph(current.request!, value.target, props.targets),
        )
      : activeTargets.value;
  return targets.map((value) => {
    const icon = chartAttentionIcon(current.request!.icon, mapEffectTargetIcon(value.target));
    return {
      key: value.target.key,
      center: value.center,
      icon,
      bearing: mapEffectGlyphBearing(icon, value.bearing),
    };
  });
});
function updateState() {
  hidden.value = document.hidden;
  reduced.value = motion?.matches ?? false;
  clock.update({ active: !!props.map, hidden: hidden.value, reduced: reduced.value });
  updateHidden();
}
function playAttention(request: MapAttentionRequest) {
  if (seen.has(request.id)) return false;
  standalone.value = [...standalone.value, request];
  draw();
  return true;
}
function settle(id: string) {
  if (completed.has(id)) return;
  completed.add(id);
  standalone.value = standalone.value.filter((request) => request.id !== id);
  emit('settled', id);
}
function cancelAttention(id?: string) {
  const released = releaseChartAttentionRequests([...props.requests, ...standalone.value], id);
  standalone.value = releaseChartAttentionRequests(standalone.value, id).retained;
  for (const requestId of released.released) settle(requestId);
  clock.cancel(id);
  draw();
}
defineExpose({ playAttention, cancelAttention });
watch(
  () => props.map,
  (map) => {
    remove?.();
    remove = map?.onFocusRender(draw);
    updateState();
    draw();
  },
  { flush: 'post' },
);
watch(
  () => [props.selected, props.targets, props.requests, props.viewport, props.anchorLongitude],
  draw,
  { flush: 'post' },
);
onMounted(() => {
  motion = matchMedia('(prefers-reduced-motion: reduce)');
  motion.addEventListener('change', updateState);
  document.addEventListener('visibilitychange', updateState);
  observer = new ResizeObserver(draw);
  if (root.value) observer.observe(root.value);
  remove = props.map?.onFocusRender(draw);
  updateState();
  draw();
});
onBeforeUnmount(() => {
  clock.dispose();
  remove?.();
  observer?.disconnect();
  motion?.removeEventListener('change', updateState);
  document.removeEventListener('visibilitychange', updateState);
  emit('hidden', []);
  emit('muted', []);
});
</script>
<template>
  <div
    ref="root"
    class="chart-map-effects"
    data-testid="chart-map-effects"
    :data-selected-key="selected?.key ?? ''"
  >
    <svg aria-hidden="true">
      <g
        v-for="value in persistent"
        :key="value.target.key"
        class="effect-glow"
        data-testid="chart-map-highlight"
        :data-object-key="value.target.key"
        fill="none"
        :stroke="MAP_EFFECT_COLOR"
        :color="MAP_EFFECT_COLOR"
        stroke-width="2"
      >
        <path :d="value.outlinePath" />
      </g>
      <g
        v-if="selection && selected"
        class="selection-corners"
        data-testid="chart-map-selection"
        :data-object-key="selected.key"
        :data-object-kind="selected.kind"
      >
        <path
          :d="mapEffectCornerPath(selection.bounds)"
          fill="none"
          :stroke="MAP_EFFECT_COLOR"
          stroke-width="2"
          stroke-linecap="square"
        />
      </g>
      <g
        v-for="value in emphasis"
        :key="value.key"
        class="effect-glow"
        data-testid="chart-map-emphasis"
        :data-batch-id="frame.request?.id"
        :data-phase="frame.phase"
        :data-icon="value.icon"
        :data-object-key="value.key"
        :transform="`translate(${value.center.x} ${value.center.y}) rotate(${value.bearing}) scale(${frame.size / 36}) translate(-18 -18)`"
        :color="frame.request?.color ?? MAP_EFFECT_COLOR"
        v-bind="mapEffectGlyphPaint(value.icon)"
      >
        <path :d="mapEffectGlyphPath(value.icon)" />
      </g>
    </svg>
  </div>
</template>
<style scoped>
.chart-map-effects {
  position: absolute;
  inset: 0;
  z-index: 34;
  pointer-events: none;
  overflow: hidden;
}
svg {
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.selection-corners {
  filter: drop-shadow(0 1px 1px #061321) drop-shadow(0 -1px 1px #061321);
}
.effect-glow {
  filter: drop-shadow(0 0 3px currentColor);
}
</style>
