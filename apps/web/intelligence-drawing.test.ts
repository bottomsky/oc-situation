import { expect, it } from 'vitest';
import { splitEditableGeometry, combineEditableGeometry } from './app/utils/intelligenceDrawing';
it('MultiPoint编辑其中一点后合并仍保留全部组件与原几何类型', () => {
  const original = {
    type: 'MultiPoint' as const,
    coordinates: [
      [122, 31],
      [123, 32],
    ] as [number, number][],
  };
  const parts = splitEditableGeometry(original);
  expect(parts).toHaveLength(2);
  parts[0] = { type: 'Point', coordinates: [122.5, 31.5] };
  expect(combineEditableGeometry(original.type, parts)).toEqual({
    type: 'MultiPoint',
    coordinates: [
      [122.5, 31.5],
      [123, 32],
    ],
  });
  expect(original.coordinates[0]).toEqual([122, 31]);
});
it('多线多面拆分与聚合保留所有线、环和面', () => {
  const line = {
    type: 'MultiLineString' as const,
    coordinates: [
      [
        [120, 30],
        [121, 31],
      ],
      [
        [122, 32],
        [123, 33],
      ],
    ],
  };
  expect(combineEditableGeometry(line.type, splitEditableGeometry(line))).toEqual(line);
  const polygon = {
    type: 'MultiPolygon' as const,
    coordinates: [
      [
        [
          [120, 30],
          [121, 30],
          [121, 31],
          [120, 30],
        ],
        [
          [120.1, 30.1],
          [120.2, 30.1],
          [120.2, 30.2],
          [120.1, 30.1],
        ],
      ],
      [
        [
          [122, 32],
          [123, 32],
          [123, 33],
          [122, 32],
        ],
      ],
    ],
  };
  expect(combineEditableGeometry(polygon.type, splitEditableGeometry(polygon))).toEqual(polygon);
});
it('单几何不可混入其他类型或多个组件，非法坐标在绘制前拒绝', () => {
  expect(() =>
    combineEditableGeometry('MultiPoint', [
      {
        type: 'LineString',
        coordinates: [
          [120, 30],
          [121, 31],
        ],
      },
    ]),
  ).toThrow();
  expect(() =>
    combineEditableGeometry('Point', [
      { type: 'Point', coordinates: [120, 30] },
      { type: 'Point', coordinates: [121, 31] },
    ]),
  ).toThrow();
  expect(() => splitEditableGeometry({ type: 'Point', coordinates: [999, 31] })).toThrow();
});
it('多组件顶点总量统一受限，不以每段低于上限绕过限制', () => {
  const line = Array.from({ length: 6000 }, (_, i) => [120 + i / 100000, 30]);
  expect(() =>
    splitEditableGeometry({ type: 'MultiLineString', coordinates: [line, line] }),
  ).toThrow(/10000/);
});
