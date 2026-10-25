import { expect, it, vi } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import * as highlights from './app/utils/vesselHighlightsMap';
import type { MapEffectTarget } from './app/types/mapEffects';

it('共享点源以稳定key标识、保留方向，线面由屏幕层显示', () => {
  const targets: MapEffectTarget[] = [
    {
      key: 'vessel:123456789',
      effectId: 'locate',
      icon: 'vessel',
      bearing: 42,
      geometries: [{ type: 'Point', coordinates: [120, 30] }],
    },
    {
      key: 'line',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [120, 30],
            [121, 31],
          ],
        },
      ],
    },
  ];
  const first = highlights.highlightGeoJson(targets);
  expect(first.features).toHaveLength(1);
  expect(first.features[0]).toMatchObject({
    id: 'vessel:123456789',
    properties: { mmsi: '123456789', bearing: 42, markerIcon: 'map-effect-vessel-FFD84D' },
  });
  expect(highlights.highlightGeoJson([], '#FFD84D').features).toEqual([]);
});

it('只有共享glyph标记层，feature-state控制透明度，MapLibre样式合法', () => {
  const sources: Record<string, SourceSpecification> = {};
  const layers: LayerSpecification[] = [];
  const images = new Set<string>();
  const addImage = vi.fn((id: string) => images.add(id));
  const map = {
    getSource: (id: string) => sources[id],
    getLayer: (id: string) => layers.find((layer) => layer.id === id),
    hasImage: (id: string) => images.has(id),
    addSource: (id: string, source: SourceSpecification) => {
      sources[id] = source;
    },
    addLayer: (layer: LayerSpecification) => {
      layers.push(layer);
    },
    addImage,
  };
  highlights.registerVesselHighlightLayers(map);
  highlights.registerVesselHighlightLayers(map);
  expect(layers).toHaveLength(1);
  expect(layers[0]).toMatchObject({
    id: 'vessel-highlight-marker',
    type: 'symbol',
    paint: { 'icon-opacity': ['coalesce', ['feature-state', 'opacity'], 1] },
  });
  expect(layers[0]).toMatchObject({
    paint: { 'icon-opacity-transition': { duration: 0, delay: 0 } },
  });
  expect(validateStyleMin({ version: 8, sources, layers }).map((issue) => issue.message)).toEqual(
    [],
  );
  expect(addImage).toHaveBeenCalledTimes(5);
  expect(JSON.stringify(layers)).not.toMatch(/circle|halo|glow|alertOpacity/);
  expect(highlights).not.toHaveProperty('createHighlightAnimation');
});

it('透明度只写feature-state，结束还原常驻图形', () => {
  expect(highlights).toHaveProperty('updateMapEffectOpacity');
  const map = { setFeatureState: vi.fn() };
  highlights.updateMapEffectOpacity(map, ['a', 'b'], 0);
  highlights.updateMapEffectOpacity(map, ['a', 'b'], 1);
  expect(map.setFeatureState.mock.calls).toEqual([
    [{ source: 'vessel-highlights', id: 'a' }, { opacity: 0 }],
    [{ source: 'vessel-highlights', id: 'b' }, { opacity: 0 }],
    [{ source: 'vessel-highlights', id: 'a' }, { opacity: 1 }],
    [{ source: 'vessel-highlights', id: 'b' }, { opacity: 1 }],
  ]);
});
