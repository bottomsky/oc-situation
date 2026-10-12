import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyChartBusinessVisibility,
  createChartMapScheduling,
  createOfflineChartStyle,
  defaultChartVisibility,
} from './app/utils/chartLayers';

afterEach(() => vi.useRealTimers());

describe('local dark chart style', () => {
  it('uses only the bundled Natural Earth GeoJSON without tile, glyph, sprite or remote resources', () => {
    const style = createOfflineChartStyle();
    expect(style.version).toBe(8);
    expect(style.sources).toEqual({
      'local-land': {
        type: 'geojson',
        data: '/maps/ne_110m_land.geojson',
        attribution: 'Natural Earth · Public domain',
      },
    });
    expect(style.layers.map((layer) => layer.type)).toEqual(['background', 'fill', 'line']);
    expect(style.layers[0]?.paint).toEqual({ 'background-color': '#081d31' });
    expect(style.layers[1]?.paint).toEqual({ 'fill-color': '#173745' });
    expect(style.layers[2]?.paint).toEqual({ 'line-color': '#357b89', 'line-width': 0.8 });
    expect(style).not.toHaveProperty('glyphs');
    expect(style).not.toHaveProperty('sprite');
    expect(JSON.stringify(style)).not.toMatch(/https?:|tiles|raster|maptiler|gebco|openseamap/i);
  });
});

describe('business layer visibility', () => {
  const ids = [
    'vessels',
    'clusters',
    'tracks',
    'frame',
    'evidence-region-fill',
    'evidence-region-line',
    'evidence-tracks',
    'evidence-points',
  ];
  function fixture() {
    const visibility = new Map<string, unknown>();
    const map = {
      getLayer: (id: string) => ids.includes(id) || id.startsWith('local-'),
      setLayoutProperty: (id: string, _name: string, value: unknown) => visibility.set(id, value),
    };
    return { map, visibility };
  }
  it('shows all AIS, trajectory, playback and evidence layers by default', () => {
    expect(defaultChartVisibility).toEqual({ ais: true, tracks: true, evidence: true });
    const { map, visibility } = fixture();
    applyChartBusinessVisibility(map);
    expect([...visibility.keys()]).toEqual(ids);
    expect([...visibility.values()]).toEqual(ids.map(() => 'visible'));
  });
  it('toggles only the requested business group, retaining the local base', () => {
    const { map, visibility } = fixture();
    applyChartBusinessVisibility(map, { ais: false, tracks: true, evidence: false });
    expect(visibility.get('vessels')).toBe('none');
    expect(visibility.get('clusters')).toBe('none');
    expect(visibility.get('tracks')).toBe('visible');
    expect(visibility.get('frame')).toBe('visible');
    for (const id of ids.filter((id) => id.startsWith('evidence-')))
      expect(visibility.get(id)).toBe('none');
    expect(visibility.has('local-land')).toBe(false);
    applyChartBusinessVisibility(map, { ais: true, evidence: true });
    expect([...visibility.values()]).toEqual(ids.map(() => 'visible'));
  });
  it('ignores obsolete public layer settings and skips business layers before style readiness', () => {
    const { map, visibility } = fixture();
    const oldPreferences = {
      ...defaultChartVisibility,
      bathymetry: true,
      seamarks: true,
      custom: true,
    };
    applyChartBusinessVisibility(map, oldPreferences);
    expect([...visibility.keys()]).toEqual(ids);
    const setLayoutProperty = vi.fn();
    applyChartBusinessVisibility({ getLayer: () => undefined, setLayoutProperty }, { ais: false });
    expect(setLayoutProperty).not.toHaveBeenCalled();
  });
});

describe('map layout and viewport scheduling', () => {
  it('debounces rapid viewport updates to the latest bounds after 150ms', () => {
    vi.useFakeTimers();
    let bounds = 'first';
    const events: string[] = [];
    const scheduling = createChartMapScheduling(
      { resize() {}, viewport: () => events.push(bounds) },
      { request: () => 1, cancel() {} },
    );
    scheduling.viewport();
    vi.advanceTimersByTime(100);
    bounds = 'last';
    scheduling.viewport();
    vi.advanceTimersByTime(149);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(events).toEqual(['last']);
    scheduling.dispose();
  });

  it('coalesces panel resizes to one animation frame and cancels pending work on disposal', () => {
    vi.useFakeTimers();
    let pending: FrameRequestCallback | undefined;
    const resize = vi.fn();
    const cancel = vi.fn();
    const scheduling = createChartMapScheduling(
      { resize, viewport: vi.fn() },
      {
        request: (callback) => {
          pending = callback;
          return 42;
        },
        cancel,
      },
    );
    scheduling.resize();
    scheduling.resize();
    expect(resize).toHaveBeenCalledTimes(0);
    pending?.(0);
    expect(resize).toHaveBeenCalledTimes(1);
    scheduling.resize();
    scheduling.viewport();
    scheduling.dispose();
    expect(cancel).toHaveBeenCalledWith(42);
    expect(vi.getTimerCount()).toBe(0);
    pending?.(0);
    scheduling.resize();
    expect(resize).toHaveBeenCalledTimes(1);
  });
});
