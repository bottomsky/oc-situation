<script setup lang="ts">
import * as maplibregl from 'maplibre-gl';
import { configureMapLibreWorker } from '../utils/mapLibreWorker';
import type { GeoJSONSource, Map as ChartMap, Marker } from 'maplibre-gl';
import type { RouteCoordinate, Route, RoutePlan } from '@ais/contracts';
import type { RestrictionRecord } from '../composables/useRoutes';
import { createOfflineChartStyle } from '../utils/chartLayers';
import 'maplibre-gl/dist/maplibre-gl.css';
const props = defineProps<{
  waypoints: RouteCoordinate[];
  candidate?: RoutePlan | null;
  comparison?: Route | null;
  savedRoute?: Route | null;
  restrictions?: RestrictionRecord[];
  polygon: RouteCoordinate[];
  mode: 'waypoints' | 'restriction' | 'inspect';
  readonly?: boolean;
}>();
const emit = defineEmits<{
  'update:waypoints': [value: RouteCoordinate[]];
  'update:polygon': [value: RouteCoordinate[]];
}>();
const container = ref<HTMLDivElement>();
const mapError = ref('');
let map: ChartMap | undefined;
let markers: Marker[] = [];
let fittedRoute = '';
let disposed = false;
function fitRoute() {
  const route = props.savedRoute;
  if (!map?.getSource('route-workspace') || !route || fittedRoute === route.id) return;
  const bounds = new maplibregl.LngLatBounds();
  route.geometry.coordinates.forEach((p) => bounds.extend(p));
  map.fitBounds(bounds, { padding: 70, maxZoom: 11, duration: 0 });
  fittedRoute = route.id;
}
function update() {
  if (!map?.getSource('route-workspace')) return;
  fitRoute();
  const features: GeoJSON.Feature[] = [];
  if (props.waypoints.length >= 2)
    features.push({
      type: 'Feature',
      properties: { kind: 'draft' },
      geometry: { type: 'LineString', coordinates: props.waypoints },
    });
  if (props.candidate?.status === 'completed' && props.candidate.result)
    features.push({
      type: 'Feature',
      properties: { kind: 'plan' },
      geometry: props.candidate.result.geometry,
    });
  if (
    props.savedRoute &&
    JSON.stringify(props.savedRoute.waypoints) === JSON.stringify(props.waypoints)
  )
    features.push({
      type: 'Feature',
      properties: { kind: 'plan' },
      geometry: props.savedRoute.geometry,
    });
  if (props.comparison)
    features.push({
      type: 'Feature',
      properties: { kind: 'comparison' },
      geometry: props.comparison.geometry,
    });
  for (const restriction of props.restrictions || [])
    if (restriction.enabled)
      features.push({
        type: 'Feature',
        properties: { kind: 'restriction' },
        geometry: restriction.geometry,
      });
  props.polygon.forEach((point) =>
    features.push({
      type: 'Feature',
      properties: { kind: 'vertex' },
      geometry: { type: 'Point', coordinates: point },
    }),
  );
  if (props.polygon.length >= 3)
    features.push({
      type: 'Feature',
      properties: { kind: 'restriction' },
      geometry: { type: 'Polygon', coordinates: [[...props.polygon, props.polygon[0]!]] },
    });
  (map.getSource('route-workspace') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features,
  });
  markers.forEach((marker) => marker.remove());
  markers = [];
  props.waypoints.forEach((point, index) => {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'route-waypoint-marker';
    element.textContent = String(index + 1);
    element.setAttribute('aria-label', `航点 ${index + 1}，拖动调整`);
    const marker = new maplibregl.Marker({
      element,
      draggable: !props.readonly && props.mode === 'waypoints',
    })
      .setLngLat(point)
      .addTo(map!);
    marker.on('dragend', () => {
      const next = props.waypoints.map((p) => [...p] as RouteCoordinate);
      const pos = marker.getLngLat();
      next[index] = [Number(pos.lng.toFixed(6)), Number(pos.lat.toFixed(6))];
      emit('update:waypoints', next);
    });
    markers.push(marker);
  });
}
onMounted(async () => {
  // Nuxt 的 .client 包装在 hydration 挂载后才渲染真实容器。
  await nextTick();
  if (disposed || !container.value) return;
  try {
    configureMapLibreWorker();
    map = new maplibregl.Map({
      container: container.value,
      style: createOfflineChartStyle(),
      center: [123, 30],
      zoom: 4,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl(), 'top-right');
    map.on('load', () => {
      map!.addSource('route-workspace', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map!.addLayer({
        id: 'route-restrictions',
        type: 'fill',
        source: 'route-workspace',
        filter: ['==', ['get', 'kind'], 'restriction'],
        paint: { 'fill-color': '#f87171', 'fill-opacity': 0.25 },
      });
      map!.addLayer({
        id: 'route-lines',
        type: 'line',
        source: 'route-workspace',
        filter: ['!=', ['get', 'kind'], 'restriction'],
        paint: {
          'line-color': [
            'match',
            ['get', 'kind'],
            'plan',
            '#5eead4',
            'comparison',
            '#fbbf24',
            '#8098a6',
          ],
          'line-width': ['match', ['get', 'kind'], 'plan', 4, 2],
          'line-opacity': 0.9,
        },
      });
      map!.addLayer({
        id: 'route-polygon-vertices',
        type: 'circle',
        source: 'route-workspace',
        filter: ['==', ['get', 'kind'], 'vertex'],
        paint: {
          'circle-color': '#f87171',
          'circle-radius': 5,
          'circle-stroke-width': 1,
          'circle-stroke-color': '#ffe4e6',
        },
      });
      update();
    });
    map.on('click', (event) => {
      if ((event.originalEvent.target as Element | null)?.closest('.route-waypoint-marker')) return;
      if (props.readonly || props.mode === 'inspect') return;
      const point: RouteCoordinate = [
        Number(event.lngLat.wrap().lng.toFixed(6)),
        Number(event.lngLat.lat.toFixed(6)),
      ];
      if (Math.abs(point[1]) > 85) return;
      if (props.mode === 'restriction') emit('update:polygon', [...props.polygon, point]);
      else if (props.waypoints.length < 10) emit('update:waypoints', [...props.waypoints, point]);
    });
  } catch {
    mapError.value = '海图加载失败，请确认浏览器支持 WebGL。仍可通过有序航点坐标编辑。';
  }
});
watch(
  () => [
    props.waypoints,
    props.candidate,
    props.comparison,
    props.savedRoute,
    props.restrictions,
    props.polygon,
    props.mode,
    props.readonly,
  ],
  update,
  { deep: true },
);
onBeforeUnmount(() => {
  disposed = true;
  markers.forEach((marker) => marker.remove());
  map?.remove();
});
</script>
<template>
  <div class="route-map-shell">
    <div ref="container" class="route-map" aria-label="航线绘制海图" />
    <p v-if="mapError" role="alert" class="route-map-error">{{ mapError }}</p>
    <div class="route-map-legend">
      <span>● 航点 / 灰线为手绘草稿</span><span class="plan">━ 规划结果</span
      ><span class="compare">━ 对照方案</span><span class="restriction">■ 禁行区域</span>
    </div>
    <div class="route-map-hint">
      {{
        readonly
          ? '只读浏览'
          : mode === 'restriction'
            ? '点击海图绘制禁行区边界，至少三个点'
            : mode === 'waypoints'
              ? '点击海面添加航点 · 拖动数字标记调整 · 最多 10 个航点'
              : '海图浏览模式'
      }}
    </div>
  </div>
</template>
<style scoped>
.route-map-shell {
  position: relative;
  min-height: 480px;
  height: 100%;
  background: #081d31;
  border: 1px solid #234c5b;
  border-radius: 12px;
  overflow: hidden;
}
.route-map {
  position: absolute;
  inset: 0;
}
.route-map-legend,
.route-map-hint {
  position: absolute;
  left: 14px;
  right: 14px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  padding: 9px 12px;
  background: #071a28e8;
  border: 1px solid #285262;
  border-radius: 6px;
  font-size: 11px;
  color: #aec6cf;
  pointer-events: none;
}
.route-map-legend {
  bottom: 14px;
}
.route-map-hint {
  top: 14px;
  right: 62px;
}
.plan {
  color: #5eead4;
}
.compare {
  color: #fbbf24;
}
.restriction {
  color: #f87171;
}
.route-map-error {
  position: absolute;
  top: 60px;
  left: 20px;
  right: 20px;
  background: #432c2c;
  padding: 12px;
  color: #fecaca;
}
:global(.route-waypoint-marker) {
  width: 27px;
  height: 27px;
  border: 2px solid #5eead4;
  border-radius: 50%;
  background: #0b283a;
  color: #f0fdfa;
  font-weight: 700;
  cursor: grab;
  box-shadow: 0 0 0 4px #0b283a88;
}
</style>
