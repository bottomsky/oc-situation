import { afterEach, expect, it, vi } from 'vitest';
import { createOnlineChartCoverage, type OnlineChartState } from './app/utils/onlineChartState';
import type { LayerSpecification, SourceSpecification } from 'maplibre-gl';
import { addOnlineChartStyle } from './app/utils/onlineChartStyle';
import { createManifestStyle } from './app/utils/chartPresentation';
import {
  ONLINE_BASE_LAYER_OPACITIES,
  ONLINE_SEAMARK_LAYER_ID,
  ONLINE_VECTOR_SOURCE_ID as baseId,
  ONLINE_SEAMARK_SOURCE_ID as seamarkId,
} from './app/utils/onlineChartStyle';

afterEach(() => vi.useRealTimers());

function fixture(config = { enabled: true, seamarksEnabled: true }, timeoutMs = 15_000) {
  type Event = {
    sourceId?: string;
    tile?: unknown;
    sourceDataType?: string;
    sourceDataChanged?: boolean;
  };
  const listeners = new Map<string, Set<(event: Event) => void>>();
  const loaded = new Set<string>();
  const configValue = {
    ...config,
    vectorTileJsonUrl: 'https://fixture.example/tilejson.json',
    seamarkTilesUrl: 'https://fixture.example/seamarks/{z}/{x}/{y}.png',
  };
  const style = addOnlineChartStyle(createManifestStyle('dark'), 'dark', configValue);
  const sources = style.sources;
  style.sources.vessels = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
  style.layers.push({ id: 'vessels', type: 'circle', source: 'vessels' });
  const states: OnlineChartState[] = [];
  const map = {
    getSource: (id: string) => sources[id],
    getLayer: (id: string) => style.layers.find((layer) => layer.id === id),
    isSourceLoaded: (id: string) => loaded.has(id),
    setPaintProperty: vi.fn(),
    triggerRepaint: vi.fn(),
    getStyle: () => structuredClone(style),
    addSource: vi.fn((id: string, source: SourceSpecification) => {
      style.sources[id] = source;
    }),
    removeSource: vi.fn((id: string) => {
      delete style.sources[id];
    }),
    removeLayer: vi.fn((id: string) => {
      style.layers = style.layers.filter((layer) => layer.id !== id);
    }),
    addLayer: vi.fn((layer: LayerSpecification, beforeId?: string) => {
      const index = beforeId ? style.layers.findIndex((item) => item.id === beforeId) : -1;
      style.layers.splice(index < 0 ? style.layers.length : index, 0, layer);
    }),
    on(type: string, cb: (event: Event) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(cb);
    },
    off(type: string, cb: (event: Event) => void) {
      listeners.get(type)?.delete(cb);
    },
  };
  const controller = createOnlineChartCoverage(
    map,
    {
      ...configValue,
    },
    (state) => states.push(state),
    { timeoutMs },
  );
  function fire(type: string, sourceId?: string, tile?: unknown, details: Partial<Event> = {}) {
    for (const cb of listeners.get(type) ?? []) cb({ sourceId, tile, ...details });
  }
  function ready(id: string, refresh = false) {
    if (refresh)
      fire('sourcedata', id, undefined, { sourceDataType: 'content', sourceDataChanged: true });
    loaded.add(id);
    fire('sourcedata', id, {});
    fire('render');
  }
  return {
    map,
    controller,
    sources,
    style,
    states,
    loaded,
    listeners,
    fire,
    ready,
    state: () => states.at(-1)!,
  };
}

it('TileJSON元数据与普通content不足以启用底图，真实瓦片加载后在render原子显示全组', () => {
  const f = fixture();
  f.loaded.add(baseId);
  f.fire('sourcedata', baseId);
  f.fire('render');
  expect(f.state().base).toBe('loading');
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  f.fire('sourcedata', baseId, {});
  expect(f.state().base).toBe('loading');
  f.fire('render');
  expect(f.state().base).toBe('ready');
  expect(f.map.setPaintProperty.mock.calls).toEqual(
    ONLINE_BASE_LAYER_OPACITIES.map((l) => [l.id, l.property, l.readyValue]),
  );
});

it('瓦片延迟期间保持回退，AIS事件不会更改在线paint或触发循环', () => {
  const f = fixture();
  f.fire('sourcedata', baseId, {});
  f.fire('render');
  expect(f.state().base).toBe('loading');
  f.ready(baseId);
  f.map.setPaintProperty.mockClear();
  for (let i = 0; i < 20; ++i) {
    f.fire('sourcedataloading', 'vessels');
    f.fire('sourcedata', 'vessels', {});
    f.fire('render');
  }
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
});

it('源错误被锁存，迟到loaded/render及移动不能复活失败组', () => {
  const f = fixture();
  f.ready(baseId);
  f.fire('error', baseId);
  expect(f.state().base).toBe('fallback');
  expect(
    f.map.setPaintProperty.mock.calls
      .slice(-ONLINE_BASE_LAYER_OPACITIES.length)
      .every((call) => call[2] === 0),
  ).toBe(true);
  f.ready(baseId);
  f.fire('movestart');
  f.fire('moveend');
  f.fire('render');
  expect(f.state().base).toBe('fallback');
});

it('已呈现在线组在移动及后继瓦片加载时保持可见，让MapLibre连续复用父子瓦片', () => {
  const f = fixture();
  f.ready(baseId);
  f.ready(seamarkId);
  f.map.setPaintProperty.mockClear();
  f.fire('movestart');
  expect(f.state().base).toBe('loading');
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  f.loaded.delete(baseId);
  f.fire('sourcedataloading', baseId, {});
  f.fire('render');
  f.fire('moveend');
  f.fire('render');
  expect(f.state().base).toBe('loading');
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  f.ready(baseId, true);
  expect(f.state().base).toBe('ready');
  f.fire('sourcedataloading', baseId, {});
  expect(f.state().base).toBe('loading');
  f.ready(baseId);
  f.ready(seamarkId);
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  for (let i = 0; i < 4; ++i) {
    f.fire('movestart');
    f.fire('moveend');
    f.fire('render');
  }
  expect(f.state()).toMatchObject({ base: 'ready', seamarks: 'ready' });
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
});

it('已呈现在线组正常长拖动保持可见，停下后后继瓦片超时才回退并重新预热', () => {
  vi.useFakeTimers();
  const f = fixture({ enabled: true, seamarksEnabled: false }, 100);
  f.ready(baseId);
  f.map.setPaintProperty.mockClear();
  f.fire('movestart');
  f.loaded.delete(baseId);
  f.fire('sourcedataloading', baseId, {});
  vi.advanceTimersByTime(1_000);
  expect(f.state().base).toBe('loading');
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  f.fire('moveend');
  vi.advanceTimersByTime(99);
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(f.state().base).toBe('fallback');
  expect(f.map.setPaintProperty.mock.calls).toEqual(
    ONLINE_BASE_LAYER_OPACITIES.map((l) => [l.id, l.property, 0]),
  );
  f.controller.retry('base');
  f.map.setPaintProperty.mockClear();
  f.fire('movestart');
  f.fire('moveend');
  f.loaded.add(`${baseId}-g1`);
  f.fire('render');
  expect(f.state().base).toBe('loading');
  expect(f.map.setPaintProperty).not.toHaveBeenCalled();
  f.ready(`${baseId}-g1`);
  expect(f.map.setPaintProperty.mock.calls).toEqual(
    ONLINE_BASE_LAYER_OPACITIES.map((l) => [l.id, l.property, l.readyValue]),
  );
  f.controller.dispose();
});

it('海标就绪与失败只改变海标，底图就绪状态保持独立', () => {
  const f = fixture();
  f.ready(baseId);
  f.ready(seamarkId);
  f.map.setPaintProperty.mockClear();
  f.fire('error', seamarkId);
  expect(f.state()).toMatchObject({ base: 'ready', seamarks: 'fallback' });
  expect(f.map.setPaintProperty.mock.calls).toEqual([
    [ONLINE_SEAMARK_LAYER_ID, 'raster-opacity', 0],
  ]);
});

it('禁用在线时无事件监听和paint，海标也可独立开启', () => {
  const disabled = fixture({ enabled: false, seamarksEnabled: false });
  expect(disabled.state()).toMatchObject({ base: 'disabled', seamarks: 'disabled' });
  expect(disabled.listeners.size).toBe(0);
  expect(disabled.controller.retry('base')).toBe(false);
  const independent = fixture({ enabled: false, seamarksEnabled: true });
  independent.ready(seamarkId);
  expect(independent.state()).toMatchObject({ base: 'disabled', seamarks: 'ready' });
});

it('人工重试仅替换在线source代次，保留原URL、主题paint、图层顺序与AIS源且最多两次', () => {
  const f = fixture();
  const order = f.style.layers.map((layer) => layer.id);
  const vessels = f.sources.vessels;
  const layer = f.style.layers.find((entry) => entry.id === 'online-ocean')!;
  layer.paint = { ...layer.paint, 'fill-color': '#dcecf1' } as typeof layer.paint;
  expect(f.controller.retry('base')).toBe(false);
  f.fire('error', baseId);
  expect(f.controller.retry('base')).toBe(true);
  expect(f.sources[`${baseId}-g1`]).toMatchObject({ url: 'https://fixture.example/tilejson.json' });
  expect(f.map.removeSource).toHaveBeenCalledWith(baseId);
  expect(f.style.layers.map((entry) => entry.id)).toEqual(order);
  expect(f.sources.vessels).toBe(vessels);
  expect(f.style.layers.find((entry) => entry.id === 'online-ocean')).toMatchObject({
    source: `${baseId}-g1`,
    paint: { 'fill-color': '#dcecf1', 'fill-opacity': 0 },
  });
  f.ready(baseId);
  f.fire('error', baseId);
  expect(f.state()).toMatchObject({ base: 'loading', baseRetriesRemaining: 1 });
  f.ready(`${baseId}-g1`);
  expect(f.state().base).toBe('ready');
  f.fire('error', `${baseId}-g1`);
  expect(f.controller.retry('base')).toBe(true);
  f.fire('error', `${baseId}-g2`);
  expect(f.controller.retry('base')).toBe(false);
  expect(f.map.addSource).toHaveBeenCalledTimes(2);
  f.fire('error', seamarkId);
  expect(f.controller.retry('seamarks')).toBe(true);
  expect(f.sources[`${seamarkId}-g1`]).toMatchObject({
    tiles: ['https://fixture.example/seamarks/{z}/{x}/{y}.png'],
  });
});

it('卸载移除全部监听，迟到事件与重试都不再更新页面', () => {
  const f = fixture();
  f.fire('error', baseId);
  const count = f.states.length;
  f.controller.dispose();
  f.ready(baseId);
  f.fire('moveend');
  expect([...f.listeners.values()].every((set) => set.size === 0)).toBe(true);
  expect(f.controller.retry('base')).toBe(false);
  expect(f.states).toHaveLength(count);
});

it('无限pending在有限时间回退，人工重试获得新一轮期限且迟到事件不能复活', () => {
  vi.useFakeTimers();
  const f = fixture({ enabled: true, seamarksEnabled: false }, 100);
  vi.advanceTimersByTime(100);
  expect(f.state().base).toBe('fallback');
  f.ready(baseId);
  expect(f.state().base).toBe('fallback');
  expect(f.controller.retry('base')).toBe(true);
  vi.advanceTimersByTime(99);
  expect(f.state().base).toBe('loading');
  f.ready(`${baseId}-g1`);
  vi.advanceTimersByTime(100);
  expect(f.state().base).toBe('ready');
  f.controller.dispose();
});

it('持续移动暂停超时，停下后按新视口重新计时，卸载清理timer', () => {
  vi.useFakeTimers();
  const f = fixture({ enabled: true, seamarksEnabled: false }, 100);
  vi.advanceTimersByTime(50);
  f.fire('movestart');
  vi.advanceTimersByTime(1_000);
  expect(f.state().base).toBe('loading');
  f.fire('moveend');
  vi.advanceTimersByTime(99);
  expect(f.state().base).toBe('loading');
  vi.advanceTimersByTime(1);
  expect(f.state().base).toBe('fallback');
  f.controller.retry('base');
  const count = f.states.length;
  f.controller.dispose();
  vi.advanceTimersByTime(100);
  expect(f.states).toHaveLength(count);
  expect(vi.getTimerCount()).toBe(0);
});

it('重试新代次混合成功和请求边界error时锁存回退，旧源error不会影响新代次', () => {
  const f = fixture();
  f.ready(seamarkId);
  f.fire('error', seamarkId);
  f.controller.retry('seamarks');
  f.fire('error', seamarkId);
  expect(f.state().seamarks).toBe('loading');
  f.loaded.add(`${seamarkId}-g1`);
  f.fire('sourcedata', `${seamarkId}-g1`, {});
  f.fire('error', `${seamarkId}-g1`);
  f.fire('render');
  expect(f.state().seamarks).toBe('fallback');
  f.ready(`${seamarkId}-g1`);
  expect(f.state().seamarks).toBe('fallback');
});

it('新TileJSON握手前旧瓦片error/metadata/content均被源ID隔离，当前代次等待真实瓦片', () => {
  const f = fixture();
  f.ready(baseId);
  f.fire('error', baseId);
  f.controller.retry('base');
  f.fire('error', baseId);
  f.ready(baseId);
  f.fire('sourcedata', baseId, undefined, { sourceDataType: 'content', sourceDataChanged: true });
  expect(f.state().base).toBe('loading');
  f.loaded.add(`${baseId}-g1`);
  f.fire('sourcedata', `${baseId}-g1`);
  f.fire('render');
  expect(f.state().base).toBe('loading');
  f.ready(`${baseId}-g1`);
  expect(f.state().base).toBe('ready');
});
