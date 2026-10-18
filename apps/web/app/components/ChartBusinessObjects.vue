<script setup lang="ts">
import type { IntelligenceGeometry } from '@ais/contracts';
import type { ChartMapControls } from '../types/chart';
const props = defineProps<{
  map: ChartMapControls | null;
  objects: {
    kind: 'route' | 'event';
    id: string;
    label: string;
    geometry: IntelligenceGeometry | null;
  }[];
}>();
const emit = defineEmits<{ select: [kind: 'route' | 'event', id: string] }>();
const render = ref(0);
let remove: (() => void) | undefined;
watch(
  () => props.map,
  (map) => {
    remove?.();
    remove = map?.onFocusRender(() => {
      render.value++;
    });
  },
  { immediate: true },
);
onBeforeUnmount(() => remove?.());
function segments(g: IntelligenceGeometry): [number, number][][] {
  if (g.type === 'Point') return [[g.coordinates]];
  if (g.type === 'MultiPoint' || g.type === 'LineString') return [g.coordinates];
  if (g.type === 'MultiLineString' || g.type === 'Polygon') return g.coordinates;
  return g.coordinates.flat();
}
const shapes = computed(() => {
  void render.value;
  return props.objects.flatMap((object) =>
    object.geometry
      ? segments(object.geometry).map((segment, index) => ({
          object,
          index,
          point: object.geometry!.type.includes('Point'),
          polygon: object.geometry!.type.includes('Polygon'),
          points: segment
            .map((p) => props.map?.projectFocus(p, segment[0]?.[0]))
            .filter((p): p is { x: number; y: number } => !!p),
        }))
      : [],
  );
});
</script>
<template>
  <svg class="business-objects" aria-label="关注业务对象地图图层">
    <g
      v-for="s in shapes"
      :key="`${s.object.kind}:${s.object.id}:${s.index}`"
      tabindex="0"
      role="button"
      :aria-label="s.object.label"
      @click="emit('select', s.object.kind, s.object.id)"
      @keydown.enter="emit('select', s.object.kind, s.object.id)"
    >
      <title>{{ s.object.label }}</title>
      <template v-if="s.point">
        <circle v-for="(p, i) in s.points" :key="i" :cx="p.x" :cy="p.y" r="8" />
      </template>
      <polygon v-else-if="s.polygon" :points="s.points.map((p) => `${p.x},${p.y}`).join(' ')" />
      <polyline v-else :points="s.points.map((p) => `${p.x},${p.y}`).join(' ')" />
    </g>
  </svg>
</template>
<style scoped>
.business-objects {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 3;
  overflow: hidden;
}
.business-objects g {
  pointer-events: visiblePainted;
  cursor: pointer;
  fill: #50dccc55;
  stroke: #5debd7;
  stroke-width: 3;
}
.business-objects polyline {
  fill: none;
  stroke-width: 5;
}
.business-objects g:focus {
  stroke: #fff;
  outline: none;
}
</style>
