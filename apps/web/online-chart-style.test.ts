import { expect, it } from 'vitest';
import { readOnlineChartConfig } from './app/utils/onlineChartStyle';
import * as online from './app/utils/onlineChartStyle';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LayerSpecification, SymbolLayerSpecification } from 'maplibre-gl';
import { chartPalette, createManifestStyle } from './app/utils/chartPresentation';

it('提供可装配在线层组与切换主题的公开接口', () => {
  expect(online.addOnlineChartStyle).toBeTypeOf('function');
  expect(online.applyOnlineChartTheme).toBeTypeOf('function');
  expect(online.ONLINE_BASE_LAYER_OPACITIES).toBeInstanceOf(Array);
});

it('提供可规范化部署配置的在线海图样式模块', async () => {
  const path = './app/utils/onlineChartStyle';
  const online = await import(path).catch(() => undefined);
  expect(online?.readOnlineChartConfig).toBeTypeOf('function');
});

it('默认使用独立启用的官方公开图源', () => {
  expect(readOnlineChartConfig()).toEqual({
    enabled: true,
    vectorTileJsonUrl: 'https://vector.openstreetmap.org/shortbread_v1/tilejson.json',
    seamarksEnabled: true,
    seamarkTilesUrl: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png',
  });
});

it('接受部署布尔值和字符串开关，各图源独立关闭', () => {
  for (const disabled of [false, 'false', ' FALSE ']) {
    expect(readOnlineChartConfig({ chartOnlineEnabled: disabled })).toMatchObject({
      enabled: false,
      seamarksEnabled: true,
    });
    expect(readOnlineChartConfig({ chartSeamarksEnabled: disabled })).toMatchObject({
      enabled: true,
      seamarksEnabled: false,
    });
  }
  expect(
    readOnlineChartConfig({
      chartOnlineEnabled: 'true',
      chartSeamarksEnabled: true,
      chartVectorTileJsonUrl: 'https://maps.example.org/shortbread.json?edition=1',
      chartSeamarkTilesUrl: 'https://maps.example.org/seamark/{z}/{x}/{y}.png',
      mapStyleUrl: 'https://unused.example.org/style.json',
      mapTilerKey: 'unused',
    }),
  ).toEqual({
    enabled: true,
    seamarksEnabled: true,
    vectorTileJsonUrl: 'https://maps.example.org/shortbread.json?edition=1',
    seamarkTilesUrl: 'https://maps.example.org/seamark/{z}/{x}/{y}.png',
  });
});

it('无效配置仅关闭对应图源并返回不含凭证的诊断', () => {
  for (const invalid of [
    '',
    42,
    '//maps.example.org/data.json',
    'http://maps.example.org/data.json',
    'javascript:alert(1)',
    'https://user:secret@maps.example.org/data.json',
    'https://maps.example.org/data.json#fragment',
    'https://maps.example.org/\ndata.json',
  ]) {
    const diagnostics: string[] = [];
    const config = readOnlineChartConfig({ chartVectorTileJsonUrl: invalid }, (message: string) =>
      diagnostics.push(message),
    );
    expect(config).toMatchObject({ enabled: false, vectorTileJsonUrl: '', seamarksEnabled: true });
    expect(diagnostics.join(' ')).toContain('chartVectorTileJsonUrl');
    expect(diagnostics.join(' ')).not.toContain('secret');
    expect(readOnlineChartConfig({ chartSeamarkTilesUrl: invalid })).toMatchObject({
      enabled: true,
      seamarksEnabled: false,
      seamarkTilesUrl: '',
    });
  }
  expect(
    readOnlineChartConfig({ chartSeamarkTilesUrl: 'https://maps.example.org/seamark.png' }),
  ).toMatchObject({ seamarksEnabled: false });
  expect(readOnlineChartConfig({ chartOnlineEnabled: 'maybe' })).toMatchObject({ enabled: false });
});

function localStyle(theme: 'dark' | 'light' = 'light') {
  return createManifestStyle(theme, {
    version: 'v3',
    coverage: [105, 3, 135, 42],
    land: { status: 'available', url: '/maps/land.geojson' },
    coastline: { status: 'available', url: '/maps/coastline.geojson' },
    ports: { status: 'available', url: '/maps/ports.geojson' },
    seamarks: { status: 'available', url: '/maps/seamarks.geojson' },
  });
}

function paintProperty(layer: LayerSpecification, property: string): unknown {
  return (layer.paint as Record<string, unknown> | undefined)?.[property];
}

it('默认样式采用已查证的 Shortbread schema、XYZ 海标与完整署名', () => {
  const style = online.addOnlineChartStyle(localStyle(), 'light', readOnlineChartConfig());
  expect(online.ONLINE_VECTOR_SOURCE_ID).toBe('online-osm');
  expect(online.ONLINE_SEAMARK_SOURCE_ID).toBe('online-seamarks');
  expect(online.ONLINE_SEAMARK_LAYER_ID).toBe('online-seamarks');
  expect(style.sources['online-osm']).toMatchObject({
    type: 'vector',
    url: 'https://vector.openstreetmap.org/shortbread_v1/tilejson.json',
    attribution: expect.stringContaining('https://www.openstreetmap.org/copyright'),
  });
  expect(style.sources['online-seamarks']).toMatchObject({
    type: 'raster',
    scheme: 'xyz',
    tileSize: 256,
    maxzoom: 18,
    tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
    attribution: expect.stringContaining('OpenSeaMap'),
  });
  expect(JSON.stringify(style.sources['online-seamarks'])).toContain(
    'https://creativecommons.org/licenses/by-sa/2.0/',
  );
  const layers = style.layers.filter((layer) => 'source' in layer && layer.source === 'online-osm');
  expect(
    new Set(layers.map((layer) => ('source-layer' in layer ? layer['source-layer'] : undefined))),
  ).toEqual(
    new Set([
      'ocean',
      'water_polygons',
      'water_lines',
      'land',
      'streets',
      'buildings',
      'boundaries',
      'place_labels',
      'boundary_labels',
      'pier_lines',
      'pier_polygons',
    ]),
  );
  expect(style.layers.find((layer) => layer.id === 'online-buildings')?.minzoom).toBe(14);
});

it('完整在线组位于本地回退上方、港口和业务下方，装配保留输入样式', () => {
  const base = localStyle();
  const original = structuredClone(base);
  const style = online.addOnlineChartStyle(base, 'light', readOnlineChartConfig());
  const index = (id: string) => style.layers.findIndex((layer) => layer.id === id);
  expect(base).toEqual(original);
  expect(style.sources['local-land']).toEqual(base.sources['local-land']);
  expect(index('online-background')).toBeGreaterThan(index('regional-coastline'));
  expect(index('base-ports')).toBeGreaterThan(index('online-place-labels'));
  expect(index('online-seamarks')).toBeGreaterThan(index('base-seamarks'));
  expect(style.layers.at(-1)?.id).toBe('online-seamarks');
  expect(style.layers.filter((layer) => !layer.id.startsWith('online-'))).toEqual(base.layers);
});

it('底图和海标按各自开关装配，全部关闭时完整保留本地样式', () => {
  const base = localStyle();
  for (const enabled of [true, false])
    for (const seamarksEnabled of [true, false]) {
      const config = { ...readOnlineChartConfig(), enabled, seamarksEnabled };
      const style = online.addOnlineChartStyle(base, 'dark', config);
      expect(Boolean(style.sources['online-osm'])).toBe(enabled);
      expect(Boolean(style.sources['online-seamarks'])).toBe(seamarksEnabled);
      expect(style.layers.some((layer) => layer.id === 'online-background')).toBe(enabled);
      if (!enabled && !seamarksEnabled) expect(style).toEqual(base);
      expect(validateStyleMin(style)).toEqual([]);
    }
});

it('全部在线图层以透明方式预热，完整组记录设计 opacity 并禁止淡入淡出', () => {
  const style = online.addOnlineChartStyle(localStyle(), 'light', readOnlineChartConfig());
  const layers = style.layers.filter((layer) => layer.id.startsWith('online-'));
  expect(online.ONLINE_BASE_LAYER_OPACITIES.length).toBeGreaterThan(10);
  expect(online.ONLINE_BASE_LAYER_OPACITIES).toContainEqual({
    id: 'online-background',
    property: 'background-opacity',
    readyValue: 1,
  });
  for (const layer of layers) {
    const property = `${layer.type === 'symbol' ? 'text' : layer.type}-opacity`;
    expect(layer.layout?.visibility).not.toBe('none');
    expect(paintProperty(layer, property)).toBe(0);
    expect(paintProperty(layer, `${property}-transition`)).toEqual({ duration: 0, delay: 0 });
    if (layer.type !== 'raster')
      expect(
        online.ONLINE_BASE_LAYER_OPACITIES.find((entry) => entry.id === layer.id),
      ).toMatchObject({
        property,
        readyValue: expect.any(Number),
      });
  }
  expect(online.ONLINE_BASE_LAYER_OPACITIES.some((entry) => entry.readyValue < 1)).toBe(true);
});

it('浅深主题均为合法样式并使用本地文字渲染，无 glyph 或 sprite 依赖', () => {
  for (const theme of ['dark', 'light'] as const) {
    const style = online.addOnlineChartStyle(localStyle(theme), theme, readOnlineChartConfig());
    expect(validateStyleMin(style)).toEqual([]);
    expect(style).not.toHaveProperty('glyphs');
    expect(style).not.toHaveProperty('sprite');
    expect(style.layers.find((layer) => layer.id === 'online-background')?.paint).toMatchObject({
      'background-color': chartPalette[theme].land,
    });
    expect(style.layers.find((layer) => layer.id === 'online-ocean')?.paint).toMatchObject({
      'fill-color': chartPalette[theme].sea,
    });
    const labels = style.layers.filter(
      (layer): layer is SymbolLayerSpecification =>
        layer.id.startsWith('online-') && layer.type === 'symbol',
    );
    expect(labels.length).toBeGreaterThanOrEqual(2);
    for (const layer of labels) {
      expect(layer.layout?.['text-font']).toEqual([
        'Microsoft YaHei',
        'Noto Sans CJK SC',
        'Segoe UI',
        'sans-serif',
      ]);
      expect(layer.layout).not.toHaveProperty('icon-image');
      expect(layer.layout?.['text-field']).toBeTruthy();
    }
  }
});

it('切换主题只更新现有在线层的颜色，保留当前显隐、源和业务图层', () => {
  const style = online.addOnlineChartStyle(localStyle(), 'light', readOnlineChartConfig());
  const writes: { id: string; name: string; value: unknown }[] = [];
  const map = {
    getLayer: (id: string) => style.layers.find((layer) => layer.id === id),
    setPaintProperty: (id: string, name: string, value: unknown) => {
      writes.push({ id, name, value });
    },
  };
  online.applyOnlineChartTheme(map, 'dark');
  expect(writes.length).toBeGreaterThan(10);
  expect(writes).toContainEqual({
    id: 'online-background',
    name: 'background-color',
    value: chartPalette.dark.land,
  });
  expect(
    writes.every((write) => write.id.startsWith('online-') && write.name.endsWith('color')),
  ).toBe(true);
  const themeStyle = online.addOnlineChartStyle(
    localStyle('dark'),
    'dark',
    readOnlineChartConfig(),
  );
  for (const write of writes) {
    const layer = themeStyle.layers.find((layer) => layer.id === write.id)!;
    expect(paintProperty(layer, write.name)).toEqual(write.value);
  }
  const onlyBackground: string[] = [];
  online.applyOnlineChartTheme(
    {
      getLayer: (id) => id === 'online-background',
      setPaintProperty: (id) => {
        onlyBackground.push(id);
      },
    },
    'light',
  );
  expect(onlyBackground).toEqual(['online-background']);
});
