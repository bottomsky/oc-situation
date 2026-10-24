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
import { configureMapLibreWorker } from '../utils/mapLibreWorker';
import type { GeoJSONSource, Map as GLMap } from 'maplibre-gl';
import type {
  Bbox,
  MapResponse,
  MapPoint,
  TrackResponse,
  PositionObservation,
  AnalysisResult,
} from '@ais/contracts';
import { vesselMarkerProperties, vesselSymbolLayout } from '../utils/vesselMarkers';
import { createVesselPointRenderer } from '../utils/vesselPointRendering';
import {
  distanceNm,
  graticule,
  trackPresentation,
  queryRegionGeoJson,
} from '../utils/chartGeometry';
import {
  createManifestStyle,
  createRegionalChartCoverage,
  applyChartTheme,
  predictionGeoJson,
  predictionDensityGeoJson,
  predictionDensityPaint,
  predictionLayers,
  type ChartManifest,
  type PredictionMapResult,
} from '../utils/chartPresentation';
import { registerChartBusinessLayers } from '../utils/chartBusinessLayers';
import {
  addOnlineChartStyle,
  applyOnlineChartTheme,
  readOnlineChartConfig,
} from '../utils/onlineChartStyle';
import { createOnlineChartCoverage, type OnlineChartState } from '../utils/onlineChartState';
import { createOnlineChartRequests } from '../utils/onlineChartRequests';
import {
  heatmapGeoJson,
  registerHeatmapLayers,
  heatmapViewportBounds,
  heatmapCellAt,
  registerCurrentDensityLayer,
} from '../utils/heatmapMap';
import { registerVesselTracksLayers, vesselTracksGeoJson } from '../utils/vesselTracksMap';
import type { VesselTracksResult, HeatmapResult } from '@ais/contracts';
import type { ChartLayerVisibility, ChartMapControls, ChartVesselHighlight } from '../types/chart';
import type { MapCameraRequest, MapCameraResult } from '@ais/contracts';
import { cameraError, cameraPadding, createMapCamera } from '../utils/mapCamera';
import { createSourceRenderAcknowledgements } from '../utils/mapSourceRender';
import {
  createHighlightAnimation,
  createHighlightTimeline,
  highlightGeoJson,
  registerVesselHighlightLayers,
} from '../utils/vesselHighlightsMap';
import {
  applyChartBusinessVisibility,
  chartHomeBounds,
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
  currentDensity?: boolean;
  vesselTracks?: VesselTracksResult | null;
  vesselHighlights?: ChartVesselHighlight[];
  prediction?: PredictionMapResult | null;
  predictionMinutes?: number;
  predictionObservation?: MapPoint | null;
  predictionView?: 'position' | 'passage';
  predictionLevels?: number[];
  vesselNames?: Record<string, string>;
  queryBounds?: Bbox | null;
  predictionImpacts?: {
    warningId: string;
    probability: number;
    geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  }[];
}>();
const emit = defineEmits<{
  viewport: [bbox: Bbox, zoom: number];
  select: [mmsi: string];
  intelligence: [eventIds: string[]];
  object: [objectId: string];
  geometry: [geometry: unknown];
  regionSelected: [bbox: Bbox];
  regionCancelled: [];
  areaQuery: [bbox: Bbox | null];
  heatmapDisplayed: [result: HeatmapResult];
  vesselTracksDisplayed: [result: VesselTracksResult];
  vesselHighlightsDisplayed: [targets: ChartVesselHighlight[]];
}>();
const host = useTemplateRef<HTMLElement>('mapHost');
const mapError = ref('');
const ready = ref(false);
const moving = ref(false);
const renderedVessels = ref(0);
const renderedOnlineLabels = ref(0);
const onlineLabelSample = ref('');
const onlineLabelAnchor = ref('');
const renderedPrediction = ref(0);
const predictionDisplayedMinutes = ref(0);
const predictionOrigin = ref<MapPoint | null>(null);
let predictionProbeCoordinates: number[][] = [];
let predictionOriginLabel: maplibregl.Marker | undefined;
const vesselSourceLoaded = ref(false);
const sourceVesselIdentities = ref(0);
const diagnosticsEnabled =
  import.meta.client && new URLSearchParams(location.search).get('mapDiagnostics') === '1';
let vesselDataRevision = 0;
let countedRevision = -1;
let countingSource = false;
const vesselRenderer = createVesselPointRenderer();
const chartTheme = ref<'dark' | 'light'>('dark');
const manifest = ref<ChartManifest | null>(null);
const localSourceState = ref('正在读取图源清单');
const onlineConfig = readOnlineChartConfig(useRuntimeConfig().public, (message) =>
  console.warn(message),
);
const onlineState = ref<OnlineChartState>({
  base: onlineConfig.enabled ? 'loading' : 'disabled',
  seamarks: onlineConfig.seamarksEnabled ? 'loading' : 'disabled',
  baseRetriesRemaining: 2,
  seamarkRetriesRemaining: 2,
});
const sourceState = computed(() => {
  const base = {
    loading: '在线底图载入中',
    ready: '在线底图已就绪',
    fallback: '在线底图暂不可用，使用本地背景',
    disabled: '',
  }[onlineState.value.base];
  const seamarks = {
    loading: '在线海标载入中',
    ready: '在线海标已就绪',
    fallback: '在线海标暂无或加载失败',
    disabled: '',
  }[onlineState.value.seamarks];
  return [base, seamarks, localSourceState.value].filter(Boolean).join(' · ');
});
const coordinates = ref('WGS84 · 移动光标查看经纬度');
const measure = ref(false);
const measurePoints = ref<number[][]>([]);
const measureDistance = computed(() =>
  measurePoints.value.reduce(
    (total, p, i) => (i ? total + distanceNm(measurePoints.value[i - 1]!, p) : 0),
    0,
  ),
);
const trackColorMode = ref<'time' | 'speed'>('time');
const showGraticule = ref(true);
const showNames = ref(false);
const queryingRegion = ref(false);
let vesselLabels: maplibregl.Marker[] = [];
let ports: GeoJSON.Feature<GeoJSON.Point>[] = [];
let portLabels: maplibregl.Marker[] = [];
function updatePortLabels() {
  portLabels.forEach((label) => label.remove());
  portLabels = [];
  if (
    !map ||
    map.getZoom() < 5 ||
    (map.getLayer('online-background') &&
      map.getPaintProperty('online-background', 'background-opacity') === 1)
  )
    return;
  const occupied = new Set<string>();
  for (const port of ports) {
    const name = port.properties?.['name:zh'] || port.properties?.name;
    if (!name || !map.getBounds().contains(port.geometry.coordinates as [number, number])) continue;
    const projected = map.project(port.geometry.coordinates as [number, number]);
    const key = `${Math.floor(projected.x / 120)}:${Math.floor(projected.y / 40)}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    const node = document.createElement('span');
    node.className = 'port-map-label';
    node.textContent = String(name);
    portLabels.push(
      new maplibregl.Marker({ element: node, anchor: 'top-left', offset: [5, 4] })
        .setLngLat(port.geometry.coordinates as [number, number])
        .addTo(map),
    );
    if (portLabels.length >= (map.getZoom() < 7 ? 24 : 80)) break;
  }
}
function updateVesselLabels() {
  vesselLabels.forEach((label) => label.remove());
  vesselLabels = [];
  if (!map || !showNames.value || map.getZoom() < 7) return;
  for (const vessel of (props.data?.items ?? [])
    .filter((v) => v.kind === 'point' && map!.getBounds().contains([v.lon, v.lat]))
    .slice(0, 80)) {
    if (vessel.kind !== 'point') continue;
    const node = document.createElement('span');
    node.className = 'vessel-map-label';
    node.textContent = props.vesselNames?.[vessel.mmsi]
      ? `${props.vesselNames[vessel.mmsi]} · ${vessel.mmsi}`
      : vessel.mmsi;
    vesselLabels.push(
      new maplibregl.Marker({ element: node, anchor: 'left', offset: [10, 0] })
        .setLngLat([vessel.lon, vessel.lat])
        .addTo(map),
    );
  }
}
function updateMeasure() {
  const source = map?.getSource('measure') as GeoJSONSource | undefined;
  source?.setData({
    type: 'FeatureCollection',
    features:
      measurePoints.value.length > 1
        ? [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: measurePoints.value },
            },
          ]
        : [],
  });
}
function updatePrediction() {
  updatePredictionOrigin();
  (map?.getSource('prediction-risk') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: (props.predictionImpacts ?? [])
      .filter((v) => v.geometry && v.probability > 0)
      .map((v) => ({
        type: 'Feature',
        properties: { warningId: v.warningId, probability: v.probability },
        geometry: v.geometry!,
      })),
  });
  const predictionSource = map?.getSource('prediction') as GeoJSONSource | undefined;
  if (!predictionSource) return;
  const minutes = props.predictionMinutes ?? 15;
  predictionDisplayedMinutes.value = 0;
  const data = predictionGeoJson(
    props.prediction ?? null,
    props.predictionMinutes ?? 15,
    props.predictionView ?? 'position',
    props.predictionLevels,
  );
  const density = predictionDensityGeoJson(
    props.prediction ?? null,
    minutes,
    props.predictionView ?? 'position',
  );
  predictionProbeCoordinates = [...density.features]
    .sort((a, b) => Number(b.properties?.probability) - Number(a.properties?.probability))
    .slice(0, 9)
    .map((f) => f.geometry.coordinates);
  const densitySource = map?.getSource('prediction-density') as GeoJSONSource | undefined;
  const paint = predictionDensityPaint(
    props.prediction ?? null,
    minutes,
    props.predictionView ?? 'position',
  );
  if (map?.getLayer('prediction-density') && paint) {
    map.setPaintProperty('prediction-density', 'heatmap-radius', paint['heatmap-radius']);
    map.setPaintProperty('prediction-density', 'heatmap-intensity', paint['heatmap-intensity']);
  }
  sourceAcknowledgements?.update(
    'prediction',
    async () => {
      await Promise.all([predictionSource.setData(data), densitySource?.setData(density)]);
    },
    () => {
      predictionDisplayedMinutes.value = minutes;
    },
  );
}
function updatePredictionOrigin() {
  const mmsi = props.prediction?.mmsi;
  if (!mmsi) {
    predictionOrigin.value = null;
    predictionOriginLabel?.remove();
    predictionOriginLabel = undefined;
  } else {
    const point =
      props.predictionObservation ??
      props.data?.items.find(
        (item): item is MapPoint => item.kind === 'point' && item.mmsi === mmsi,
      );
    if (point) predictionOrigin.value = point;
    else if (predictionOrigin.value?.mmsi !== mmsi) predictionOrigin.value = null;
  }
  const point = predictionOrigin.value;
  if (!point) {
    predictionOriginLabel?.remove();
    predictionOriginLabel = undefined;
  }
  (map?.getSource('prediction-origin') as GeoJSONSource | undefined)?.setData({
    type: 'FeatureCollection',
    features: point
      ? [
          {
            type: 'Feature',
            properties: { ...point, ...vesselMarkerProperties(point) },
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
          },
        ]
      : [],
  });
  if (point && map) {
    if (!predictionOriginLabel) {
      const node = document.createElement('span');
      node.className = 'prediction-origin-label';
      node.textContent = `最近已载入观测 · ${point.mmsi}`;
      predictionOriginLabel = new maplibregl.Marker({
        element: node,
        anchor: 'top-left',
        offset: [13, 8],
      })
        .setLngLat([point.lon, point.lat])
        .addTo(map);
    } else predictionOriginLabel.setLngLat([point.lon, point.lat]);
    predictionOriginLabel.getElement().textContent = props.predictionObservation
      ? `固定预测输入 · ${point.mmsi} · ${dateLabel(point.observedAt)}`
      : `最近已载入观测 · ${point.mmsi}`;
  }
}
function updateQueryBounds() {
  (map?.getSource('query-region') as GeoJSONSource | undefined)?.setData(
    queryRegionGeoJson(props.queryBounds ?? null),
  );
}
function applyTheme() {
  if (!map) return;
  applyChartTheme(map, chartTheme.value);
  applyOnlineChartTheme(map, chartTheme.value);
}
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
  const selected: Bbox =
    se.lng - nw.lng >= 360
      ? [-180, Math.max(-90, se.lat), 180, Math.min(90, nw.lat)]
      : [wrap(nw.lng), Math.max(-90, se.lat), wrap(se.lng), Math.min(90, nw.lat)];
  if (queryingRegion.value && !props.selectingRegion) {
    queryingRegion.value = false;
    emit('areaQuery', selected);
  } else emit('regionSelected', selected);
}
watch(
  () => props.selectingRegion,
  () => {
    regionStart.value = null;
    regionEnd.value = null;
  },
);
let map: GLMap | undefined;
const focusRenderListeners = new Set<() => void>();
function notifyFocusRender() {
  for (const listener of focusRenderListeners) listener();
}
let camera: ReturnType<typeof createMapCamera> | undefined;
let sourceAcknowledgements: ReturnType<typeof createSourceRenderAcknowledgements> | undefined;
let regionalChartCoverage: ReturnType<typeof createRegionalChartCoverage> | undefined;
let onlineChartCoverage: ReturnType<typeof createOnlineChartCoverage> | undefined;
let onlineChartRequests: ReturnType<typeof createOnlineChartRequests> | undefined;
let highlightAnimation: ReturnType<typeof createHighlightAnimation> | undefined;
const highlightTimeline = createHighlightTimeline();
let highlightSourceSignature = '';
let reducedMotion: MediaQueryList | undefined;
let automaticCameraAllowed = true;
let reserveFocusReply = false;
let cameraRevision = 0;
function visibleCameraPadding() {
  const view = host.value!.getBoundingClientRect();
  const overlays = [
    ...document.querySelectorAll<HTMLElement>(
      '.chart-panel, .chart-agent-input, .chart-input-bar, .chart-agent-dock',
    ),
  ]
    .filter(
      (element) =>
        element.getClientRects().length &&
        getComputedStyle(element).visibility !== 'hidden' &&
        !element.closest('[inert]'),
    )
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const side = element.closest('#chart-left-slot')
        ? ('left' as const)
        : element.closest('#chart-right-slot')
          ? ('right' as const)
          : undefined;
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        side,
        gap: element.classList.contains('chart-agent-dock') ? 8 : undefined,
      };
    });
  const padding = cameraPadding(view, overlays);
  if (reserveFocusReply && view.width - padding.left - padding.right >= 640)
    padding.right = Math.min(padding.right + 384, view.width - padding.left - 160);
  return padding;
}
function applyCamera(
  request: MapCameraRequest & { commandId?: string },
  signal?: AbortSignal,
): Promise<MapCameraResult> {
  automaticCameraAllowed = false;
  cameraRevision++;
  if (!camera || !ready.value) return Promise.reject(cameraError('地图尚未就绪', 'UNAVAILABLE'));
  if (drawMode.value !== 'cancel' || props.selectingRegion)
    return Promise.reject(cameraError('地图正在绘图或框选', 'STATE_CONFLICT'));
  return camera.apply(request, request.commandId ?? crypto.randomUUID(), signal);
}
function localCamera(request: MapCameraRequest) {
  cameraRevision++;
  if (camera) void camera.apply(request, crypto.randomUUID()).catch(() => {});
}
function interruptCamera() {
  automaticCameraAllowed = false;
  cameraRevision++;
  camera?.interrupt();
}
function cameraIntent(options?: { reserveReply?: boolean }): (request: MapCameraRequest) => void {
  automaticCameraAllowed = false;
  const revision = ++cameraRevision;
  camera?.interrupt();
  return (request) => {
    if (
      disposed ||
      revision !== cameraRevision ||
      drawMode.value !== 'cancel' ||
      props.selectingRegion
    )
      return;
    reserveFocusReply = options?.reserveReply ?? false;
    try {
      localCamera(request);
    } finally {
      reserveFocusReply = false;
    }
  };
}
function updateAnimationState() {
  highlightAnimation?.update({
    active: !!props.vesselHighlights?.length,
    hidden: document.hidden,
    reduced: reducedMotion?.matches ?? false,
  });
}
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
    if (bounds)
      localCamera({
        mode: 'bounds',
        bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
        maxZoom: 11,
      });
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
  if (bounds) {
    automaticCameraAllowed = false;
    localCamera({
      mode: 'bounds',
      bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
      maxZoom: 11,
    });
  }
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
  updatePredictionOrigin();
  directionPopup?.remove();
  const changes = vesselRenderer.update(props.data?.items ?? []);
  if (changes) vesselDataRevision++;
  const source = map.getSource('vessels') as GeoJSONSource;
  if (changes?.kind === 'replace') void source.setData(changes.data);
  else if (changes?.kind === 'delta') void source.updateData(changes.diff);
  (map.getSource('track') as GeoJSONSource | undefined)?.setData({
    ...trackPresentation(
      props.track?.segments.map((s) => ({ mmsi: props.track!.mmsi, points: s.points })) ?? [],
      trackColorMode.value,
    ),
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
  updateVesselLabels();
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
  (map.getSource('evidence-track') as GeoJSONSource).setData(
    trackPresentation(
      [...groups].map(([mmsi, group]) => ({
        mmsi,
        points: group
          .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
          .map((p) => ({ lon: p.longitude, lat: p.latitude, observedAt: p.occurredAt })),
      })),
      trackColorMode.value,
    ),
  );
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
  vesselRenderer.reset();
  registerHeatmapLayers(map);
  updateHeatmap();
  registerVesselTracksLayers(map);
  updateVesselTracks();
  registerChartBusinessLayers(map, grid);
  registerCurrentDensityLayer(map);
  updateCurrentDensity();
  map.setLayerZoomRange('vessels', 7, 24);
  map.setPaintProperty('vessels', 'icon-opacity', ['case', ['get', 'stale'], 0.45, 1]);
  for (const [source, line] of [
    ['track', 'tracks'],
    ['evidence-track', 'evidence-tracks'],
    ['ais-history-tracks', 'ais-history-tracks'],
  ]) {
    map.addLayer(
      {
        id: line + '-casing',
        type: 'line',
        source: source!,
        filter: [
          'all',
          ['==', ['geometry-type'], 'LineString'],
          ['!=', ['get', 'kind'], 'direction'],
        ],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#071b2a', 'line-width': 3.1, 'line-opacity': 0.7 },
      },
      line,
    );
    map.addLayer({
      id: line + '-arrows',
      type: 'symbol',
      source: source!,
      minzoom: 7,
      filter: ['==', ['get', 'kind'], 'direction'],
      layout: {
        'symbol-placement': 'line',
        'symbol-spacing': 120,
        'icon-image': 'vessel-live-direction',
        'icon-size': 0.38,
        'icon-rotate': 90,
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': false,
      },
      paint: { 'icon-opacity': 0.75 },
    });
  }
  map.addSource('prediction', { type: 'geojson', data: predictionGeoJson(null, 15, 'position') });
  map.addSource('prediction-density', {
    type: 'geojson',
    data: predictionDensityGeoJson(null, 15, 'position'),
  });
  for (const layer of predictionLayers) map.addLayer(layer);
  map.addSource('query-region', {
    type: 'geojson',
    data: queryRegionGeoJson(props.queryBounds ?? null),
  });
  map.addLayer({
    id: 'query-region-fill',
    type: 'fill',
    source: 'query-region',
    paint: { 'fill-color': '#31bfce', 'fill-opacity': 0.05 },
  });
  map.addLayer({
    id: 'query-region-line',
    type: 'line',
    source: 'query-region',
    paint: { 'line-color': '#60d3df', 'line-width': 1.5, 'line-dasharray': [4, 2] },
  });
  map.addSource('prediction-risk', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'prediction-risk-fill',
    type: 'fill',
    source: 'prediction-risk',
    paint: { 'fill-color': '#f0b758', 'fill-opacity': 0.13 },
  });
  map.addLayer({
    id: 'prediction-risk-line',
    type: 'line',
    source: 'prediction-risk',
    layout: { 'line-join': 'round' },
    paint: { 'line-color': '#e8ad54', 'line-width': 1.6, 'line-dasharray': [4, 2] },
  });
  map.addSource('prediction-origin', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'prediction-origin-halo',
    type: 'circle',
    source: 'prediction-origin',
    paint: {
      'circle-radius': 12,
      'circle-color': '#146075',
      'circle-opacity': 0.16,
      'circle-stroke-color': '#8aeee1',
      'circle-stroke-width': 1.2,
    },
  });
  map.addLayer({
    id: 'prediction-origin-marker',
    type: 'symbol',
    source: 'prediction-origin',
    layout: { ...vesselSymbolLayout, 'icon-size': 1.2 },
  });
  map.addSource('measure', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'measure',
    type: 'line',
    source: 'measure',
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: { 'line-color': '#f0be70', 'line-width': 2, 'line-dasharray': [3, 2] },
  });
  map.addLayer({
    id: 'vessels-distant',
    type: 'circle',
    source: 'vessels',
    maxzoom: 7,
    filter: ['==', ['get', 'kind'], 'point'],
    paint: {
      'circle-radius': 2.2,
      'circle-color': ['case', ['get', 'sample'], '#c1762a', '#21dfc8'],
      'circle-stroke-color': '#082334',
      'circle-stroke-width': 0.5,
    },
  });
  for (const [source, id] of [
    ['track', 'track-stops'],
    ['evidence-track', 'evidence-stops'],
    ['ais-history-tracks', 'history-stops'],
  ])
    map.addLayer({
      id: id!,
      type: 'circle',
      source: source!,
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': ['match', ['get', 'role'], 'start', 3, 'end', 4, 2.5],
        'circle-color': ['coalesce', ['get', 'color'], '#65d4e0'],
        'circle-stroke-color': '#082334',
        'circle-stroke-width': 1.2,
      },
    });
  updatePrediction();
  applyChartBusinessVisibility(map, props.layers);
  registerIntelligenceLayers(map);
  registerVesselHighlightLayers(map);
  highlightSourceSignature = '';
  updateVesselHighlights();
  updateIntelligence();
  update();
  ready.value = true;
  map?.off('render', notifyFocusRender);
  map?.on('render', notifyFocusRender);
  scheduling?.viewport();
}
function updateVesselTracks() {
  const source = map?.getSource('ais-history-tracks') as GeoJSONSource | undefined;
  if (!source) return;
  const snapshot = props.vesselTracks;
  sourceAcknowledgements?.update(
    'ais-history-tracks',
    () =>
      source.setData(
        snapshot
          ? trackPresentation(
              snapshot.tracks.flatMap((t) =>
                t.segments.map((s) => ({ mmsi: t.mmsi, points: s.points })),
              ),
              trackColorMode.value,
            )
          : vesselTracksGeoJson(null),
      ),
    () => {
      if (snapshot)
        if (props.vesselTracks === snapshot && map?.getLayer('ais-history-tracks'))
          emit('vesselTracksDisplayed', snapshot);
    },
  );
}
function updateHeatmap() {
  heatmapPopup?.remove();
  heatmapPopupOpen.value = false;
  const source = map?.getSource('ais-heatmap') as GeoJSONSource | undefined;
  if (!source) return;
  const snapshot = props.heatmap;
  sourceAcknowledgements?.update(
    'ais-heatmap',
    () => source.setData(heatmapGeoJson(snapshot ?? null)),
    () => {
      if (snapshot)
        if (props.heatmap === snapshot && map?.getLayer('ais-heatmap'))
          emit('heatmapDisplayed', snapshot);
    },
  );
}
function updateCurrentDensity() {
  if (map?.getLayer('ais-current-density'))
    map.setLayoutProperty(
      'ais-current-density',
      'visibility',
      props.currentDensity && props.layers?.ais !== false ? 'visible' : 'none',
    );
}
function updateVesselHighlights() {
  const source = map?.getSource('vessel-highlights') as GeoJSONSource | undefined;
  if (!source) return;
  const targets = props.vesselHighlights ?? [];
  const signature = JSON.stringify(
    targets.map((target) => [
      target.mmsi,
      target.lon,
      target.lat,
      target.effectId,
      target.headingDegrees,
      target.cogDegrees,
    ]),
  );
  if (signature === highlightSourceSignature) {
    // Position metadata may refresh without a coordinate change. Confirm the
    // current snapshot only after another actual frame; never rewrite its data.
    sourceAcknowledgements?.update(
      'vessel-highlights',
      () => Promise.resolve(),
      () => {
        if ((props.vesselHighlights ?? targets) === targets)
          emit('vesselHighlightsDisplayed', targets);
      },
    );
  } else {
    highlightSourceSignature = signature;
    const data = highlightGeoJson(targets, highlightTimeline, highlightAnimation?.now() ?? 0);
    highlightAnimation?.targets(
      data.features.map((feature) => ({
        mmsi: feature.properties.mmsi,
        startedAt: feature.properties.startedAt,
      })),
    );
    sourceAcknowledgements?.update(
      'vessel-highlights',
      () => source.setData(data),
      () => {
        if ((props.vesselHighlights ?? targets) === targets)
          emit('vesselHighlightsDisplayed', targets);
      },
    );
  }
  updateAnimationState();
}
onMounted(async () => {
  await nextTick();
  if (disposed || !host.value) return;
  try {
    try {
      const response = await fetch('/maps/maritime/manifest.json');
      if (!response.ok) throw new Error('图源清单暂不可用');
      manifest.value = (await response.json()) as ChartManifest;
      if (manifest.value.ports?.status === 'available' && manifest.value.ports.url?.startsWith('/'))
        void fetch(manifest.value.ports.url)
          .then((response) => {
            if (!response.ok) throw new Error('港口资源读取失败');
            return response.json();
          })
          .then((data: GeoJSON.FeatureCollection<GeoJSON.Point>) => {
            if (disposed) return;
            ports = data.features;
            updatePortLabels();
          })
          .catch(() => {
            localSourceState.value += ' · 港口标注读取失败';
          });
      localSourceState.value = `资源 ${manifest.value.version} · 全球概略背景 · 区域细节载入中`;
    } catch {
      localSourceState.value = '基础地理参考 · 图源清单未接入';
    }
    if (disposed || !host.value) return;
    configureMapLibreWorker();
    onlineChartRequests = createOnlineChartRequests(maplibregl);
    map = new maplibregl.Map({
      container: host.value,
      style: onlineChartRequests.wrapStyle(
        addOnlineChartStyle(
          createManifestStyle(chartTheme.value, manifest.value),
          chartTheme.value,
          onlineConfig,
        ),
      ),
      bounds: chartHomeBounds,
      minZoom: 0,
      maxZoom: 22,
      fitBoundsOptions: { padding: 30, maxZoom: 8 },
      attributionControl: { compact: true },
    });
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 140, unit: 'nautical' }),
      'bottom-right',
    );
    map.on('idle', () => {
      vesselSourceLoaded.value = !!map?.getSource('vessels') && map.isSourceLoaded('vessels');
      if (!diagnosticsEnabled) return;
      const onlineLabels = map?.getLayer('online-place-labels')
        ? map.queryRenderedFeatures({ layers: ['online-place-labels'] })
        : [];
      renderedOnlineLabels.value = onlineLabels.length;
      onlineLabelSample.value = String(onlineLabels[0]?.properties?.name ?? '');
      const labelGeometry = onlineLabels[0]?.geometry;
      if (labelGeometry?.type === 'Point') {
        const point = map!.project(labelGeometry.coordinates as [number, number]);
        onlineLabelAnchor.value = `${point.x},${point.y}`;
      } else onlineLabelAnchor.value = '';
      const layers = ['vessels', 'vessels-distant'].filter((id) => map?.getLayer(id));
      const canvas = map!.getCanvas();
      const sample = (ids: string[]) =>
        ids.length
          ? [0.25, 0.5, 0.75].flatMap((x) =>
              [0.25, 0.5, 0.75].flatMap((y) =>
                map!.queryRenderedFeatures(
                  [
                    [canvas.clientWidth * x - 8, canvas.clientHeight * y - 8],
                    [canvas.clientWidth * x + 8, canvas.clientHeight * y + 8],
                  ],
                  { layers: ids },
                ),
              ),
            ).length
          : 0;
      renderedVessels.value = sample(layers);
      renderedPrediction.value = map?.getLayer('prediction-cells')
        ? predictionProbeCoordinates.reduce((count, coordinate) => {
            const p = map!.project(coordinate as [number, number]);
            return (
              count +
              map!.queryRenderedFeatures(
                [
                  [p.x - 2, p.y - 2],
                  [p.x + 2, p.y + 2],
                ],
                { layers: ['prediction-cells'] },
              ).length
            );
          }, 0)
        : 0;
      if (vesselSourceLoaded.value && countedRevision !== vesselDataRevision && !countingSource) {
        const revision = vesselDataRevision;
        countingSource = true;
        void (map!.getSource('vessels') as GeoJSONSource)
          .getData()
          .then((data) => {
            if (disposed || revision !== vesselDataRevision) return;
            if (data.type === 'FeatureCollection')
              sourceVesselIdentities.value = new Set(
                data.features
                  .filter((f) => f.properties?.kind === 'point')
                  .map((f) => String(f.properties?.mmsi)),
              ).size;
            countedRevision = revision;
          })
          .finally(() => {
            countingSource = false;
            if (!disposed && countedRevision !== vesselDataRevision) map?.triggerRepaint();
          });
      }
    });
    map.on('mousemove', (e) => {
      const p = e.lngLat.wrap();
      coordinates.value = `${Math.abs(p.lng).toFixed(4)}°${p.lng < 0 ? 'W' : 'E'}  ${Math.abs(p.lat).toFixed(4)}°${p.lat < 0 ? 'S' : 'N'}`;
    });
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    camera = createMapCamera(map, visibleCameraPadding, () => reducedMotion?.matches ?? false);
    sourceAcknowledgements = createSourceRenderAcknowledgements(map);
    highlightAnimation = createHighlightAnimation(map, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
    });
    document.addEventListener('visibilitychange', updateAnimationState);
    reducedMotion.addEventListener('change', updateAnimationState);
    const canvas = map.getCanvas();
    canvas.addEventListener('pointerdown', interruptCamera);
    canvas.addEventListener('wheel', interruptCamera, { passive: true });
    canvas.addEventListener('touchstart', interruptCamera, { passive: true });
    canvas.addEventListener('keydown', interruptCamera);
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
      regionalChartCoverage?.dispose();
      regionalChartCoverage = createRegionalChartCoverage(map!, (state) => {
        const detail = {
          loading: '区域细节载入中',
          ready: '区域陆地与海岸线已就绪',
          fallback: '区域细节暂不可用，使用全球概略背景',
        }[state];
        localSourceState.value = `${manifest.value ? `资源 ${manifest.value.version} · ` : ''}全球概略背景 · ${detail}`;
      });
      onlineChartCoverage?.dispose();
      onlineChartCoverage = createOnlineChartCoverage(map!, onlineConfig, (state) => {
        const changed = onlineState.value.base !== state.base;
        onlineState.value = state;
        if (changed) updatePortLabels();
      });
      registerBusinessLayers();
      applyTheme();
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
      if (measure.value) {
        measurePoints.value.push([e.lngLat.wrap().lng, e.lngLat.lat]);
        updateMeasure();
        return;
      }
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
        !map!.queryRenderedFeatures(e.point, { layers: ['vessels', 'vessels-distant', 'clusters'] })
          .length
      ) {
        const cell = heatmapCellAt(props.heatmap, e.lngLat.lng, e.lngLat.lat);
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
      camera?.invalidate();
    });
    map.on('moveend', () => {
      moving.value = false;
      scheduling?.viewport();
      const bounds = currentBounds();
      if (bounds)
        (map?.getSource('grid') as GeoJSONSource | undefined)?.setData(
          graticule(bounds, map!.getZoom()),
        );
      updateVesselLabels();
      updatePortLabels();
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
    const selectVessels = (e: maplibregl.MapLayerMouseEvent) => {
      if (measure.value) return;
      if (drawMode.value !== 'cancel') return;
      if (
        map!.queryRenderedFeatures(e.point, {
          layers: intelligenceLayerIds.filter((id) => map!.getLayer(id)),
        }).length
      )
        return;
      const candidates = [
        ...new Map(
          map!
            .queryRenderedFeatures(
              [
                [e.point.x - 6, e.point.y - 6],
                [e.point.x + 6, e.point.y + 6],
              ],
              { layers: ['vessels', 'vessels-distant'] },
            )
            .filter((f) => f.properties?.kind === 'point')
            .map((f) => [String(f.properties.mmsi), f]),
        ).values(),
      ];
      const p = candidates[0]?.properties;
      if (p?.kind === 'point') {
        const content = document.createElement('div');
        if (candidates.length > 1) {
          const heading = document.createElement('strong');
          heading.textContent = `重叠船舶 · ${candidates.length} 艘`;
          content.append(heading);
          for (const feature of candidates) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'vessel-candidate';
            button.textContent = `${feature.properties.mmsi} · ${feature.properties.directionLabel}`;
            button.onclick = () => {
              emit('select', String(feature.properties.mmsi));
              directionPopup?.remove();
            };
            content.append(button);
          }
        } else {
          emit('select', String(p.mmsi));
          content.textContent = `${p.mmsi} · ${p.directionLabel} · ${p.observedAt}`;
        }
        directionPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        directionPopup.setLngLat(e.lngLat).setDOMContent(content).addTo(map!);
      }
    };
    map.on('click', 'vessels', selectVessels);
    map.on('click', 'vessels-distant', selectVessels);
    for (const id of ['prediction-cells', 'prediction-risk-fill']) {
      map.on('mousemove', id, (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const content = document.createElement('div');
        content.textContent =
          id === 'prediction-cells'
            ? `格网 ${p.id} · ${props.predictionView === 'passage' ? '沿途通过' : '所选时刻位置'}概率 ${(Number(p.probability) * 100).toFixed(3)}%`
            : `适用航警 ${p.warningId} · 相交概率 ${(Number(p.probability) * 100).toFixed(1)}% · 未校准`;
        directionPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        directionPopup.setLngLat(e.lngLat).setDOMContent(content).addTo(map!);
      });
      map.on('mouseleave', id, () => directionPopup?.remove());
    }
    for (const id of [
      'tracks',
      'ais-history-tracks',
      'track-stops',
      'history-stops',
      'evidence-tracks',
    ]) {
      map.on('mouseenter', id, (e) => {
        const p = e.features?.[0]?.properties;
        if (!p) return;
        const node = document.createElement('div');
        node.textContent = `${p.mmsi ?? '轨迹'} · ${p.observedAt ?? ''} · ${p.sogKnots ?? '—'} kn${p.role ? ' · ' + ({ start: '起点', end: '终点', stop: '停留', turn: '转向' } as Record<string, string>)[p.role] : ''}`;
        directionPopup ??= new maplibregl.Popup({ closeButton: false, closeOnClick: false });
        directionPopup.setLngLat(e.lngLat).setDOMContent(node).addTo(map!);
      });
      map.on('mouseleave', id, () => directionPopup?.remove());
    }
    map.on('click', 'clusters', (e) => {
      localCamera({
        mode: 'point',
        center: [e.lngLat.lng, e.lngLat.lat],
        zoom: Math.min(9, map!.getZoom() + 2),
      });
    });
    map.on('click', 'vessel-highlight-marker', (e) => {
      if (drawMode.value === 'cancel' && e.features?.[0]?.properties.mmsi)
        emit('select', String(e.features[0].properties.mmsi));
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
watch(() => [props.data, props.track, props.frame], update);
watch(() => props.heatmap, updateHeatmap);
watch(() => [props.currentDensity, props.layers?.ais], updateCurrentDensity);
watch(() => props.vesselTracks, updateVesselTracks);
watch(
  () => [
    props.prediction,
    props.predictionMinutes,
    props.predictionObservation,
    props.predictionView,
    props.predictionLevels,
    props.predictionImpacts,
  ],
  updatePrediction,
  { deep: true },
);
watch(chartTheme, applyTheme);
watch(showNames, updateVesselLabels);
watch(() => props.vesselNames, updateVesselLabels);
watch(() => props.queryBounds, updateQueryBounds);
watch(showGraticule, (value) => {
  if (map?.getLayer('grid'))
    map.setLayoutProperty('grid', 'visibility', value ? 'visible' : 'none');
});
watch(trackColorMode, () => {
  update();
  updateVesselTracks();
});
watch(() => props.vesselHighlights, updateVesselHighlights, { deep: true });
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
  projectFocus: (point, anchorLongitude) => {
    if (!map || !ready.value) return null;
    const anchor = anchorLongitude ?? point[0];
    const local =
      anchorLongitude === undefined
        ? point[0]
        : anchor + ((((point[0] - anchor + 180) % 360) + 360) % 360) - 180;
    const lon = local + 360 * Math.round((map.getCenter().lng - anchor) / 360);
    return map.project([lon, point[1]]);
  },
  focusViewport: () => {
    if (!map || !host.value || !ready.value) return null;
    const padding = visibleCameraPadding();
    return {
      left: padding.left,
      top: padding.top,
      right: host.value.clientWidth - padding.right,
      bottom: host.value.clientHeight - padding.bottom,
    };
  },
  onFocusRender: (listener) => {
    focusRenderListeners.add(listener);
    return () => focusRenderListeners.delete(listener);
  },
  requestFocusRender: () => {
    map?.triggerRepaint();
  },
  applyCamera,
  currentCamera: () => camera?.current() ?? null,
  cameraState: () => (ready.value ? (camera?.state() ?? null) : null),
  cameraIntent,
  interactionState: () => ({
    ready: ready.value,
    moving: moving.value,
    drawing: drawMode.value !== 'cancel',
  }),
  currentBounds,
  resetView: () => {
    automaticCameraAllowed = false;
    localCamera({
      mode: 'bounds',
      bbox: [
        chartHomeBounds[0][0],
        chartHomeBounds[0][1],
        chartHomeBounds[1][0],
        chartHomeBounds[1][1],
      ],
      maxZoom: 8,
    });
  },
  zoomIn: () => {
    automaticCameraAllowed = false;
    localCamera({ mode: 'current', zoomDelta: 1 });
  },
  zoomOut: () => {
    automaticCameraAllowed = false;
    localCamera({ mode: 'current', zoomDelta: -1 });
  },
  locateIntelligence,
  focusGeometry: (geometry) => {
    const bounds = intelligenceFeatureBounds([{ geometry }]);
    automaticCameraAllowed = false;
    if (geometry.type === 'Point')
      localCamera({ mode: 'point', center: geometry.coordinates as [number, number], zoom: 10 });
    else if (bounds)
      localCamera({
        mode: 'bounds',
        bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
        maxZoom: 13,
      });
  },
  focusPrediction: (geometry) => {
    updatePredictionOrigin();
    const features: { geometry: IntelligenceGeometry }[] = [{ geometry }];
    const origin = predictionOrigin.value;
    if (origin)
      features.push({ geometry: { type: 'Point', coordinates: [origin.lon, origin.lat] } });
    const bounds = intelligenceFeatureBounds(features);
    if (bounds) {
      automaticCameraAllowed = false;
      localCamera({
        mode: 'bounds',
        bbox: [bounds[0][0], bounds[0][1], bounds[1][0], bounds[1][1]],
        maxZoom: 12,
      });
    }
  },
  draw,
  editGeometry,
});
watch(
  () => props.evidence,
  (result) => {
    updateEvidence();
    if (
      !result ||
      !map ||
      !automaticCameraAllowed ||
      drawMode.value !== 'cancel' ||
      props.selectingRegion
    )
      return;
    localCamera({ mode: 'bounds', bbox: result.bbox, maxZoom: 11 });
  },
  { deep: true },
);
watch(
  () => props.track,
  (t) => {
    const p = t?.segments.flatMap((s) => s.points)[0];
    if (p && automaticCameraAllowed && drawMode.value === 'cancel' && !props.selectingRegion)
      localCamera({ mode: 'point', center: [p.lon, p.lat], zoom: 7 });
  },
);
onBeforeUnmount(() => {
  disposed = true;
  camera?.dispose();
  sourceAcknowledgements?.dispose();
  regionalChartCoverage?.dispose();
  onlineChartCoverage?.dispose();
  onlineChartRequests?.dispose();
  highlightAnimation?.dispose();
  highlightTimeline.clear();
  document.removeEventListener('visibilitychange', updateAnimationState);
  reducedMotion?.removeEventListener('change', updateAnimationState);
  const canvas = map?.getCanvas();
  canvas?.removeEventListener('pointerdown', interruptCamera);
  canvas?.removeEventListener('wheel', interruptCamera);
  canvas?.removeEventListener('touchstart', interruptCamera);
  canvas?.removeEventListener('keydown', interruptCamera);
  drawing?.off('change', publishDrawing);
  drawing?.off('finish', finishDrawing);
  if (drawing?.enabled) {
    drawing.clear();
    drawing.stop();
  }
  drawing = undefined;
  labels.forEach((label) => label.remove());
  vesselLabels.forEach((label) => label.remove());
  portLabels.forEach((label) => label.remove());
  labels = [];
  resizeObserver?.disconnect();
  scheduling?.dispose();
  directionPopup?.remove();
  predictionOriginLabel?.remove();
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
    :data-rendered-vessel-sample="renderedVessels"
    :data-source-vessel-identities="sourceVesselIdentities"
    :data-vessel-source-loaded="vesselSourceLoaded"
    :data-rendered-prediction="renderedPrediction"
    :data-moving="moving"
    :data-prediction-displayed="predictionDisplayedMinutes"
    :data-online-chart-state="onlineState.base"
    :data-online-seamarks-state="onlineState.seamarks"
    :data-rendered-online-labels="diagnosticsEnabled ? renderedOnlineLabels : undefined"
    :data-online-label-sample="diagnosticsEnabled ? onlineLabelSample : undefined"
    :data-online-label-anchor="diagnosticsEnabled ? onlineLabelAnchor : undefined"
    :data-prediction-origin-basis="predictionObservation ? 'fixed-input' : 'fleet-fallback'"
    :data-prediction-origin="
      predictionOrigin ? `${predictionOrigin.lon},${predictionOrigin.lat}` : ''
    "
  />
  <div
    v-if="selectingRegion || queryingRegion"
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
    @keydown.esc.stop.prevent="
      queryingRegion = false;
      emit('regionCancelled');
    "
    @click.stop
    @dblclick.stop
  >
    <div v-if="regionStart && regionEnd" class="agent-region-box" :style="regionBox" />
    <div class="agent-region-note" @pointerdown.stop>
      {{ queryingRegion ? '拖动矩形查询区域内船舶' : '拖动矩形选择分析区域，完成后返回确认'
      }}<button
        type="button"
        @click.stop="
          queryingRegion = false;
          emit('regionCancelled');
        "
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
    <span>● 远距单船 · ▲ 艏向 / 对地航向 · ○ 方向未知</span>
    <span>青绿 实测 · 琥珀 合成 · 淡色 超过30分钟</span>
    <span v-if="prediction">青蓝 平滑密度 · 虚线 原始 50 / 80 / 95% 累计覆盖区</span>
  </div>
  <div class="chart-gis-tools" aria-label="海图工具">
    <button
      :aria-pressed="queryingRegion || !!queryBounds"
      @click="
        queryingRegion = true;
        measure = false;
      "
    >
      区域查询
    </button>
    <button v-if="queryBounds" @click="emit('areaQuery', null)">清除区域</button>
    <button
      :aria-pressed="chartTheme === 'light'"
      @click="chartTheme = chartTheme === 'dark' ? 'light' : 'dark'"
    >
      {{ chartTheme === 'dark' ? '浅色海图' : '深色海图' }}
    </button>
    <button :aria-pressed="showGraticule" @click="showGraticule = !showGraticule">经纬网</button>
    <button :aria-pressed="showNames" @click="showNames = !showNames">船舶标识</button>
    <button
      :aria-pressed="measure"
      @click="
        measure = !measure;
        measurePoints = [];
        updateMeasure();
      "
    >
      {{ measure ? '结束测距' : '测距' }}
    </button>
    <button @click="trackColorMode = trackColorMode === 'time' ? 'speed' : 'time'">
      轨迹 · {{ trackColorMode === 'time' ? '时间' : '航速' }}
    </button>
  </div>
  <div v-if="measure" class="chart-measure-note" role="status">
    点选连续测距 · {{ measureDistance.toFixed(2) }} 海里
    <button
      @click="
        measurePoints = [];
        updateMeasure();
      "
    >
      清空
    </button>
  </div>
  <div class="map-note" data-testid="chart-source-note">
    {{ sourceState }} · {{ coordinates
    }}<span v-if="manifest"
      >区域资源覆盖 {{ manifest.coverage.join(' / ') }} ·
      {{ manifest.official?.status === 'available' ? '官方图源已接入' : '官方海图待配置' }}</span
    ><span v-else>Natural Earth · 地理参考</span>
    <span class="chart-online-attribution">
      ©
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer"
        >OpenStreetMap contributors</a
      >
      · ©
      <a href="https://www.openseamap.org/" target="_blank" rel="noopener noreferrer"
        >OpenSeaMap contributors</a
      >
      ·
      <a
        href="https://creativecommons.org/licenses/by-sa/2.0/"
        target="_blank"
        rel="noopener noreferrer"
        >CC BY-SA 2.0</a
      >
    </span>
    <span
      v-if="onlineState.base === 'fallback' || onlineState.seamarks === 'fallback'"
      class="chart-online-retry"
      role="status"
    >
      <button
        v-if="onlineState.base === 'fallback' && onlineState.baseRetriesRemaining"
        @click="onlineChartCoverage?.retry('base')"
      >
        重试在线底图
      </button>
      <button
        v-if="onlineState.seamarks === 'fallback' && onlineState.seamarkRetriesRemaining"
        @click="onlineChartCoverage?.retry('seamarks')"
      >
        重试在线海标
      </button>
      <span
        v-if="
          (onlineState.base === 'fallback' && !onlineState.baseRetriesRemaining) ||
          (onlineState.seamarks === 'fallback' && !onlineState.seamarkRetriesRemaining)
        "
        >暂未恢复，可稍后刷新页面</span
      >
    </span>
    <details v-if="manifest">
      <summary>
        图源与精度 · 港口 {{ manifest.ports?.records ?? 0 }} · 海标
        {{ manifest.seamarks?.status === 'available' ? '已接入' : '待配置' }}
      </summary>
      <p>
        Natural Earth · 全球概略背景<br />{{ manifest.land.attribution }}<br />区域陆地适用缩放
        {{ manifest.land.zoom?.min ?? 0 }}–{{ manifest.land.zoom?.max ?? 9 }} · 更高缩放沿用当前精度
        · 来源时间 {{ manifest.land.sourceDataTime ?? '待确认'
        }}<br />港口为OSM贡献记录的中心标注，支撑地理参考。<br />{{ manifest.land.license }} · WGS84
        · 官方海图 {{ manifest.official?.status ?? 'unconfigured' }}
      </p>
    </details>
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
.chart-gis-tools {
  position: absolute;
  right: 12px;
  top: 12px;
  display: flex;
  gap: 4px;
  z-index: 2;
  flex-wrap: wrap;
  max-width: calc(100% - 24px);
}
.chart-gis-tools button {
  padding: 6px 9px;
  color: #a7c9d7;
  background: #0a2539ef;
  border: 1px solid #23536b;
  border-radius: 3px;
  font-size: 11px;
}
.chart-gis-tools button[aria-pressed='true'] {
  color: #81f0eb;
  border-color: #38a4af;
}
.chart-measure-note {
  position: absolute;
  top: 52px;
  right: 12px;
  padding: 8px 10px;
  background: #142d3a;
  color: #f1cc8b;
  font-size: 12px;
  border: 1px solid #9a7945;
  z-index: 2;
}
.map-note {
  max-width: calc(100% - 190px);
  font-size: 10px;
  display: grid;
  gap: 3px;
}
.agent-region-box {
  position: absolute;
  border: 2px solid #5ce9ee;
  background: rgb(26 187 211 / 22%);
  pointer-events: auto;
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
.map-note details {
  pointer-events: auto;
}
.chart-online-attribution,
.chart-online-retry {
  pointer-events: auto;
}
.chart-online-attribution a {
  color: #8fcdde;
}
.chart-online-retry button {
  margin-right: 8px;
  padding: 3px 6px;
  color: #b8d7e3;
  background: #0a2539;
  border: 1px solid #23536b;
  border-radius: 3px;
  cursor: pointer;
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
.sea-map :deep(.maplibregl-ctrl-attrib.maplibregl-compact) {
  /* Keep the expandable native attribution inside the footer's reserved control column. */
  box-sizing: border-box;
  max-width: 180px;
  max-height: 180px;
  overflow: auto;
  overflow-wrap: anywhere;
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
.vessel-map-label {
  color: #bce7ec;
  font-size: 10px;
  background: #082436ce;
  padding: 2px 4px;
  border-radius: 2px;
  pointer-events: none;
}
.prediction-origin-label {
  color: #a4f3e3;
  font-size: 10px;
  background: #08283ce8;
  border: 1px solid #3d9fa7;
  padding: 4px 6px;
  border-radius: 3px;
  pointer-events: none;
}
.port-map-label {
  color: #cbb47f;
  font-size: 10px;
  background: #092337c9;
  padding: 2px 4px;
  border-radius: 2px;
  max-width: 120px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.vessel-candidate {
  display: block !important;
  color: #bce7ec !important;
  background: transparent !important;
  border: 0 !important;
  padding: 7px 0 !important;
  cursor: pointer;
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
