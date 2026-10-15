import { expect, it } from 'vitest';
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
it('热图独立图源在业务图层下方，样式重载可幂等恢复', () => {
  const sources = new Set<string>();
  const layers: string[] = [];
  const map = {
    getSource: (id: string) => sources.has(id),
    getLayer: (id: string) => layers.includes(id),
    addSource: (id: string) => {
      sources.add(id);
    },
    addLayer: (layer: { id: string }) => {
      layers.push(layer.id);
    },
  };
  registerHeatmapLayers(map);
  registerHeatmapLayers(map);
  expect(layers).toEqual(['ais-heatmap', 'ais-heatmap-cells']);
  sources.clear();
  layers.splice(0);
  registerHeatmapLayers(map);
  expect(sources.has('ais-heatmap')).toBe(true);
  expect(heatmapGeoJson(null).features).toEqual([]);
});
