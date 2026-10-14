import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { HeatmapQuery, HeatmapResult } from '@ais/contracts';
import { useAisHeatmap } from './app/composables/useAisHeatmap';

afterEach(() => vi.unstubAllGlobals());
const query: HeatmapQuery = {
  bbox: [110, 10, 130, 30],
  from: '2026-10-14T00:00:00Z',
  to: '2026-10-14T01:00:00Z',
};
const result: HeatmapResult = {
  query,
  grid: { level: 4, cellDegrees: 22.5 },
  cells: [{ id: '4:13:4', x: 13, y: 4, lon: 123.75, lat: 11.25, vesselCount: 3 }],
  totalVessels: 3,
  generatedAt: query.to,
  metric: 'unique_vessels',
  shipTypeBasis: 'current_profile',
};
function setup(api: (path: string, options?: unknown) => Promise<unknown>) {
  const scope = effectScope();
  const identity = ref({ user: { id: 'a' } });
  vi.stubGlobal('usePlatform', () => ({ api, session: identity }));
  const state = scope.run(() => useAisHeatmap())!;
  return { state, identity, stop: () => scope.stop() };
}
describe('AIS 热图展示生命周期', () => {
  it('账号切换清空结果并使旧请求和自动展示票据失效', async () => {
    const h = setup(async () => result);
    h.state.showSnapshot(result);
    const token = h.state.beginAgent();
    h.identity.value = { user: { id: 'b' } };
    expect(h.state.result.value).toBeNull();
    expect(
      h.state.acceptAgent(
        { ...result, kind: 'ais_heatmap', version: 1, inputRevision: 1 },
        's:t',
        token,
      ),
    ).toBe(false);
    h.stop();
  });
  it('取消加载发出abort且新请求优先，413提供缩小范围提示', async () => {
    let signal: AbortSignal | undefined;
    const h = setup(async (_url, options) => {
      signal = (options as { signal: AbortSignal }).signal;
      throw Object.assign(new Error('limit'), { status: 413 });
    });
    await h.state.generate(query, new Date(query.to));
    expect(h.state.error.value).toContain('缩小区域');
    h.state.cancel();
    expect(signal?.aborted).toBe(true);
    h.stop();
  });
  it('请求固定快照且关闭后迟到结果无法恢复图层', async () => {
    let resolve!: (value: unknown) => void;
    let path = '';
    const h = setup(async (url) => {
      path = url;
      return new Promise((r) => {
        resolve = r;
      });
    });
    const input = structuredClone(query);
    const pending = h.state.generate(input, new Date(query.to));
    input.bbox[0] = 1;
    expect(h.state.lockedQuery.value?.bbox[0]).toBe(110);
    expect(path).toContain('bbox=110%2C10%2C130%2C30');
    h.state.close();
    resolve(result);
    await pending;
    expect(h.state.result.value).toBeNull();
    expect(h.state.loading.value).toBe(false);
    h.stop();
  });
  it('手动更新使先前智能体票据失效；同一版本只展示一次', async () => {
    const h = setup(async () => result);
    const token = h.state.beginAgent();
    await h.state.generate(query, new Date(query.to));
    const agentResult = { ...result, kind: 'ais_heatmap' as const, version: 1, inputRevision: 2 };
    expect(h.state.acceptAgent(agentResult, 's:t', token)).toBe(false);
    const current = h.state.beginAgent();
    expect(h.state.acceptAgent(agentResult, 's:t', current)).toBe(true);
    expect(h.state.acceptAgent(agentResult, 's:t', current)).toBe(false);
    h.state.close();
    expect(h.state.acceptAgent(agentResult, 's:t', current)).toBe(false);
    h.stop();
  });
  it('限制时间并拒绝超量响应，零结果仍可展示历史快照', async () => {
    const api = vi.fn(async () => ({ ...result, cells: Array(4097).fill(result.cells[0]) }));
    const h = setup(api);
    await h.state.generate({ ...query, from: '2026-09-01T00:00:00Z' }, new Date(query.to));
    expect(api).not.toHaveBeenCalled();
    await h.state.generate(query, new Date(query.to));
    expect(h.state.result.value).toBeNull();
    expect(h.state.error.value).toContain('范围');
    expect(h.state.showSnapshot({ ...result, cells: [], totalVessels: 0 })).toBe(true);
    expect(h.state.result.value?.totalVessels).toBe(0);
    h.stop();
  });
});
