import { expect, it } from 'vitest';
import {
  chartPalette,
  createManifestStyle,
  predictionGeoJson,
  coverageOutline,
  predictionDensityGeoJson,
  predictionDensityPaint,
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
    data: '/maps/v1/land.geojson',
    attribution: 'OSM',
  });
  expect(style.layers[0]?.paint).toMatchObject({ 'background-color': chartPalette.light.sea });
  expect(JSON.stringify(style)).not.toContain('tile.openstreetmap.org');
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
