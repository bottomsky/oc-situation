import { describe, expect, it } from 'vitest';
import {
  readChartPreference,
  writeChartPreference,
  createRequestGeneration,
  visibleVesselRows,
} from './app/utils/chartWorkspace';

describe('海图工作台状态边界', () => {
  it('面板偏好按账号隔离且损坏存储回到响应式默认值', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    writeChartPreference(storage, 'user-a', 'left', false);
    expect(readChartPreference(storage, 'user-a', 'left', true)).toBe(false);
    expect(readChartPreference(storage, 'user-b', 'left', true)).toBe(true);
    for (const key of values.keys()) values.set(key, '{broken');
    expect(readChartPreference(storage, 'user-a', 'left', true)).toBe(true);
  });
  it('新请求和清空操作使旧响应失效', () => {
    const requests = createRequestGeneration();
    const old = requests.next();
    expect(requests.isCurrent(old)).toBe(true);
    requests.next();
    expect(requests.isCurrent(old)).toBe(false);
  });
  it('聚合视图不伪装单船，并仅从既有缓存补船名', () => {
    const cluster = {
      kind: 'cluster' as const,
      clusterId: 'a',
      lat: 1,
      lon: 1,
      count: 20,
      bbox: [0, 0, 2, 2] as [number, number, number, number],
    };
    const point = {
      kind: 'point' as const,
      mmsi: '413000001',
      lat: 1,
      lon: 1,
      sogKnots: 4,
      cogDegrees: 20,
      headingDegrees: null,
      quality: [],
      sourceId: 'test',
      observedAt: '2026-10-01T00:00:00Z',
    };
    expect(visibleVesselRows([cluster], new Map())).toEqual([]);
    expect(visibleVesselRows([point, cluster], new Map([['413000001', '已缓存船名']]))).toEqual([
      { ...point, name: '已缓存船名' },
    ]);
  });
});
