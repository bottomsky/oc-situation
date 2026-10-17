import { expect, it, vi } from 'vitest';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import {
  createHighlightTimeline,
  createHighlightAnimation,
  highlightGeoJson,
  registerVesselHighlightLayers,
} from './app/utils/vesselHighlightsMap';

it('同一effect跨更新和样式恢复不重播，新目标独立开始；源不包含模型样式参数', () => {
  const timeline = createHighlightTimeline();
  const target = {
    mmsi: '123456789',
    name: null,
    lon: 120,
    lat: 30,
    observedAt: '2026-10-17T00:00:00Z',
    effectId: 'effect',
  };
  const first = highlightGeoJson([target], timeline, 50);
  const updated = highlightGeoJson([{ ...target, lon: 121 }], timeline, 1200);
  expect(first.features[0]?.properties.startedAt).toBe(50);
  expect(first.features[0]?.properties.markerIcon).toBe('highlight-vessel-unknown');
  expect(updated.features[0]?.properties.startedAt).toBe(50);
  expect(updated.features[0]?.geometry.coordinates).toEqual([121, 30]);
  expect(highlightGeoJson([], timeline, 1300).features).toEqual([]);
  expect(highlightGeoJson([target], timeline, 1400).features[0]?.properties.startedAt).toBe(50);
});

it('动态图层表达式通过当前MapLibre样式校验', () => {
  const sources: Record<string, SourceSpecification> = {};
  const layers: LayerSpecification[] = [];
  registerVesselHighlightLayers({
    getSource: (id) => sources[id],
    getLayer: (id) => layers.find((layer) => layer.id === id),
    hasImage: () => false,
    addSource: (id, source) => {
      sources[id] = source;
    },
    addLayer: (layer) => {
      layers.push(layer);
    },
    addImage: () => {},
  });
  expect(validateStyleMin({ version: 8, sources, layers }).map((issue) => issue.message)).toEqual(
    [],
  );
  expect(JSON.stringify(layers)).not.toContain('global-state');
});

it('共享时钟最多30fps，后台暂停且恢复不计隐藏时长，静态模式无动画帧', () => {
  let callback: FrameRequestCallback | undefined;
  const frames = {
    request: vi.fn((cb: FrameRequestCallback) => {
      callback = cb;
      return 1;
    }),
    cancel: vi.fn(),
  };
  const map = { setFeatureState: vi.fn() };
  const animation = createHighlightAnimation(map, frames);
  animation.targets([{ mmsi: '413793000', startedAt: 0 }]);
  animation.update({ active: true, hidden: false, reduced: false });
  callback!(0);
  callback!(16);
  callback!(34);
  expect(map.setFeatureState).toHaveBeenCalledTimes(2);
  expect(map.setFeatureState).toHaveBeenLastCalledWith(
    { source: 'vessel-highlights', id: '413793000' },
    expect.objectContaining({ radius: expect.any(Number), alertOpacity: 1 }),
  );
  animation.update({ active: true, hidden: true, reduced: false });
  const clock = animation.now();
  animation.update({ active: true, hidden: false, reduced: false });
  callback!(10000);
  expect(animation.now()).toBe(clock);
  animation.update({ active: true, hidden: false, reduced: true });
  expect(frames.cancel).toHaveBeenCalled();
  animation.dispose();
});

it('三次600ms提醒结束后转为2秒水波，逐船feature-state不修改数据源', () => {
  let callback!: FrameRequestCallback;
  const map = { setFeatureState: vi.fn() };
  const animation = createHighlightAnimation(map, {
    request: (cb) => {
      callback = cb;
      return 1;
    },
    cancel: () => {},
  });
  animation.targets(
    Array.from({ length: 100 }, (_, i) => ({ mmsi: String(413000001 + i), startedAt: 0 })),
  );
  animation.update({ active: true, hidden: false, reduced: false });
  callback(0);
  expect(map.setFeatureState).toHaveBeenCalledTimes(100);
  for (const time of [600, 1200]) {
    callback(time);
    expect(map.setFeatureState.mock.calls.at(-1)?.[1]).toMatchObject({
      radius: 10,
      alertOpacity: 1,
    });
  }
  callback(1800);
  expect(map.setFeatureState.mock.calls.at(-1)?.[1]).toMatchObject({ radius: 10, alertOpacity: 0 });
  callback(2800);
  expect(map.setFeatureState.mock.calls.at(-1)?.[1]).toMatchObject({ radius: 22, alertOpacity: 0 });
  animation.dispose();
});

it('专用未聚合源可重复恢复，持续波纹通过共享时钟更新而非每帧setData', () => {
  const sources = new Set();
  const layers = new Set();
  const images = new Set();
  const map = {
    getSource: (id: string) => sources.has(id),
    getLayer: (id: string) => layers.has(id),
    hasImage: (id: string) => images.has(id),
    addSource: vi.fn((id: string) => sources.add(id)),
    addLayer: vi.fn((layer: { id: string }) => layers.add(layer.id)),
    addImage: vi.fn((id: string) => images.add(id)),
  };
  registerVesselHighlightLayers(map);
  registerVesselHighlightLayers(map);
  expect(map.addSource).toHaveBeenCalledTimes(1);
  expect(map.addSource.mock.calls[0]?.[0]).toBe('vessel-highlights');
  expect(map.addLayer).toHaveBeenCalledTimes(4);
});
