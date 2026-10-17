import { expect, it } from 'vitest';
import type { HeatmapResult } from '@ais/contracts';
import type { LayerSpecification } from 'maplibre-gl';
import {
  heatmapGeoJson,
  registerHeatmapLayers,
  heatmapViewportBounds,
} from './app/utils/heatmapMap';
it('完整世界视野保留西负180东正180，日期线视野保留跨线语义', () => {
  expect(heatmapViewportBounds(-180, -85, 180, 85)).toEqual([-180, -85, 180, 85]);
  expect(heatmapViewportBounds(180, -90, 540, 90)).toEqual([-180, -90, 180, 90]);
  expect(heatmapViewportBounds(-179.9999999999, -95, 180, 95)).toEqual([-180, -90, 180, 90]);
  expect(heatmapViewportBounds(170, -10, 190, 20)).toEqual([170, -10, -170, 20]);
});
it('热区只登记平滑图层，样式重载可幂等恢复', () => {
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
  expect([...layers.values()].map((layer) => layer.type)).toEqual(['heatmap']);
  sources.clear();
  layers.clear();
  registerHeatmapLayers(map);
  expect(sources.has('ais-heatmap')).toBe(true);
  expect([...layers.values()].map((layer) => layer.type)).toEqual(['heatmap']);
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

it('热区点源保留每格船数、单元标识与中心，不增加稀疏数据', () => {
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
      geometry: { type: 'Point', coordinates: [120.9375, 30.9375] },
    },
    {
      type: 'Feature',
      id: '6:54:22',
      properties: { count: 1, cellId: '6:54:22' },
      geometry: { type: 'Point', coordinates: [126.5625, 36.5625] },
    },
  ]);
});
