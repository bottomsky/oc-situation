import { expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import { VesselsController } from './controller';

it('批量最新船位使用保留期和参数化查询，按请求顺序报告缺失船舶', async () => {
  const observation = { mmsi: '123456789', lon: 122, lat: 30, observedAt: '2026-10-17T00:00:00Z' };
  const query = vi.fn().mockResolvedValue({ rows: [{ mmsi: observation.mmsi, observation }] });
  const api = new VesselsController({ pool: { query } } as unknown as Infrastructure);
  const result = await api.positions({ mmsis: '123456789,223456789,123456789' });
  expect(query.mock.calls[0]![0]).toContain("observed_at>=now()-interval '30 days'");
  expect(query.mock.calls[0]![1]).toEqual([['123456789', '223456789']]);
  expect(result.items).toEqual([observation]);
  expect(result.missing).toEqual(['223456789']);
});

it('批量最新船位拒绝空值、非法值及超过100个输入', async () => {
  const query = vi.fn();
  const api = new VesselsController({ pool: { query } } as unknown as Infrastructure);
  for (const mmsis of ['', 'abc', '123456789,', Array(101).fill('123456789').join(',')])
    await expect(api.positions({ mmsis })).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
});

it('损坏或无效经纬度不下发到地图，作为缺失目标返回', async () => {
  const query = vi.fn().mockResolvedValue({
    rows: [
      {
        mmsi: '123456789',
        observation: { lon: 181, lat: 30, observedAt: '2026-10-17T00:00:00Z' },
      },
    ],
  });
  const api = new VesselsController({ pool: { query } } as unknown as Infrastructure);
  expect((await api.positions({ mmsis: '123456789' })).missing).toEqual(['123456789']);
});
