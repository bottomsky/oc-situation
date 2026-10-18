<script setup lang="ts">
import * as maplibregl from 'maplibre-gl';
import { configureMapLibreWorker } from '../utils/mapLibreWorker';
import type { GeoJSONSource, Map as ChartMap } from 'maplibre-gl';
import { GeometrySchema, type IntelligenceGeometry } from '@ais/contracts';
import { createOfflineChartStyle } from '../utils/chartLayers';
import { focusBounds } from '../../../../packages/domain/agent-focus';
import 'maplibre-gl/dist/maplibre-gl.css';
const props = defineProps<{ modelValue: IntelligenceGeometry | null; readonly?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: IntelligenceGeometry | null] }>();
const host = ref<HTMLDivElement>(),
  mode = ref<'Point' | 'LineString' | 'Polygon'>('Point'),
  error = ref('');
const points = ref<[number, number][]>([]);
let map: ChartMap | undefined;
function sync() {
  if (!map?.isStyleLoaded()) return;
  (map.getSource('event') as GeoJSONSource)?.setData({
    type: 'FeatureCollection',
    features: props.modelValue
      ? [{ type: 'Feature', properties: {}, geometry: props.modelValue }]
      : [],
  });
}
function setPoints() {
  const p = points.value;
  const value =
    mode.value === 'Point'
      ? p[0]
        ? { type: 'Point', coordinates: p[0] }
        : null
      : mode.value === 'LineString'
        ? p.length > 1
          ? { type: 'LineString', coordinates: p }
          : null
        : p.length > 2
          ? { type: 'Polygon', coordinates: [[...p, p[0]]] }
          : null;
  const parsed = GeometrySchema.safeParse(value);
  emit('update:modelValue', parsed.success ? parsed.data : null);
}
function start(value: typeof mode.value) {
  mode.value = value;
  points.value = [];
  emit('update:modelValue', null);
}
onMounted(() => {
  try {
    configureMapLibreWorker();
    map = new maplibregl.Map({
      container: host.value!,
      style: createOfflineChartStyle(),
      center: [123, 30],
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl());
    map.on('load', () => {
      map!.addSource('event', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map!.addLayer({
        id: 'event-fill',
        source: 'event',
        type: 'fill',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#50ded0', 'fill-opacity': 0.2 },
      });
      map!.addLayer({
        id: 'event-line',
        source: 'event',
        type: 'line',
        filter: ['!=', ['geometry-type'], 'Point'],
        paint: { 'line-color': '#50ded0', 'line-width': 3 },
      });
      map!.addLayer({
        id: 'event-point',
        source: 'event',
        type: 'circle',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-color': '#50ded0', 'circle-radius': 7 },
      });
      sync();
      if (props.modelValue) {
        const bounds = focusBounds([props.modelValue]);
        if (bounds)
          map!.fitBounds(
            [
              [bounds[0], bounds[1]],
              [bounds[2] < bounds[0] ? bounds[2] + 360 : bounds[2], bounds[3]],
            ],
            { padding: 55, maxZoom: 10, duration: 0 },
          );
      }
    });
    map.on('click', (e) => {
      if (props.readonly) return;
      const point: [number, number] = [
        Number(e.lngLat.wrap().lng.toFixed(6)),
        Number(e.lngLat.lat.toFixed(6)),
      ];
      points.value = mode.value === 'Point' ? [point] : [...points.value, point];
      setPoints();
    });
  } catch {
    error.value = '海图暂不可用，请使用坐标编辑。';
  }
});
watch(() => props.modelValue, sync, { deep: true });
onBeforeUnmount(() => map?.remove());
const raw = computed(() => (props.modelValue ? JSON.stringify(props.modelValue) : ''));
function coordinates(e: Event) {
  try {
    emit(
      'update:modelValue',
      GeometrySchema.parse(JSON.parse((e.target as HTMLTextAreaElement).value)),
    );
    error.value = '';
  } catch {
    error.value = '请输入合法 GeoJSON 点、线或面几何。';
  }
}
</script>
<template>
  <section aria-label="事件几何编辑">
    <div v-if="!readonly" class="geometry-toolbar">
      <button type="button" @click="start('Point')">绘制点</button
      ><button type="button" @click="start('LineString')">绘制线</button
      ><button type="button" @click="start('Polygon')">绘制面</button
      ><button
        type="button"
        @click="
          points.pop();
          setPoints();
        "
      >
        撤销节点</button
      ><button type="button" @click="start(mode)">清除定位</button
      ><span>海图逐点点击，线至少两点，面至少三点 · {{ points.length }} 节点</span>
    </div>
    <div ref="host" class="event-map" />
    <details>
      <summary>坐标精确编辑</summary>
      <textarea :value="raw" :disabled="readonly" aria-label="GeoJSON几何" @change="coordinates" />
    </details>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="!modelValue">未定位</p>
  </section>
</template>
<style scoped>
.event-map {
  height: 310px;
  border: 1px solid #255160;
  border-radius: 8px;
}
.geometry-toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0;
}
.geometry-toolbar span {
  color: #91b5bf;
  font-size: 12px;
}
textarea {
  width: 100%;
  min-height: 70px;
}
</style>
