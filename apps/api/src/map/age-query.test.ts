import { expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import { MapPointQuerySchema } from '../../../../packages/contracts/map-snapshot';
import { MapController } from './controller';
import { parseMapPointHttpQuery } from './points-query';
import { MapQuerySchema, parseMapQuery } from './query';

const bbox = '-180,-90,180,90';

it.each([1 / 60, 0.25, 0.5, 1, 24, 720])(
  'HTTP、WS和单船快照以兼容hours字段保留%s小时观测范围',
  (hours) => {
    expect(parseMapQuery({ bbox, hours: String(hours) }).hours).toBe(hours);
    expect(parseMapPointHttpQuery({ bbox, hours: String(hours) })).toMatchObject({ hours });
    expect(MapPointQuerySchema.parse({ bbox: [-180, -90, 180, 90], hours }).hours).toBe(hours);
  },
);

it.each([0, -1, 1 / 120, 720.01, Infinity, NaN])(
  'HTTP和快照均明确拒绝范围外的%s小时观测窗口',
  (hours) => {
    expect(MapQuerySchema.safeParse({ bbox, hours }).success).toBe(false);
    expect(MapPointQuerySchema.safeParse({ bbox: [-180, -90, 180, 90], hours }).success).toBe(
      false,
    );
  },
);

it('未指定范围继续使用24小时默认值', () => {
  expect(parseMapQuery({ bbox }).hours).toBe(24);
  expect(MapPointQuerySchema.parse({ bbox: [-180, -90, 180, 90] }).hours).toBe(24);
});

it.each([3, 8])('旧地图协议zoom=%s也保留30分钟范围，不经过整数小时截断', async (zoom) => {
  const query = vi.fn().mockResolvedValue({ rows: [] });
  await new MapController({ pool: { query } } as unknown as Infrastructure).get({
    bbox,
    zoom,
    hours: 0.5,
  });
  expect(query.mock.calls[0]![1][0]).toBe(0.5);
  expect(query.mock.calls[0]![0]).toContain('make_interval(secs=>');
  expect(query.mock.calls[0]![0]).not.toContain('make_interval(hours=>');
});
