import { expect, it } from 'vitest';
import {
  chartPalette,
  createManifestStyle,
  predictionGeoJson,
  coverageOutline,
  predictionDensityGeoJson,
  predictionDensityPaint,
  createRegionalChartCoverage,
  applyChartTheme,
  type ChartManifest,
} from './app/utils/chartPresentation';
it('平滑密度只改变呈现，中心点保留实际格网概率并按实际格宽缩放核半径', () => {
  const geometry = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [120, 30],
        [121, 30],
        [121, 31],
        [120, 31],
        [120, 30],
      ],
    ],
  };
  const result = {
    status: 'ready' as const,
    horizons: [
      {
        minutes: 15,
        gridSizeMeters: 200,
        positionCells: [{ id: 'p', probability: 0.002, geometry }],
        passageCells: [],
        coverage: [],
      },
    ],
  };
  const density = predictionDensityGeoJson(result, 15, 'position');
  expect(density.features[0]?.geometry).toEqual({ type: 'Point', coordinates: [120.5, 30.5] });
  expect(density.features[0]?.properties).toMatchObject({
    probability: 0.002,
    gridSizeMeters: 200,
  });
  expect(predictionDensityPaint(result, 15, 'position')?.['heatmap-weight']).toEqual([
    'get',
    'probability',
  ]);
  expect(
    predictionDensityGeoJson({ ...result, status: 'model_not_applicable' }, 15, 'position')
      .features,
  ).toEqual([]);
});
it('不适用模型即使保留诊断horizons也不绘制正式概率', () => {
  const geometry = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  };
  expect(
    predictionGeoJson(
      {
        status: 'model_not_applicable',
        horizons: [
          {
            minutes: 15,
            positionCells: [{ id: 'diagnostic', probability: 0.4, geometry }],
            passageCells: [],
            coverage: [],
          },
        ],
      },
      15,
      'position',
    ).features,
  ).toEqual([]);
});
it('累计覆盖区消除相邻网格共享边，保留外侧轮廓', () => {
  const outline = coverageOutline({
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
          [0, 0],
        ],
      ],
      [
        [
          [1, 0],
          [2, 0],
          [2, 1],
          [1, 1],
          [1, 0],
        ],
      ],
    ],
  });
  expect(outline.coordinates).toHaveLength(6);
  expect(outline.coordinates.some((edge) => edge[0]?.[0] === 1 && edge[1]?.[0] === 1)).toBe(false);
});
it('位置格网归一化相对密度，同时保留真实概率', () => {
  const geometry = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  };
  const data = {
    horizons: [
      {
        minutes: 15,
        positionCells: [{ id: 'p', probability: 0.002, geometry }],
        passageCells: [],
        coverage: [],
      },
    ],
  };
  expect(predictionGeoJson(data, 15, 'position').features[0]?.properties).toMatchObject({
    probability: 0.002,
    intensity: 1,
  });
});
it('浅深样式共用自托管资源与署名，缺失资源明确保留地理参考', () => {
  const style = createManifestStyle('light', {
    version: 'v1',
    coverage: [105, 3, 135, 42],
    land: { url: '/maps/v1/land.geojson', status: 'available', attribution: 'OSM' },
  });
  expect(style.sources['local-land']).toMatchObject({
    data: '/maps/ne_110m_land.geojson',
    attribution: 'Natural Earth · Public domain',
  });
  expect(style.sources).not.toHaveProperty('regional-land');
  expect(style.layers[0]?.paint).toMatchObject({ 'background-color': chartPalette.light.sea });
  expect(JSON.stringify(style)).not.toContain('tile.openstreetmap.org');
});

const regionalManifest: ChartManifest = {
  version: 'v3',
  coverage: [105, 3, 135, 42],
  land: { status: 'available', url: '/maps/v3/land.geojson', attribution: 'OSM' },
  coastline: { status: 'available', url: '/maps/v3/coastline.geojson', attribution: 'OSM' },
};

it('区域陆地与专用海岸线独立叠加于全球背景，覆盖海水遮罩初始隐藏且没有裁切描边', () => {
  const style = createManifestStyle('dark', regionalManifest);
  expect(style.sources['local-land']).toMatchObject({ data: '/maps/ne_110m_land.geojson' });
  expect(style.sources['regional-land']).toMatchObject({ data: regionalManifest.land.url });
  expect(style.sources['regional-coastline']).toMatchObject({
    data: regionalManifest.coastline?.url,
  });
  const ids = ['regional-sea-mask', 'regional-land', 'regional-coastline'];
  expect(style.layers.slice(3, 6).map((layer) => layer.id)).toEqual(ids);
  for (const id of ids) {
    const layer = style.layers.find((layer) => layer.id === id)!;
    expect(layer.layout?.visibility).not.toBe('none');
    expect(layer.paint).toMatchObject(
      layer.type === 'line' ? { 'line-opacity': 0 } : { 'fill-opacity': 0 },
    );
  }
  expect(style.layers.find((layer) => layer.id === 'regional-coastline')).toMatchObject({
    type: 'line',
    source: 'regional-coastline',
  });
  expect(
    style.layers.filter((layer) => layer.type === 'line' && layer.source === 'regional-land'),
  ).toEqual([]);
});

it('缺失、旧版或无效区域资源均保留全球背景且不创建覆盖遮罩', () => {
  for (const manifest of [
    null,
    { ...regionalManifest, coastline: undefined },
    { ...regionalManifest, coastline: { status: 'missing' } },
    { ...regionalManifest, coastline: { status: 'available', url: '//remote/coast.json' } },
    { ...regionalManifest, coverage: [135, 3, 105, 42] },
  ]) {
    const style = createManifestStyle('light', manifest);
    expect(style.sources['local-land']).toMatchObject({ data: '/maps/ne_110m_land.geojson' });
    expect(style.sources).not.toHaveProperty('regional-sea-mask');
    expect(style.layers.some((layer) => layer.id.startsWith('regional-'))).toBe(false);
  }
});

function regionalMap() {
  const style = createManifestStyle('dark', regionalManifest);
  const loaded = new Set<string>();
  const listeners = new Map<string, Set<(event: { sourceId?: string }) => void>>();
  const map = {
    getLayer: (id: string) => style.layers.find((layer) => layer.id === id),
    getSource: (id: string) => style.sources[id],
    isSourceLoaded: (id: string) => loaded.has(id),
    setLayoutProperty(id: string, _name: string, value: unknown) {
      const layer = style.layers.find((layer) => layer.id === id)!;
      layer.layout = { ...layer.layout, visibility: value as 'none' | 'visible' };
    },
    setPaintProperty(id: string, name: string, value: unknown) {
      const layer = style.layers.find((layer) => layer.id === id)!;
      layer.paint = { ...layer.paint, [name]: value } as typeof layer.paint;
    },
    on(type: string, listener: (event: { sourceId?: string }) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    off(type: string, listener: (event: { sourceId?: string }) => void) {
      listeners.get(type)?.delete(listener);
    },
  };
  return {
    style,
    map,
    loaded,
    listeners,
    fire: (type: string, sourceId?: string) => {
      for (const listener of listeners.get(type) ?? []) listener({ sourceId });
    },
  };
}

it('三源成功就绪才一起启用区域组，错误时原子回退且迟到事件不能复活遮罩', () => {
  const fixture = regionalMap();
  const states: string[] = [];
  const lifecycle = createRegionalChartCoverage(fixture.map, (state) => states.push(state));
  const visibility = () =>
    fixture.style.layers
      .filter((layer) => layer.id.startsWith('regional-'))
      .map((layer) => layer.paint?.[layer.type === 'line' ? 'line-opacity' : 'fill-opacity']);
  expect(visibility()).toEqual([0, 0, 0]);
  fixture.loaded.add('regional-land');
  fixture.loaded.add('regional-sea-mask');
  fixture.fire('sourcedata', 'regional-land');
  expect(visibility()).toEqual([0, 0, 0]);
  fixture.loaded.add('regional-coastline');
  fixture.fire('sourcedata', 'regional-coastline');
  expect(visibility()).toEqual([0, 0, 0]);
  // The render happens after MapLibre updates source use and requests viewport tiles.
  fixture.fire('render');
  expect(visibility()).toEqual([1, 1, 1]);
  fixture.fire('error', 'ports');
  expect(visibility()).toEqual([1, 1, 1]);
  fixture.fire('error', 'regional-land');
  expect(visibility()).toEqual([0, 0, 0]);
  fixture.fire('sourcedata', 'regional-land');
  fixture.fire('render');
  expect(visibility()).toEqual([0, 0, 0]);
  expect(states).toEqual(['loading', 'ready', 'fallback']);
  lifecycle.dispose();
  expect([...fixture.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
});

it('资源初次加载失败保持全球背景，生命周期卸载后停止监听', () => {
  const fixture = regionalMap();
  const states: string[] = [];
  const lifecycle = createRegionalChartCoverage(fixture.map, (state) => states.push(state));
  fixture.fire('error', 'regional-coastline');
  expect(states).toEqual(['loading', 'fallback']);
  expect(
    fixture.style.layers.find((layer) => layer.id === 'regional-sea-mask')?.paint,
  ).toMatchObject({ 'fill-opacity': 0 });
  expect(
    fixture.style.layers.find((layer) => layer.id === 'local-land')?.layout?.visibility,
  ).not.toBe('none');
  lifecycle.dispose();
});

it('新视口加载期间共同回退，移动结束且三源当前瓦片就绪后恢复，AIS事件保持区域状态', () => {
  const fixture = regionalMap();
  const states: string[] = [];
  const lifecycle = createRegionalChartCoverage(fixture.map, (state) => states.push(state));
  for (const id of ['regional-sea-mask', 'regional-land', 'regional-coastline'])
    fixture.loaded.add(id);
  const opacity = () =>
    fixture.style.layers.find((layer) => layer.id === 'regional-sea-mask')?.paint;
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 1 });
  fixture.fire('sourcedataloading', 'vessels');
  expect(opacity()).toMatchObject({ 'fill-opacity': 1 });
  fixture.fire('movestart');
  expect(opacity()).toMatchObject({ 'fill-opacity': 0 });
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 0 });
  fixture.loaded.delete('regional-land');
  fixture.fire('moveend');
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 0 });
  fixture.loaded.add('regional-land');
  fixture.fire('sourcedata', 'regional-land');
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 1 });
  fixture.loaded.delete('regional-coastline');
  fixture.fire('sourcedataloading', 'regional-coastline');
  expect(opacity()).toMatchObject({ 'fill-opacity': 0 });
  fixture.loaded.add('regional-coastline');
  fixture.fire('sourcedata', 'regional-coastline');
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 1 });
  fixture.fire('error', 'regional-land');
  fixture.fire('movestart');
  fixture.fire('moveend');
  fixture.fire('render');
  expect(opacity()).toMatchObject({ 'fill-opacity': 0 });
  expect(states).toEqual(['loading', 'ready', 'loading', 'ready', 'loading', 'ready', 'fallback']);
  lifecycle.dispose();
});

it('缺少专用海岸线的样式立即回退，主题修改保留未就绪遮罩透明状态', () => {
  const fixture = regionalMap();
  delete fixture.style.sources['regional-coastline'];
  const states: string[] = [];
  const lifecycle = createRegionalChartCoverage(fixture.map, (state) => states.push(state));
  applyChartTheme(fixture.map, 'light');
  expect(states).toEqual(['fallback']);
  expect(
    fixture.style.layers.find((layer) => layer.id === 'regional-sea-mask')?.paint,
  ).toMatchObject({
    'fill-opacity': 0,
    'fill-color': chartPalette.light.sea,
  });
  lifecycle.dispose();
});

it('浅深主题同步更新全球、区域、遮罩与港口描边而不重建样式', () => {
  for (const theme of ['dark', 'light'] as const) {
    const fixture = regionalMap();
    applyChartTheme(fixture.map, theme);
    const paint = (id: string) => fixture.style.layers.find((layer) => layer.id === id)?.paint;
    expect(paint('local-sea')).toMatchObject({ 'background-color': chartPalette[theme].sea });
    expect(paint('regional-sea-mask')).toMatchObject({
      'fill-color': chartPalette[theme].sea,
      'fill-antialias': false,
    });
    for (const id of ['local-land', 'regional-land'])
      expect(paint(id)).toMatchObject({ 'fill-color': chartPalette[theme].land });
    for (const id of ['local-coastline', 'regional-coastline'])
      expect(paint(id)).toMatchObject({ 'line-color': chartPalette[theme].coast });
  }
});
it('位置与沿途视图只发出所选时刻的概率格，区域分级互斥', () => {
  const geometry = {
    type: 'Polygon' as const,
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  };
  const result = {
    horizons: [
      {
        minutes: 15,
        positionCells: [{ id: 'p', probability: 0.5, geometry }],
        passageCells: [{ id: 'c', probability: 0.8, geometry }],
        coverage: [],
      },
    ],
  };
  expect(predictionGeoJson(result, 15, 'position').features[0]?.properties?.id).toBe('p');
  expect(predictionGeoJson(result, 15, 'passage').features[0]?.properties?.id).toBe('c');
  expect(predictionGeoJson(result, 30, 'position').features).toEqual([]);
});
