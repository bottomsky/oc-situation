<script setup lang="ts">
import * as maplibregl from 'maplibre-gl';
import {
  TerraDraw,
  TerraDrawPointMode,
  TerraDrawLineStringMode,
  TerraDrawPolygonMode,
  TerraDrawSelectMode,
} from 'terra-draw';
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter';
import { GeometrySchema } from '@ais/contracts';
import type { IntelligenceGeometry } from '@ais/contracts';
import type { GeoJSONStoreFeatures } from 'terra-draw';
import {
  splitEditableGeometry,
  combineEditableGeometry,
  type EditableGeometry,
} from '../utils/intelligenceDrawing';
import type { IntelligencePlot, IntelligenceGeoObject } from '@ais/contracts';
import { dateLabel } from '../utils/display';
import {
  relationLabels,
  reviewLabels,
  intelligenceSampleLabel,
  statusLabels,
  objectLabels,
} from '../utils/intelligenceLabels';
import {
  registerIntelligenceLayers,
  intelligenceLayerIds,
  intelligenceFeatureGroup,
  intelligenceFeatureBounds,
} from '../utils/intelligenceMap';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { GeoJSONSource, Map as GLMap } from 'maplibre-gl';
import type {
  Bbox,
  MapResponse,
  TrackResponse,
  PositionObservation,
  AnalysisResult,
} from '@ais/contracts';
import { vesselMarkerProperties } from '../utils/vesselMarkers';
import { registerChartBusinessLayers } from '../utils/chartBusinessLayers';
import { heatmapGeoJson, registerHeatmapLayers, heatmapViewportBounds } from '../utils/heatmapMap';
import { registerVesselTracksLayers, vesselTracksGeoJson } from '../utils/vesselTracksMap';
import type { VesselTracksResult, HeatmapResult } from '@ais/contracts';
import type { ChartLayerVisibility, ChartMapControls } from '../types/chart';
import {
  applyChartBusinessVisibility,
  chartHomeBounds,
  createOfflineChartStyle,
  createChartMapScheduling,
} from '../utils/chartLayers';
const props = defineProps<{
  data: MapResponse | null;
  track: TrackResponse | null;
  frame: PositionObservation | null;
  evidence?: AnalysisResult | null;
  intelligence?: IntelligencePlot;
  objects?: IntelligenceGeoObject[];
  intelligenceLayers?: Record<string, boolean>;
  activeEventId?: string;
  canDraw?: boolean;
  layers?: Partial<ChartLayerVisibility>;
  selectingRegion?: boolean;
  heatmap?: HeatmapResult | null;
  vesselTracks?: VesselTracksResult | null;
}>();
const emit = defineEmits<{
  viewport: [bbox: Bbox, zoom: number];
  select: [mmsi: string];
  intelligence: [eventIds: string[]];
  object: [objectId: string];
  geometry: [geometry: unknown];
  regionSelected: [bbox: Bbox];
  regionCancelled: [];
  heatmapDisplayed: [result: HeatmapResult];
  vesselTracksDisplayed: [result: VesselTracksResult];
}>();
const host = useTemplateRef<HTMLElement>('mapHost');
const mapError = ref('');
const ready = ref(false);
const moving = ref(false);
const regionStart = ref<{ x: number; y: number } | null>(null);
const regionEnd = ref<{ x: number; y: number } | null>(null);
const regionBox = computed(() =>
  regionStart.value && regionEnd.value
    ? {
        left: `${Math.min(regionStart.value.x, regionEnd.value.x)}px`,
        top: `${Math.min(regionStart.value.y, regionEnd.value.y)}px`,
        width: `${Math.abs(regionStart.value.x - regionEnd.value.x)}px`,
        height: `${Math.abs(regionStart.value.y - regionEnd.value.y)}px`,
      }
    : {},
);
function regionPoint(event: PointerEvent) {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(bounds.width, event.clientX - bounds.left)),
    y: Math.max(0, Math.min(bounds.height, event.clientY - bounds.top)),
  };
}
function startRegion(event: PointerEvent) {
  if (event.button !== 0 || !map) return;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  regionStart.value = regionPoint(event);
  regionEnd.value = regionStart.value;
}
function moveRegion(event: PointerEvent) {
  if (regionStart.value) regionEnd.value = regionPoint(event);
}
function finishRegion(event: PointerEvent) {
  const start = regionStart.value;
  if (!start || !map) return;
  const end = regionPoint(event);
  regionStart.value = null;
  regionEnd.value = null;
  if (Math.abs(start.x - end.x) < 5 || Math.abs(start.y - end.y) < 5) return;
  const nw = map.unproject([Math.min(start.x, end.x), Math.min(start.y, end.y)]);
  const se = map.unproject([Math.max(start.x, end.x), Math.max(start.y, end.y)]);
  const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
  emit(
    'regionSelected',
    se.lng - nw.lng >= 360
      ? [-180, Math.max(-90, se.lat), 180, Math.min(90, nw.lat)]
      : [wrap(nw.lng), Math.max(-90, se.lat), wrap(se.lng), Math.min(90, nw.lat)],
  );
}
watch(
  () => props.selectingRegion,
  () => {
    regionStart.value = null;
    regionEnd.value = null;
  },
);
let map: GLMap | undefined;
let heatmapPopup: maplibregl.Popup | undefined;
const heatmapPopupOpen = ref(false);
useUiComponent('chart.heatmap.popup', {
  read: () => uiProjection(heatmapPopupOpen.value, ['close'], { order: 20 }),
  execute: () => {
    heatmapPopup?.remove();
    heatmapPopupOpen.value = false;
  },
});
let drawing: TerraDraw | undefined;
const drawMode = ref('cancel');
const drawingError = ref('');
let drawingFamily: IntelligenceGeometry['type'] | null = null;
let replacingDrawing = false;
function publishDrawing() {
  if (disposed || replacingDrawing || !drawing || !drawingFamily) return;
  const features = drawing
    .getSnapshot()
    .filter(
      (f) =>
        ['point', 'linestring', 'polygon'].includes(String(f.properties.mode)) &&
        ![
          'coordinatePoint',
          'midPoint',
          'selectionPoint',
          'currentlyDrawing',
          'closingPoint',
          'snappingPoint',
        ].some((key) => f.properties[key]),
    )
    .sort(
      (a, b) => Number(a.properties.componentIndex ?? 0) - Number(b.properties.componentIndex ?? 0),
    );
  if (!features.length) {
    emit('geometry', undefined);
    return;
  }
  try {
    emit(
      'geometry',
      combineEditableGeometry(
        drawingFamily,
        features.map((f) => f.geometry as EditableGeometry),
      ),
    );
    drawingError.value = '';
  } catch (e) {
    drawingError.value = (e as Error).message;
  }
}
function finishDrawing(id: string | number) {
  publishDrawing();
  drawMode.value = 'select';
  drawing?.setMode('select');
  drawing?.selectFeature(id);
}
function editGeometry(value: IntelligenceGeometry) {
  if (!props.canDraw || !drawing || !map) return;
  drawingError.value = '';
  try {
    const geometry = GeometrySchema.parse(value);
    const parts = splitEditableGeometry(geometry);
    const features: GeoJSONStoreFeatures[] = parts.map((part, index) => ({
      type: 'Feature',
      id: crypto.randomUUID(),
      geometry: part,
      properties: { mode: part.type.toLowerCase(), componentIndex: index },
    }));
    replacingDrawing = true;
    if (!drawing.enabled) drawing.start();
    drawing.clear();
    drawingFamily = geometry.type;
    const results = drawing.addFeatures(features);
    if (results.some((result) => !result.valid))
      throw new Error('已存几何无法加载为可编辑草稿，请检查几何合法性');
    drawMode.value = 'select';
    drawing.setMode('select');
    if (features[0]?.id) drawing.selectFeature(features[0].id);
    const bounds = intelligenceFeatureBounds([{ geometry }]);
    if (bounds) map.fitBounds(bounds, { padding: 100, maxZoom: 11 });
  } catch (e) {
    drawingError.value = (e as Error).message;
    drawingFamily = null;
    drawMode.value = 'cancel';
    if (drawing.enabled) {
      drawing.clear();
      drawing.stop();
    }
  } finally {
    replacingDrawing = false;
    publishDrawing();
  }
}

const drawModeLabel = computed(
  () =>
    (
      ({ point: '点', linestring: '线', polygon: '区域', select: '编辑' }) as Record<string, string>
    )[drawMode.value],
);
let labels: maplibregl.Marker[] = [];
function updateLabels() {
  labels.forEach((label) => label.remove());
  labels = [];
  if (!map) return;
  for (const feature of (props.intelligence?.features ?? []).slice(0, 120)) {
    let coordinate: unknown = feature.geometry.coordinates;
    while (Array.isArray(coordinate) && Array.isArray(coordinate[0])) coordinate = coordinate[0];
    if (!Array.isArray(coordinate) || coordinate.length < 2) continue;
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'intelligence-feature-label';
    if (props.intelligenceLayers?.[intelligenceFeatureGroup(feature.properties)] === false)
      continue;
    element.textContent = `${({ location: '●', object: '◆', impact: '▲', candidate: '◇' } as Record<string, string>)[intelligenceFeatureGroup(feature.properties)]} ${feature.properties.title}${intelligenceSampleLabel(feature.properties.synthetic) ? ' · 样例数据' : ''} · ${relationLabels[feature.properties.kind] || '对象位置'} · ${reviewLabels[feature.properties.eventReviewStatus === 'candidate' ? 'candidate' : feature.properties.reviewStatus] || '待核实'}${feature.properties.status !== 'active' ? ' · ' + (statusLabels[feature.properties.status] || '历史') : ''}${feature.properties.effectiveTimePending ? ' · 有效期待确认' : ''}${feature.properties.sourceObserved ? ' · 来源观测点' : ''}${feature.properties.positionSource === 'ais-latest' ? ' · 船位观测 ' + dateLabel(feature.properties.observedAt) : ''}`;
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (drawMode.value === 'cancel') {
        const point = map!.project([Number(coordinate[0]), Number(coordinate[1])]);
        const ids = map!
          .queryRenderedFeatures(point, { layers: intelligenceLayerIds })
          .map((f) => String(f.properties.eventId));
        emit('intelligence', [...new Set([...ids, feature.properties.eventId])]);
      }
    });
    labels.push(
      new maplibregl.Marker({ element, anchor: 'top-left', offset: [8, 8] })
        .setLngLat([Number(coordinate[0]), Number(coordinate[1])])
        .addTo(map),
    );
  }
  if (props.intelligenceLayers?.directory !== false)
    for (const object of (props.objects ?? []).filter((o) => o.geometry).slice(0, 120)) {
      let coordinate: unknown = object.geometry!.coordinates;
      while (Array.isArray(coordinate) && Array.isArray(coordinate[0])) coordinate = coordinate[0];
      if (!Array.isArray(coordinate)) continue;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = 'intelligence-object-label';
      element.textContent = `□ ${object.name} · ${objectLabels[object.kind]}`;
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        if (drawMode.value === 'cancel') emit('object', object.id);
      });
      labels.push(
        new maplibregl.Marker({ element, anchor: 'bottom-left', offset: [5, -5] })
          .setLngLat([Number(coordinate[0]), Number(coordinate[1])])
          .addTo(map),
      );
    }
}

function updateIntelligence() {
  if (!map?.getSource('intelligence')) return;
  (map.getSource('intelligence-objects') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: (props.objects ?? [])
      .filter((o) => o.geometry)
      .map((o) => ({
        type: 'Feature',
        geometry: o.geometry!,
        properties: { objectId: o.id, name: o.name, kind: o.kind },
      })),
  });
  for (const group of ['location', 'object', 'impact', 'candidate'])
    for (const kind of ['fill', 'line', 'point'])
      map.setLayoutProperty(
        'intelligence-' + group + '-' + kind,
        'visibility',
        props.intelligenceLayers?.[group] === false ? 'none' : 'visible',
      );
  for (const kind of ['fill', 'line', 'point'])
    map.setLayoutProperty(
      'intelligence-object-directory-' + kind,
      'visibility',
      props.intelligenceLayers?.directory === false ? 'none' : 'visible',
    );
  updateLabels();
  (map.getSource('intelligence') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: (props.intelligence?.features ?? []).map((f) => ({
      ...f,
      properties: {
        ...f.properties,
        group: intelligenceFeatureGroup(f.properties),
        active: f.properties.eventId === props.activeEventId,
      },
    })),
  });
}
function locateIntelligence(eventId?: string) {
  const bounds = intelligenceFeatureBounds(
    (props.intelligence?.features ?? []).filter(
      (f) => !eventId || f.properties.eventId === eventId,
    ),
  );
  if (bounds) map?.fitBounds(bounds, { padding: 70, maxZoom: 11 });
}
function draw(mode: 'point' | 'linestring' | 'polygon' | 'select' | 'cancel') {
  if (!drawing || (mode !== 'cancel' && !props.canDraw)) return;
  drawingError.value = '';
  drawMode.value = mode;
  if (mode === 'cancel') {
    drawingFamily = null;
    if (drawing.enabled) {
      drawing.clear();
      drawing.stop();
    }
    emit('geometry', undefined);
  } else {
    if (!drawing.enabled) drawing.start();
    if (mode !== 'select') {
      drawingFamily = ({ point: 'Point', linestring: 'LineString', polygon: 'Polygon' } as const)[
        mode
      ];
      drawing.clear();
      emit('geometry', undefined);
    }
    drawing.setMode(mode);
    if (mode === 'select') {
      const feature = drawing
        .getSnapshot()
        .find(
          (f) =>
            ['point', 'linestring', 'polygon'].includes(String(f.properties.mode)) &&
            !f.properties.currentlyDrawing,
        );
      if (feature?.id) drawing.selectFeature(feature.id);
    }
  }
}
let directionPopup: maplibregl.Popup | undefined;
const mapInitializations = ref(0);
const mapInstance = ref('');
let scheduling: ReturnType<typeof createChartMapScheduling> | undefined;
let resizeObserver: ResizeObserver | undefined;
let disposed = false;
const grid = {
  type: 'FeatureCollection' as const,
  features: [
    ...Array.from({ length: 13 }, (_, i) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [-180 + i * 30, -85],
          [-180 + i * 30, 85],
        ],
      },
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [
          [-180, -60 + i * 30],
          [180, -60 + i * 30],
        ],
      },
    })),
  ],
};
function update() {
  if (!map?.getSource('vessels')) return;
  directionPopup?.remove();
  const vessels =
    props.data?.items.map((item) => ({
      type: 'Feature' as const,
      properties: {
        ...item,
        label: item.kind === 'cluster' ? String(item.count) : item.mmsi,
        sample: item.kind === 'point' && item.quality.includes('synthetic'),
        ...(item.kind === 'point' ? vesselMarkerProperties(item) : {}),
      },
      geometry: { type: 'Point' as const, coordinates: [item.lon, item.lat] },
    })) ?? [];
  (map.getSource('vessels') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: vessels,
  });
  (map.getSource('track') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features:
      props.track?.segments
        .filter((s) => s.points.length > 1)
        .map((s) => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: s.points.map((p) => [p.lon, p.lat]) },
        })) ?? [],
  });
  (map.getSource('frame') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: props.frame
      ? [
          {
            type: 'Feature',
            properties: { ...props.frame, ...vesselMarkerProperties(props.frame, true) },
            geometry: { type: 'Point', coordinates: [props.frame.lon, props.frame.lat] },
          },
        ]
      : [],
  });
  updateEvidence();
}
function updateEvidence() {
  if (!map?.getSource('evidence-points')) return;
  const points = props.evidence?.evidence.ais ?? [];
  (map.getSource('evidence-points') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      properties: { id: p.recordId },
      geometry: { type: 'Point', coordinates: [p.longitude, p.latitude] },
    })),
  });
  const groups = new Map<string, typeof points>();
  for (const point of points) groups.set(point.mmsi, [...(groups.get(point.mmsi) ?? []), point]);
  const segments: number[][][] = [];
  for (const group of groups.values()) {
    group.sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt));
    let segment: number[][] = [];
    for (const point of group) {
      const previous = segment.at(-1);
      if (previous && Math.abs(point.longitude - previous[0]!) > 180) {
        if (segment.length > 1) segments.push(segment);
        segment = [];
      }
      segment.push([point.longitude, point.latitude]);
    }
    if (segment.length > 1) segments.push(segment);
  }
  (map.getSource('evidence-track') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: segments.map((coordinates) => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates },
    })),
  });
  const boxes = props.evidence?.evidence.documents.flatMap((d) => (d.bbox ? [d.bbox] : [])) ?? [];
  const polygons = boxes.flatMap(([w, s, e, n]) =>
    w > e
      ? [
          [w, s, 180, n],
          [-180, s, e, n],
        ]
      : [[w, s, e, n]],
  );
  (map.getSource('evidence-region') as GeoJSONSource).setData({
    type: 'FeatureCollection',
    features: polygons.map(([w, s, e, n]) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [w!, s!],
            [e!, s!],
            [e!, n!],
            [w!, n!],
            [w!, s!],
          ],
        ],
      },
    })),
  });
}
function registerBusinessLayers() {
  if (!map) return;
  registerHeatmapLayers(map);
  updateHeatmap();
  registerVesselTracksLayers(map);
  updateVesselTracks();
  registerChartBusinessLayers(map, grid);
  applyChartBusinessVisibility(map, props.layers);
  registerIntelligenceLayers(map);
  updateIntelligence();
  update();
  ready.value = true;
  scheduling?.viewport();
}
function updateVesselTracks() {
  const source = map?.getSource('ais-history-tracks') as GeoJSONSource | undefined;
  if (!source) return;
  const snapshot = props.vesselTracks;
  source.setData(vesselTracksGeoJson(snapshot ?? null));
  if (snapshot)
    map?.once('idle', () => {
      if (props.vesselTracks === snapshot && map?.getLayer('ais-history-tracks'))
        emit('vesselTracksDisplayed', snapshot);
    });
}
function updateHeatmap() {
  heatmapPopup?.remove();
  heatmapPopupOpen.value = false;
  const source = map?.getSource('ais-heatmap') as GeoJSONSource | undefined;
  if (!source) return;
  const snapshot = props.heatmap;
  source.setData(heatmapGeoJson(snapshot ?? null));
  if (snapshot)
    map?.once('idle', () => {
      if (props.heatmap === snapshot && map?.getLayer('ais-heatmap'))
        emit('heatmapDisplayed', snapshot);
    });
}
onMounted(async () => {
  await nextTick();
  if (disposed || !host.value) return;
  try {
    maplibregl.setWorkerUrl(workerUrl);
    map = new maplibregl.Map({
      container: host.value,
      style: createOfflineChartStyle(),
      bounds: chartHomeBounds,
      minZoom: 0,
      maxZoom: 22,
      fitBoundsOptions: { padding: 30, maxZoom: 8 },
      attributionControl: { compact: true },
    });
    ++mapInitializations.value;
    mapInstance.value = crypto.randomUUID();
    scheduling = createChartMapScheduling(
      { resize: () => map?.resize(), viewport },
      {
        request: (callback) => requestAnimationFrame(callback),
        cancel: (id) => cancelAnimationFrame(id),
      },
    );
    map.on('style.load', () => {
      registerBusinessLayers();
      drawing = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: map! }),
        modes: [
          new TerraDrawPointMode(),
          new TerraDrawLineStringMode(),
          new TerraDrawPolygonMode(),
          new TerraDrawSelectMode({
            flags: {
              point: { feature: { draggable: true } },
              linestring: {
                feature: {
                  draggable: true,
                  coordinates: { draggable: true, midpoints: true, deletable: true },
                },
              },
              polygon: {
                feature: {
                  draggable: true,
                  coordinates: { draggable: true, midpoints: true, deletable: true },
                },
              },
            },
          }),
        ],
      });
      drawing.start();
      drawing.stop();
      drawing.on('finish', finishDrawing);
      drawing.on('change', publishDrawing);
    });
    map.on('click', (e) => {
      if (drawMode.value !== 'cancel') return;
      const features = map!.queryRenderedFeatures(e.point, {
        layers: intelligenceLayerIds.filter((id) => map!.getLayer(id)),
      });
      const ids = [...new Set(features.map((f) => String(f.properties.eventId)).filter(Boolean))];
      if (ids.length) {
        emit('intelligence', ids);
        return;
      }
      const reference = map!
        .queryRenderedFeatures(e.point)
        .find(
          (f) => f.layer.id.startsWith('intelligence-object-directory') && f.properties?.objectId,
        );
      if (reference) emit('object', String(reference.properties.objectId));
      else if (
        props.heatmap &&
        !map!.queryRenderedFeatures(e.point, { layers: ['vessels', 'clusters'] }).length
      ) {
        const cell = props.heatmap.cells.find((item) => {
          const half = props.heatmap!.grid.cellDegrees / 2;
          return (
            Math.abs(e.lngLat.wrap().lng - item.lon) <= half &&
            Math.abs(e.lngLat.lat - item.lat) <= half
          );
        });
        if (cell) {
          const content = document.createElement('div');
          content.textContent = `网格 ${cell.id}：${cell.vesselCount} 艘去重船舶`;
          heatmapPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: true });
          heatmapPopup.on('close', () => {
            heatmapPopupOpen.value = false;
          });
          heatmapPopup.setLngLat(e.lngLat).setDOMContent(content).addTo(map!);
          heatmapPopupOpen.value = true;
        }
      }
    });
    map.on('webglcontextlost', () => {
      ready.value = false;
      mapError.value = '地图绘制中断，请刷新页面恢复；船舶列表仍可查询。';
    });
    map.on('webglcontextrestored', () => {
      mapError.value = '';
      ready.value = Boolean(map?.getSource('vessels'));
      scheduling?.resize();
    });
    resizeObserver = new ResizeObserver(() => scheduling?.resize());
    resizeObserver.observe(host.value);
    map.on('movestart', () => {
      moving.value = true;
    });
    map.on('moveend', () => {
      moving.value = false;
      scheduling?.viewport();
    });
    map.on('mouseenter', 'vessels', (e) => {
      const p = e.features?.[0]?.properties;
      if (!p) return;
      map!.getCanvas().style.cursor = 'pointer';
      const content = document.createElement('div');
      content.textContent = `${p.mmsi} · ${p.directionLabel}`;
      directionPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false });
      directionPopup.setLngLat(e.lngLat).setDOMContent(content).addTo(map!);
    });
    map.on('mouseleave', 'vessels', () => {
      map!.getCanvas().style.cursor = '';
      directionPopup?.remove();
    });
    map.on('click', 'vessels', (e) => {
      if (drawMode.value !== 'cancel') return;
      if (
        map!.queryRenderedFeatures(e.point, {
          layers: intelligenceLayerIds.filter((id) => map!.getLayer(id)),
        }).length
      )
        return;
      const p = e.features?.[0]?.properties;
      if (p?.kind === 'point') {
        emit('select', String(p.mmsi));
        const content = document.createElement('div');
        content.textContent = `${p.mmsi} · ${p.directionLabel}`;
        directionPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        directionPopup.setLngLat(e.lngLat).setDOMContent(content).addTo(map!);
      }
    });
    map.on('click', 'clusters', (e) => {
      map!.flyTo({ center: e.lngLat, zoom: Math.min(9, map!.getZoom() + 2) });
    });
  } catch {
    mapError.value = map
      ? '地图初始化未完成，请刷新页面恢复；船舶列表仍可查询。'
      : '当前浏览器无法初始化地图绘制，船舶列表仍可查询。';
  }
});
function viewport() {
  if (!map) return;
  emit('viewport', currentBounds()!, map.getZoom());
}
function currentBounds(): Bbox | null {
  if (!map) return null;
  const b = map.getBounds();
  return heatmapViewportBounds(b.getWest(), b.getSouth(), b.getEast(), b.getNorth());
}
watch(() => [props.data, props.track, props.frame], update, { deep: true });
watch(() => props.heatmap, updateHeatmap);
watch(() => props.vesselTracks, updateVesselTracks);
watch(
  () => [props.intelligence, props.activeEventId, props.objects, props.intelligenceLayers],
  updateIntelligence,
  {
    deep: true,
  },
);
watch(
  () => props.layers,
  (layers) => {
    if (map) applyChartBusinessVisibility(map, layers);
  },
  { deep: true },
);
defineExpose<ChartMapControls>({
  interactionState: () => ({
    ready: ready.value,
    moving: moving.value,
    drawing: drawMode.value !== 'cancel',
  }),
  currentBounds,
  resetView: () => map?.fitBounds(chartHomeBounds, { padding: 30, maxZoom: 8 }),
  zoomIn: () => map?.zoomIn(),
  zoomOut: () => map?.zoomOut(),
  locateIntelligence,
  focusGeometry: (geometry) => {
    const bounds = intelligenceFeatureBounds([{ geometry }]);
    if (bounds) map?.fitBounds(bounds, { padding: 70, maxZoom: 10 });
  },
  draw,
  editGeometry,
});
watch(
  () => props.evidence,
  (result) => {
    updateEvidence();
    if (!result || !map) return;
    const [w, s, e, n] = result.bbox;
    map.fitBounds(
      [
        [w, s],
        [w > e ? e + 360 : e, n],
      ],
      { padding: 70, maxZoom: 11 },
    );
  },
  { deep: true },
);
watch(
  () => props.track,
  (t) => {
    const p = t?.segments.flatMap((s) => s.points)[0];
    if (p) map?.flyTo({ center: [p.lon, p.lat], zoom: 7 });
  },
);
onBeforeUnmount(() => {
  disposed = true;
  drawing?.off('change', publishDrawing);
  drawing?.off('finish', finishDrawing);
  if (drawing?.enabled) {
    drawing.clear();
    drawing.stop();
  }
  drawing = undefined;
  labels.forEach((label) => label.remove());
  labels = [];
  resizeObserver?.disconnect();
  scheduling?.dispose();
  directionPopup?.remove();
  heatmapPopup?.remove();
  map?.remove();
  map = undefined;
});
</script>
<template>
  <div
    ref="mapHost"
    class="sea-map"
    aria-label="AIS 船位地图"
    data-testid="sea-map"
    :data-ready="ready"
    :data-map-initializations="mapInitializations"
    :data-map-instance="mapInstance"
  />
  <div
    v-if="selectingRegion"
    class="agent-region-overlay"
    data-testid="agent-region-overlay"
    tabindex="0"
    aria-label="拖动框选分析区域"
    @pointerdown.stop.prevent="startRegion"
    @pointermove.stop.prevent="moveRegion"
    @pointerup.stop.prevent="finishRegion"
    @pointercancel="
      regionStart = null;
      regionEnd = null;
    "
    @wheel.stop.prevent
    @keydown.stop
    @keydown.esc.stop.prevent="emit('regionCancelled')"
    @click.stop
    @dblclick.stop
  >
    <div v-if="regionStart && regionEnd" class="agent-region-box" :style="regionBox" />
    <div class="agent-region-note" @pointerdown.stop>
      拖动矩形选择分析区域，完成后返回确认<button
        type="button"
        @click.stop="emit('regionCancelled')"
      >
        取消框选
      </button>
    </div>
  </div>
  <div v-if="drawingError" class="map-warning" role="alert">{{ drawingError }}</div>
  <div v-if="mapError" class="map-warning" role="status">{{ mapError }}</div>
  <div
    v-if="evidence && layers?.evidence !== false"
    class="evidence-map-legend"
    data-testid="evidence-map-legend"
  >
    修订 {{ evidence.revision }} · ● 证据点 / 红色轨迹 · 虚线区域为公告适用范围
  </div>
  <div v-if="drawMode !== 'cancel'" class="intelligence-draw-note">
    绘制 {{ drawModeLabel }} · 点选创建，线/面双击结束 · 完成后在详情保存关联<button
      @click="draw('cancel')"
    >
      取消绘制
    </button>
  </div>
  <div class="direction-legend" data-testid="direction-legend">
    <span>▲ 艏向优先 · 缺失时使用对地航向（COG）</span>
    <span>○ 方向未知 · 聚合圆点显示船群</span>
  </div>
  <div class="map-note" data-testid="chart-source-note">
    本地深色底图 · Natural Earth · WGS84<span>本地地理参考</span>
  </div>
</template>
<style scoped>
.agent-region-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  cursor: crosshair;
  touch-action: none;
}
.agent-region-box {
  position: absolute;
  border: 2px solid #5ce9ee;
  background: rgb(26 187 211 / 22%);
  pointer-events: none;
}
.agent-region-note {
  position: absolute;
  top: 12px;
  left: 12px;
  right: 12px;
  width: fit-content;
  padding: 10px;
  background: #082436;
  color: #d8effc;
  border: 1px solid #39b9cc;
  cursor: default;
}
.agent-region-note button {
  margin-left: 12px;
}
.direction-legend {
  position: absolute;
  bottom: 78px;
  left: 12px;
  z-index: 1;
  display: grid;
  gap: 3px;
  padding: 7px 10px;
  color: #9bbbc9;
  font-size: 11px;
  background: rgb(6 24 42 / 88%);
  border: 1px solid #1a5068;
  border-radius: 4px;
  pointer-events: none;
}
.map-note {
  bottom: 28px;
  left: 12px;
  padding: 7px 10px;
  color: #b8d7e3;
  background: rgb(6 24 42 / 88%);
  border: 1px solid #1a5068;
  border-radius: 4px;
  pointer-events: none;
}
.map-note span {
  color: #92aebd;
}
.map-warning {
  z-index: 2;
  color: #f9d198;
  background: #382d25;
  border: 1px solid #9a6435;
}
.evidence-map-legend {
  top: 100px;
  color: #ef9e96;
  background: rgb(6 24 42 / 92%);
}
.sea-map :deep(.maplibregl-popup-content) {
  padding: 10px 13px;
  background: #0a263b;
  color: #d5eef5;
  border: 1px solid #237794;
  border-radius: 5px;
  font-size: 12px;
}
.sea-map :deep(.maplibregl-popup-tip) {
  border-top-color: #0a263b;
}
.sea-map :deep(.maplibregl-ctrl-attrib) {
  color: #acc9d4;
  background: rgb(6 24 42 / 90%);
}
.sea-map :deep(.maplibregl-ctrl-attrib a) {
  color: #8fcdde;
}
</style>

<style scoped>
.intelligence-draw-note {
  position: absolute;
  z-index: 2;
  top: 10px;
  left: 12px;
  padding: 8px 12px;
  background: rgb(6 24 42 / 94%);
  border: 1px solid #396c81;
  color: #c6e9f2;
  font-size: 12px;
}
.intelligence-draw-note {
  top: 48px;
  color: #e9c47f;
}
.intelligence-draw-note button {
  margin-left: 10px;
}
</style>

<style>
.intelligence-feature-label {
  padding: 4px 7px !important;
  background: #0a273a !important;
  color: #cbeaf0 !important;
  border: 1px solid #376d82 !important;
  font-family: inherit;
  font-size: 11px !important;
  white-space: nowrap;
  max-width: 260px;
  text-overflow: ellipsis;
  overflow: hidden;
  opacity: 0.92;
}
</style>

<style>
.intelligence-object-label {
  padding: 3px 5px !important;
  background: #0a273a !important;
  color: #90b2c7 !important;
  border: 1px solid #274c61 !important;
  font-family: inherit;
  font-size: 10px !important;
  white-space: nowrap;
}
</style>
