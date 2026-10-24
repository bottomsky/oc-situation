import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import { chartPalette } from './chartPresentation';

export const ONLINE_VECTOR_SOURCE_ID = 'online-osm';
export const ONLINE_SEAMARK_SOURCE_ID = 'online-seamarks';
export const ONLINE_SEAMARK_LAYER_ID = 'online-seamarks';

type Theme = 'dark' | 'light';
interface OnlineLayerOpacity {
  id: string;
  property: 'background-opacity' | 'fill-opacity' | 'line-opacity' | 'text-opacity';
  readyValue: number;
}

/** Keep the full viewport cover and vector details in one atomic visibility group. */
export const ONLINE_BASE_LAYER_OPACITIES: OnlineLayerOpacity[] = [
  { id: 'online-background', property: 'background-opacity', readyValue: 1 },
  { id: 'online-land', property: 'fill-opacity', readyValue: 0.55 },
  { id: 'online-ocean', property: 'fill-opacity', readyValue: 1 },
  { id: 'online-water', property: 'fill-opacity', readyValue: 1 },
  { id: 'online-waterways', property: 'line-opacity', readyValue: 0.85 },
  { id: 'online-boundaries', property: 'line-opacity', readyValue: 0.5 },
  { id: 'online-roads-minor', property: 'line-opacity', readyValue: 0.5 },
  { id: 'online-roads-major', property: 'line-opacity', readyValue: 0.72 },
  { id: 'online-railways', property: 'line-opacity', readyValue: 0.45 },
  { id: 'online-buildings', property: 'fill-opacity', readyValue: 0.65 },
  { id: 'online-pier-polygons', property: 'fill-opacity', readyValue: 1 },
  { id: 'online-pier-lines', property: 'line-opacity', readyValue: 1 },
  { id: 'online-boundary-labels', property: 'text-opacity', readyValue: 0.7 },
  { id: 'online-place-labels', property: 'text-opacity', readyValue: 1 },
];

const localFonts = ['Microsoft YaHei', 'Noto Sans CJK SC', 'Segoe UI', 'sans-serif'];
const labelName: ExpressionSpecification = ['coalesce', ['get', 'name'], ['get', 'name_en'], ''];

function createOnlineBaseLayers(theme: Theme): LayerSpecification[] {
  const palette = chartPalette[theme];
  const dark = theme === 'dark';
  const colors = {
    green: dark ? '#284b48' : '#d4dfc8',
    sand: dark ? '#4a5143' : '#e6dfc2',
    road: dark ? '#526b70' : '#c5bca9',
    minorRoad: dark ? '#36545e' : '#d4cdbd',
    building: dark ? '#2d4c58' : '#ddd8c8',
    buildingEdge: dark ? '#45616b' : '#c1beae',
    pier: dark ? '#7f9995' : '#a5ada0',
    boundary: dark ? '#729098' : '#87978f',
    text: dark ? '#b8d0d3' : '#435e62',
    secondaryText: dark ? '#809da5' : '#76817b',
    halo: dark ? '#173745' : '#f4f2e8',
  };
  const vector = { source: ONLINE_VECTOR_SOURCE_ID };
  return [
    {
      id: 'online-background',
      type: 'background',
      // Shortbread ocean is a water polygon layer; unpainted space must therefore be land.
      paint: { 'background-color': palette.land },
    },
    {
      id: 'online-land',
      type: 'fill',
      ...vector,
      'source-layer': 'land',
      minzoom: 7,
      paint: {
        'fill-color': [
          'match',
          ['get', 'kind'],
          ['forest', 'grass', 'meadow', 'scrub', 'park'],
          colors.green,
          ['beach', 'sand'],
          colors.sand,
          palette.land,
        ],
        'fill-antialias': false,
      },
    },
    {
      id: 'online-ocean',
      type: 'fill',
      ...vector,
      'source-layer': 'ocean',
      paint: { 'fill-color': palette.sea, 'fill-outline-color': palette.coast },
    },
    {
      id: 'online-water',
      type: 'fill',
      ...vector,
      'source-layer': 'water_polygons',
      minzoom: 5,
      filter: ['!=', ['get', 'kind'], 'glacier'],
      paint: { 'fill-color': palette.sea, 'fill-outline-color': palette.coast },
    },
    {
      id: 'online-waterways',
      type: 'line',
      ...vector,
      'source-layer': 'water_lines',
      minzoom: 9,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': palette.sea,
        'line-width': ['interpolate', ['linear'], ['zoom'], 9, 0.7, 14, 2, 18, 6],
      },
    },
    {
      id: 'online-boundaries',
      type: 'line',
      ...vector,
      'source-layer': 'boundaries',
      minzoom: 2,
      filter: ['!=', ['get', 'maritime'], true],
      paint: {
        'line-color': colors.boundary,
        'line-width': ['interpolate', ['linear'], ['zoom'], 2, 0.5, 10, 1],
        'line-dasharray': [3, 3],
      },
    },
    {
      id: 'online-roads-minor',
      type: 'line',
      ...vector,
      'source-layer': 'streets',
      minzoom: 12,
      filter: [
        'match',
        ['get', 'kind'],
        ['unclassified', 'residential', 'living_street', 'service'],
        true,
        false,
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.minorRoad,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 0.5, 16, 1.8, 19, 5],
      },
    },
    {
      id: 'online-roads-major',
      type: 'line',
      ...vector,
      'source-layer': 'streets',
      minzoom: 7,
      filter: [
        'match',
        ['get', 'kind'],
        ['motorway', 'trunk', 'primary', 'secondary', 'tertiary'],
        true,
        false,
      ],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': colors.road,
        'line-width': ['interpolate', ['linear'], ['zoom'], 7, 0.4, 12, 1, 16, 2.6, 19, 6],
      },
    },
    {
      id: 'online-railways',
      type: 'line',
      ...vector,
      'source-layer': 'streets',
      minzoom: 11,
      filter: ['==', ['get', 'rail'], true],
      paint: { 'line-color': colors.road, 'line-width': 0.8, 'line-dasharray': [2, 3] },
    },
    {
      id: 'online-buildings',
      type: 'fill',
      ...vector,
      'source-layer': 'buildings',
      minzoom: 14,
      paint: { 'fill-color': colors.building, 'fill-outline-color': colors.buildingEdge },
    },
    {
      id: 'online-pier-polygons',
      type: 'fill',
      ...vector,
      'source-layer': 'pier_polygons',
      minzoom: 12,
      paint: { 'fill-color': colors.pier, 'fill-outline-color': palette.coast },
    },
    {
      id: 'online-pier-lines',
      type: 'line',
      ...vector,
      'source-layer': 'pier_lines',
      minzoom: 12,
      layout: { 'line-cap': 'square', 'line-join': 'round' },
      paint: {
        'line-color': colors.pier,
        'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.2, 18, 4],
      },
    },
    {
      id: 'online-boundary-labels',
      type: 'symbol',
      ...vector,
      'source-layer': 'boundary_labels',
      minzoom: 2,
      maxzoom: 8,
      layout: {
        'text-field': labelName,
        'text-font': [...localFonts],
        'text-size': ['interpolate', ['linear'], ['zoom'], 2, 10, 7, 13],
        'text-letter-spacing': 0.1,
        'text-padding': 18,
        'text-max-width': 8,
      },
      paint: {
        'text-color': colors.secondaryText,
        'text-halo-color': colors.halo,
        'text-halo-width': 1.4,
      },
    },
    {
      id: 'online-place-labels',
      type: 'symbol',
      ...vector,
      'source-layer': 'place_labels',
      minzoom: 4,
      filter: [
        'match',
        ['get', 'kind'],
        ['capital', 'state_capital', 'city', 'town', 'island'],
        true,
        false,
      ],
      layout: {
        'text-field': labelName,
        'text-font': [...localFonts],
        'text-size': ['interpolate', ['linear'], ['zoom'], 4, 11, 10, 13, 16, 15],
        'text-padding': 10,
        'text-max-width': 9,
        'symbol-sort-key': ['-', ['coalesce', ['get', 'population'], 0]],
      },
      paint: { 'text-color': colors.text, 'text-halo-color': colors.halo, 'text-halo-width': 1.5 },
    },
  ];
}

export function addOnlineChartStyle(
  base: StyleSpecification,
  theme: Theme,
  config: OnlineChartConfig,
): StyleSpecification {
  const style: StyleSpecification = {
    ...base,
    sources: { ...base.sources },
    layers: [...base.layers],
  };
  if (config.enabled && config.vectorTileJsonUrl) {
    style.sources[ONLINE_VECTOR_SOURCE_ID] = {
      type: 'vector',
      url: config.vectorTileJsonUrl,
      attribution:
        '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    };
    const layers = createOnlineBaseLayers(theme);
    for (const { id, property } of ONLINE_BASE_LAYER_OPACITIES) {
      const layer = layers.find((entry) => entry.id === id)!;
      layer.paint = {
        ...layer.paint,
        [property]: 0,
        [`${property}-transition`]: { duration: 0, delay: 0 },
      } as LayerSpecification['paint'];
    }
    const before = style.layers.findIndex((layer) => !/^(local-|regional-)/.test(layer.id));
    style.layers.splice(before === -1 ? style.layers.length : before, 0, ...layers);
  }
  if (config.seamarksEnabled && config.seamarkTilesUrl) {
    style.sources[ONLINE_SEAMARK_SOURCE_ID] = {
      type: 'raster',
      tiles: [config.seamarkTilesUrl],
      scheme: 'xyz',
      tileSize: 256,
      maxzoom: 18,
      attribution:
        '© <a href="https://www.openseamap.org/">OpenSeaMap</a> contributors (<a href="https://creativecommons.org/licenses/by-sa/2.0/">CC BY-SA 2.0</a>)',
    };
    style.layers.push({
      id: ONLINE_SEAMARK_LAYER_ID,
      type: 'raster',
      source: ONLINE_SEAMARK_SOURCE_ID,
      paint: {
        'raster-opacity': 0,
        'raster-opacity-transition': { duration: 0, delay: 0 },
        'raster-fade-duration': 0,
      },
    });
  }
  return style;
}

interface OnlineChartThemeMap {
  getLayer(id: string): unknown;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
}

export function applyOnlineChartTheme(map: OnlineChartThemeMap, theme: Theme) {
  for (const layer of createOnlineBaseLayers(theme)) {
    if (!map.getLayer(layer.id)) continue;
    for (const [property, value] of Object.entries(layer.paint ?? {}))
      if (property.endsWith('color')) map.setPaintProperty(layer.id, property, value);
  }
}

export interface OnlineChartConfig {
  enabled: boolean;
  vectorTileJsonUrl: string;
  seamarksEnabled: boolean;
  seamarkTilesUrl: string;
}

export const DEFAULT_VECTOR_TILE_JSON_URL =
  'https://vector.openstreetmap.org/shortbread_v1/tilejson.json';
export const DEFAULT_SEAMARK_TILES_URL = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

/** Public runtime configuration is untrusted deployment input; disable only the affected source. */
export function readOnlineChartConfig(
  raw: Record<string, unknown> = {},
  onDiagnostic?: (message: string) => void,
): OnlineChartConfig {
  function enabled(key: string) {
    const value = raw[key];
    if (value === undefined) return true;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && /^(true|false)$/i.test(value.trim()))
      return value.trim().toLowerCase() === 'true';
    onDiagnostic?.(`${key} 配置无效，对应在线图源已关闭`);
    return false;
  }
  function url(key: string, fallback: string, template = false) {
    const value = raw[key] === undefined ? fallback : raw[key];
    try {
      if (typeof value !== 'string' || !value.trim() || /[\s\\]/.test(value)) throw new Error();
      const parsed = new URL(value);
      if (
        parsed.protocol !== 'https:' ||
        !parsed.hostname ||
        parsed.username ||
        parsed.password ||
        parsed.hash ||
        (template && !['{z}', '{x}', '{y}'].every((part) => value.includes(part)))
      )
        throw new Error();
      return value;
    } catch {
      // Never echo a URL: it could contain deployment credentials.
      onDiagnostic?.(
        `${key} 需要有效的 HTTPS ${template ? 'XYZ 瓦片模板' : 'TileJSON URL'}，对应在线图源已关闭`,
      );
      return '';
    }
  }
  const vectorTileJsonUrl = url('chartVectorTileJsonUrl', DEFAULT_VECTOR_TILE_JSON_URL);
  const seamarkTilesUrl = url('chartSeamarkTilesUrl', DEFAULT_SEAMARK_TILES_URL, true);
  return {
    enabled: enabled('chartOnlineEnabled') && Boolean(vectorTileJsonUrl),
    vectorTileJsonUrl,
    seamarksEnabled: enabled('chartSeamarksEnabled') && Boolean(seamarkTilesUrl),
    seamarkTilesUrl,
  };
}
