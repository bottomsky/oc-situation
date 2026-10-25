import { describe, expect, it } from 'vitest';
import {
  readChartPreference,
  writeChartPreference,
  createRequestGeneration,
  visibleVesselRows,
  vesselTablePage,
} from './app/utils/chartWorkspace';
import * as chartWorkspace from './app/utils/chartWorkspace';
import { createHandoffGeneration } from './app/utils/operationalEvents';

describe('海图工作台状态边界', () => {
  it('移除业务关注使已发出的同对象读取失权，保留另一类型同标识对象', async () => {
    expect(typeof chartWorkspace.removeManualFocusObject).toBe('function');
    const generation = createHandoffGeneration();
    const event = { kind: 'event', id: 'one' };
    let objects = [event, { kind: 'route', id: 'one' }];
    let finish: () => void = () => {};
    const allowed = generation.begin();
    const delayed = new Promise<void>((resolve) => {
      finish = resolve;
    }).then(() => {
      if (allowed()) objects.push(event);
    });
    objects = chartWorkspace.removeManualFocusObject(objects, event, generation.invalidate);
    finish();
    await delayed;
    expect(objects).toEqual([{ kind: 'route', id: 'one' }]);
  });
  it('海洋态势时间偏好按账号保存分钟级窗口，恢复时不覆盖前一账号', () => {
    expect(typeof chartWorkspace.createChartReportPreference).toBe('function');
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    let hours = 24;
    const preference = chartWorkspace.createChartReportPreference(storage, (value: number) => {
      hours = value;
      preference.persist(value);
    });
    preference.restore('user-a');
    expect(hours).toBe(24);
    preference.persist(0.25);
    preference.restore('user-b');
    expect(hours).toBe(24);
    preference.persist(0.5);
    preference.restore('user-a');
    expect(hours).toBe(0.25);
    preference.restore(null);
    expect(hours).toBe(24);
    preference.persist(1);
    preference.restore('user-b');
    expect(hours).toBe(0.5);
    expect(values.size).toBe(2);
  });
  it('海洋态势损坏、越界及不可用存储均恢复24小时，合法边界和小数保持', () => {
    expect(typeof chartWorkspace.createChartReportPreference).toBe('function');
    let stored = '0.5',
      hours = 0;
    const preference = chartWorkspace.createChartReportPreference(
      {
        getItem: () => stored,
        setItem: (_key: string, value: string) => {
          stored = value;
        },
      },
      (value: number) => {
        hours = value;
      },
    );
    for (const invalid of ['null', '"0.5"', '0', '721', '1.2345', 'false', '{broken']) {
      stored = invalid;
      preference.restore('user');
      expect(hours).toBe(24);
    }
    for (const value of [1 / 60, 0.25, 0.5, 24, 720]) {
      stored = JSON.stringify(value);
      preference.restore('user');
      expect(hours).toBe(value);
    }
    const unavailable = chartWorkspace.createChartReportPreference(
      {
        getItem: () => {
          throw new Error('restricted');
        },
        setItem: () => {
          throw new Error('quota');
        },
      },
      (value: number) => {
        hours = value;
      },
    );
    unavailable.restore('user');
    expect(hours).toBe(24);
    expect(() => unavailable.persist(0.25)).not.toThrow();
  });
  it('五万身份保留全量，表格只挂载当前100行并支持末页', () => {
    const ids = Array.from({ length: 50000 }, (_, i) => String(i));
    expect(vesselTablePage(ids, 0)).toEqual(ids.slice(0, 100));
    expect(vesselTablePage(ids, 499)).toEqual(ids.slice(49900));
    expect(ids).toHaveLength(50000);
  });
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
