import { expect, it, vi } from 'vitest';
import type { HeatmapResult } from '@ais/contracts';
import type { LayerSpecification } from 'maplibre-gl';
import {
  heatmapGeoJson,
  registerHeatmapLayers,
  heatmapViewportBounds,
  registerCurrentDensityLayer,
  heatmapCellAt,
} from './app/utils/heatmapMap';

it('历史统计覆盖实际网格并裁切查询范围，不把整格船数集中到格中心', () => {
  const data = heatmapGeoJson({
    query: { bbox: [121, 30, 122, 31], from: '2026-10-16T00:00:00Z', to: '2026-10-17T00:00:00Z' },
    grid: { level: 6, cellDegrees: 5.625 },
    cells: [{ id: '6:53:21', x: 53, y: 21, lon: 120.9375, lat: 30.9375, vesselCount: 3 }],
    totalVessels: 3,
    generatedAt: '2026-10-17T00:00:00Z',
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  });
  expect(data.features[0]?.geometry).toEqual({
    type: 'Polygon',
    coordinates: [
      [
        [121, 30],
        [122, 30],
        [122, 31],
        [121, 31],
        [121, 30],
      ],
    ],
  });
});

it('当前密度直接使用单船点源且每船只计一次，叠在船舶符号下方', () => {
  const addLayer = vi.fn();
  registerCurrentDensityLayer({ getLayer: () => undefined, addLayer });
  expect(addLayer).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'ais-current-density',
      source: 'vessels',
      type: 'heatmap',
      filter: ['==', ['get', 'kind'], 'point'],
      paint: expect.objectContaining({ 'heatmap-weight': 1 }),
    }),
    'vessels',
  );
});
it('完整世界视野保留西负180东正180，日期线视野保留跨线语义', () => {
  expect(heatmapViewportBounds(-180, -85, 180, 85)).toEqual([-180, -85, 180, 85]);
  expect(heatmapViewportBounds(180, -90, 540, 90)).toEqual([-180, -90, 180, 90]);
  expect(heatmapViewportBounds(-179.9999999999, -95, 180, 95)).toEqual([-180, -90, 180, 90]);
  expect(heatmapViewportBounds(170, -10, 190, 20)).toEqual([170, -10, -170, 20]);
});
it('历史热区登记网格面图层，样式重载可幂等恢复', () => {
  const sources = new Set<string>();
  const layers = new Map<string, LayerSpecification>();
  const map = {
    getSource: (id: string) => sources.has(id),
    getLayer: (id: string) => layers.get(id),
    addSource: (id: string) => {
      sources.add(id);
    },
    addLayer: (layer: LayerSpecification) => {
      layers.set(layer.id, layer);
    },
    removeLayer: (id: string) => layers.delete(id),
  };
  registerHeatmapLayers(map);
  registerHeatmapLayers(map);
  expect([...layers.values()].map((layer) => layer.type)).toEqual(['fill']);
  sources.clear();
  layers.clear();
  registerHeatmapLayers(map);
  expect(sources.has('ais-heatmap')).toBe(true);
  expect([...layers.values()].map((layer) => layer.type)).toEqual(['fill']);
  expect(heatmapGeoJson(null).features).toEqual([]);
});

it('恢复旧样式时移除历史圆圈，保留热区与其他业务图层', () => {
  const layers = new Set(['ais-heatmap', 'ais-heatmap-cells', 'vessels']);
  const map = {
    getSource: () => true,
    getLayer: (id: string) => layers.has(id),
    addSource: () => {},
    addLayer: (layer: LayerSpecification) => layers.add(layer.id),
    removeLayer: (id: string) => {
      expect(layers.has(id)).toBe(true);
      layers.delete(id);
    },
  };
  registerHeatmapLayers(map);
  registerHeatmapLayers(map);
  expect([...layers]).toEqual(['ais-heatmap', 'vessels']);
});

it('恢复旧中心点热图时替换为网格面，并保持在单船图层下方', () => {
  const layers = new Map<string, LayerSpecification>([
    ['ais-heatmap', { id: 'ais-heatmap', type: 'heatmap', source: 'ais-heatmap' }],
    ['vessels', { id: 'vessels', type: 'circle', source: 'vessels' }],
  ]);
  const addLayer = vi.fn();
  registerHeatmapLayers({
    getSource: () => true,
    getLayer: (id) => layers.get(id),
    addSource: () => {},
    addLayer,
    removeLayer: (id) => layers.delete(id),
  });
  expect(addLayer).toHaveBeenCalledWith(expect.objectContaining({ type: 'fill' }), 'vessels');
});

it('历史网格保留船数及单元标识，覆盖完整单元而非中心点', () => {
  const result: HeatmapResult = {
    query: { bbox: [110, 10, 130, 40], from: '2026-10-16T00:00:00Z', to: '2026-10-17T00:00:00Z' },
    grid: { level: 6, cellDegrees: 5.625 },
    cells: [
      { id: '6:53:21', x: 53, y: 21, lon: 120.9375, lat: 30.9375, vesselCount: 3 },
      { id: '6:54:22', x: 54, y: 22, lon: 126.5625, lat: 36.5625, vesselCount: 1 },
    ],
    totalVessels: 4,
    generatedAt: '2026-10-17T00:00:00Z',
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  };
  expect(heatmapGeoJson(result).features).toEqual([
    {
      type: 'Feature',
      id: '6:53:21',
      properties: { count: 3, cellId: '6:53:21' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [118.125, 28.125],
            [123.75, 28.125],
            [123.75, 33.75],
            [118.125, 33.75],
            [118.125, 28.125],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      id: '6:54:22',
      properties: { count: 1, cellId: '6:54:22' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [123.75, 33.75],
            [129.375, 33.75],
            [129.375, 39.375],
            [123.75, 39.375],
            [123.75, 33.75],
          ],
        ],
      },
    },
  ]);
});

it('日期线两侧、极区和网格边界的点击命中与裁切后的面一致', () => {
  const result: HeatmapResult = {
    query: { bbox: [170, -90, -170, 90], from: '2026-10-16T00:00:00Z', to: '2026-10-17T00:00:00Z' },
    grid: { level: 0, cellDegrees: 360 },
    cells: [{ id: '0:0:0', x: 0, y: 0, lon: 0, lat: 0, vesselCount: 1 }],
    totalVessels: 1,
    generatedAt: '2026-10-17T00:00:00Z',
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  };
  expect(heatmapGeoJson(result).features[0]?.geometry.type).toBe('MultiPolygon');
  for (const [lon, lat] of [
    [175, 89],
    [-175, -89],
    [180, 90],
    [-180, -90],
    [170, 0],
    [190, 0],
  ])
    expect(heatmapCellAt(result, lon!, lat!)?.id).toBe('0:0:0');
  expect(heatmapCellAt(result, 0, 0)).toBeUndefined();
  expect(heatmapCellAt(result, 169.999, 0)).toBeUndefined();
});
