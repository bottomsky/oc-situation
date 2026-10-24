import type {
  StyleSpecification,
  LayerSpecification,
  HeatmapLayerSpecification,
} from 'maplibre-gl';
import { createOfflineChartStyle } from './chartLayers';
export const chartPalette = {
  dark: { sea: '#081d31', land: '#173745', coast: '#357b89', grid: '#1d5268' },
  light: { sea: '#dcecf1', land: '#f4f2e8', coast: '#789d9d', grid: '#a4c4d0' },
};
interface Resource {
  url?: string;
  status: string;
  attribution?: string;
  source?: string;
  license?: string;
  sourceDataTime?: string;
  coverageNote?: string;
  zoom?: { min: number; max: number };
  records?: number;
}
export interface ChartManifest {
  version: string;
  coverage: number[];
  updatedAt?: string;
  land: Resource;
  ports?: Resource;
  seamarks?: Resource;
  bathymetry?: Resource;
  official?: Resource;
}
export function createManifestStyle(
  theme: 'dark' | 'light',
  manifest?: ChartManifest | null,
): StyleSpecification {
  const style = createOfflineChartStyle();
  const palette = chartPalette[theme];
  if (manifest?.land.status === 'available' && manifest.land.url?.startsWith('/'))
    style.sources['local-land'] = {
      type: 'geojson',
      data: manifest.land.url,
      attribution: manifest.land.attribution,
    };
  style.layers[0]!.paint = { 'background-color': palette.sea };
  style.layers[1]!.paint = { 'fill-color': palette.land };
  style.layers[2]!.paint = {
    'line-color': palette.coast,
    'line-width': ['interpolate', ['linear'], ['zoom'], 0, 0.55, 9, 1.2],
  };
  for (const [key, color] of [
    ['ports', '#cda664'],
    ['seamarks', '#6aabb7'],
  ] as const) {
    const resource = manifest?.[key];
    if (resource?.status !== 'available' || !resource.url?.startsWith('/')) continue;
    style.sources[key] = { type: 'geojson', data: resource.url, attribution: resource.attribution };
    style.layers.push({
      id: `base-${key}`,
      type: 'circle',
      source: key,
      minzoom: key === 'ports' ? 5 : 9,
      paint: {
        'circle-radius': key === 'ports' ? 3.5 : 2,
        'circle-color': color,
        'circle-stroke-color': palette.sea,
        'circle-stroke-width': 1,
      },
    });
  }
  return style;
}
interface ProbabilityCell {
  id: string;
  probability: number;
  geometry: GeoJSON.Polygon;
}
export interface PredictionMapResult {
  status?: 'ready' | 'insufficient_data' | 'model_not_applicable';
  mmsi?: string;
  horizons: {
    minutes: number;
    gridSizeMeters?: number;
    positionCells: ProbabilityCell[];
    passageCells: ProbabilityCell[];
    coverage: { level: number; probability: number; geometry: GeoJSON.MultiPolygon }[];
  }[];
}
/** Boundary edges shared by adjacent equal-sized grid cells cancel pairwise. */
export function coverageOutline(geometry: GeoJSON.MultiPolygon): GeoJSON.MultiLineString {
  const edges = new Map<string, number[][]>();
  const coordinateKey = (p: number[]) => p.map((n) => n.toFixed(7)).join(',');
  for (const polygon of geometry.coordinates)
    for (const ring of polygon)
      for (let i = 1; i < ring.length; i++) {
        const a = ring[i - 1]!,
          b = ring[i]!,
          ak = coordinateKey(a),
          bk = coordinateKey(b);
        const key = ak < bk ? `${ak}|${bk}` : `${bk}|${ak}`;
        if (edges.has(key)) edges.delete(key);
        else edges.set(key, [a, b]);
      }
  return { type: 'MultiLineString', coordinates: [...edges.values()] };
}
export function predictionGeoJson(
  result: PredictionMapResult | null,
  minutes: number,
  view: 'position' | 'passage',
  levels: number[] = [0.5, 0.8, 0.95],
): GeoJSON.FeatureCollection {
  if (result?.status && result.status !== 'ready')
    return { type: 'FeatureCollection', features: [] };
  const horizon = result?.horizons.find((h) => h.minutes === minutes);
  if (!horizon) return { type: 'FeatureCollection', features: [] };
  const cells = view === 'position' ? horizon.positionCells : horizon.passageCells;
  const maximum =
    view === 'position' ? Math.max(...cells.map((c) => c.probability), Number.EPSILON) : 1;
  return {
    type: 'FeatureCollection',
    features: [
      ...cells.map((cell) => ({
        type: 'Feature' as const,
        properties: {
          id: cell.id,
          probability: cell.probability,
          intensity: cell.probability / maximum,
          kind: 'cell',
        },
        geometry: cell.geometry,
      })),
      ...(view === 'position'
        ? horizon.coverage
            .filter((c) => levels.includes(c.level))
            .map((c) => ({
              type: 'Feature' as const,
              properties: { level: c.level, probability: c.probability, kind: 'coverage' },
              geometry: coverageOutline(c.geometry),
            }))
        : []),
    ],
  };
}
export function predictionDensityGeoJson(
  result: PredictionMapResult | null,
  minutes: number,
  view: 'position' | 'passage',
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  if (result?.status && result.status !== 'ready')
    return { type: 'FeatureCollection', features: [] };
  const horizon = result?.horizons.find((h) => h.minutes === minutes);
  const cells = (view === 'position' ? horizon?.positionCells : horizon?.passageCells) ?? [];
  return {
    type: 'FeatureCollection',
    features: cells
      .filter((cell) => cell.probability > 0)
      .map((cell) => {
        const ring = cell.geometry.coordinates[0]!;
        const a = ring[0]!,
          b = ring[2]!;
        const lon = ((a[0]! + (((b[0]! - a[0]! + 540) % 360) - 180) / 2 + 540) % 360) - 180;
        return {
          type: 'Feature',
          properties: {
            id: cell.id,
            probability: cell.probability,
            gridSizeMeters: horizon?.gridSizeMeters ?? 1000,
          },
          geometry: { type: 'Point', coordinates: [lon, (a[1]! + b[1]!) / 2] },
        };
      }),
  };
}
export function predictionDensityPaint(
  result: PredictionMapResult | null,
  minutes: number,
  view: 'position' | 'passage',
): HeatmapLayerSpecification['paint'] {
  const data = predictionDensityGeoJson(result, minutes, view);
  const maximum = Math.max(0, ...data.features.map((f) => Number(f.properties?.probability)));
  const latitude = data.features[0]?.geometry.coordinates[1] ?? 34;
  const meters = Number(data.features[0]?.properties?.gridSizeMeters ?? 1000);
  const factor =
    (meters / (156543.03392 * Math.max(0.05, Math.cos((latitude * Math.PI) / 180)))) * 1.15;
  const radius = (zoom: number) => Math.max(6, Math.min(96, factor * 2 ** zoom));
  return {
    'heatmap-weight': ['get', 'probability'],
    'heatmap-intensity': maximum > 0 ? 6 / maximum : 1,
    'heatmap-radius': [
      'interpolate',
      ['exponential', 2],
      ['zoom'],
      0,
      radius(0),
      4,
      radius(4),
      8,
      radius(8),
      12,
      radius(12),
      16,
      radius(16),
      20,
      radius(20),
      22,
      radius(22),
    ],
    'heatmap-opacity': 0.82,
    'heatmap-color': [
      'interpolate',
      ['linear'],
      ['heatmap-density'],
      0,
      'rgba(10,65,105,0)',
      0.15,
      'rgba(20,98,156,0.12)',
      0.35,
      'rgba(15,135,184,0.5)',
      0.6,
      'rgba(23,194,211,0.78)',
      0.82,
      'rgba(73,229,224,0.92)',
      1,
      'rgba(169,255,234,0.98)',
    ],
  };
}
export const predictionLayers: LayerSpecification[] = [
  {
    id: 'prediction-density',
    type: 'heatmap',
    source: 'prediction-density',
    paint: predictionDensityPaint(null, 15, 'position'),
  },
  {
    id: 'prediction-cells',
    type: 'fill',
    source: 'prediction',
    filter: ['==', ['get', 'kind'], 'cell'],
    paint: {
      'fill-color': [
        'interpolate',
        ['linear'],
        ['get', 'intensity'],
        0,
        '#17456e',
        0.1,
        '#2079b9',
        0.5,
        '#2cd3df',
        1,
        '#b8fbef',
      ],
      'fill-opacity': 0.001,
      'fill-antialias': false,
    },
  },
  {
    id: 'prediction-coverage',
    type: 'line',
    source: 'prediction',
    filter: ['==', ['get', 'kind'], 'coverage'],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': [
        'interpolate',
        ['linear'],
        ['get', 'level'],
        0.5,
        '#a4f6e7',
        0.8,
        '#4dc3d4',
        0.95,
        '#3990bd',
      ],
      'line-width': ['interpolate', ['linear'], ['get', 'level'], 0.5, 2, 0.8, 1.4, 0.95, 1],
      'line-dasharray': [3, 2],
      'line-opacity': 0.8,
    },
  },
];
