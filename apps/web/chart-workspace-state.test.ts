import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref, watch } from 'vue';
import { useChartWorkspace } from './app/composables/useChartWorkspace';
import { createReplyObjectState } from './app/composables/useChartDetail';

afterEach(() => {
  vi.unstubAllGlobals();
});
function harness(api: (path: string) => Promise<unknown>) {
  const scope = effectScope();
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', () => {});
  vi.stubGlobal('onBeforeUnmount', () => {});
  vi.stubGlobal('useRoute', () => ({ query: {} }));
  vi.stubGlobal('usePlatform', () => ({ api }));
  const subscribeViewport = vi.fn();
  vi.stubGlobal('useFusionEvents', () => ({
    status: ref('live'),
    error: ref(''),
    feedError: ref(''),
    mapData: ref(null),
    subscribeViewport,
  }));
  const workspace = scope.run(() => useChartWorkspace())!;
  return { workspace, subscribeViewport, stop: () => scope.stop() };
}
describe('海图实际搜索状态', () => {
  it('新回复scope在清空选中对象之前使其真实在途详情失效', async () => {
    let resolve: (value: unknown) => void = () => {};
    const fixture = harness(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const state = createReplyObjectState(() => {
      if (state.selected.value) fixture.workspace.resetDetail();
    });
    state.setScope('task-one');
    state.select({
      key: 'ship',
      ref: { kind: 'vessel', id: '123456789' },
      label: '船甲',
      geometries: [],
      located: false,
    });
    const reading = fixture.workspace.select('123456789');
    state.setScope('task-two');
    resolve({ mmsi: '123456789', staticFields: {} });
    await reading;
    expect(fixture.workspace.detail.value).toBeNull();
    expect(state.selected.value).toBeNull();
    fixture.stop();
  });
  it('回复轮次重置使迟到船舶详情失效并清除局部错误', async () => {
    let resolve: (value: unknown) => void = () => {};
    const fixture = harness(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const reading = fixture.workspace.select('123456789');
    fixture.workspace.resetDetail();
    resolve({ mmsi: '123456789', staticFields: {} });
    await reading;
    expect(fixture.workspace.detail.value).toBeNull();
    expect(fixture.workspace.detailError.value).toBe('');
    fixture.stop();
  });
  it('连续三次视窗中断释放HTTP快照，旧完整结果保持到最新快照提交', async () => {
    const releases: string[] = [];
    const cursors: { id: string; resolve: (value: unknown) => void }[] = [];
    let count = 0;
    const point = (mmsi: string) => ({ kind: 'point', mmsi, lon: 120, lat: 30, quality: [] });
    const api = vi.fn(async (path: string, options?: { method?: string }) => {
      if (options?.method === 'DELETE') {
        releases.push(path.split('/').at(-1)!);
        return;
      }
      const url = new URL(path, 'http://test');
      if (url.searchParams.has('cursor'))
        return new Promise((resolve) =>
          cursors.push({ id: url.searchParams.get('snapshotId')!, resolve }),
        );
      const id = 'snapshot-' + ++count;
      return {
        snapshotId: id,
        sequence: 1,
        items: [point(id + 'a')],
        total: 2,
        nextCursor: 'next',
        complete: false,
        generatedAt: '2026-10-24T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      };
    });
    const { workspace, stop } = harness(api);
    workspace.data.value = { items: [point('old')], total: 1 } as never;
    workspace.viewport([120, 30, 124, 34], 6);
    for (let index = 0; index < 3; index++) {
      await vi.waitFor(() => expect(cursors).toHaveLength(index + 1));
      expect(
        workspace.data.value?.items[0]?.kind === 'point' && workspace.data.value.items[0].mmsi,
      ).toBe('old');
      if (index < 2) {
        workspace.viewport([121 + index, 30, 124, 34], 6);
      }
      cursors[index]!.resolve({
        snapshotId: cursors[index]!.id,
        sequence: 1,
        items: [point(cursors[index]!.id + 'b')],
        total: 2,
        nextCursor: null,
        complete: true,
        generatedAt: '2026-10-24T00:00:00Z',
        expiresAt: '2099-01-01T00:00:00Z',
      });
      await vi.waitFor(() => expect(releases).toHaveLength(index + 1));
    }
    expect(releases).toEqual(['snapshot-1', 'snapshot-2', 'snapshot-3']);
    expect(workspace.data.value?.items).toHaveLength(2);
    stop();
  });
  it('人工框选区域保持HTTP和WS同一范围，清除后恢复当前视窗', async () => {
    const api = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { workspace, subscribeViewport, stop } = harness(api);
    workspace.queryArea([120, 30, 121, 31]);
    await workspace.refresh();
    workspace.viewport([118, 28, 128, 41], 6);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new URL(api.mock.calls.at(-1)![0], 'http://test').searchParams.get('bbox')).toBe(
      '120,30,121,31',
    );
    expect(subscribeViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ bbox: '120,30,121,31' }),
    );
    workspace.queryArea(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(new URL(api.mock.calls.at(-1)![0], 'http://test').searchParams.get('bbox')).toBe(
      '118,28,128,41',
    );
    stop();
  });
  it.each([
    [-2, 0],
    [0.5, 0.5],
    [24, 22],
    [Number.NaN, 3],
  ])('地图缩放 %s 时 HTTP 与实时订阅均发送合法缩放 %s', async (input, expected) => {
    const api = vi.fn().mockResolvedValue({ items: [], total: 0 });
    const { workspace, subscribeViewport, stop } = harness(api);
    workspace.viewport([-180, -85, 180, 85], input);
    await Promise.resolve();
    expect(new URL(api.mock.calls[0]![0], 'http://test').searchParams.get('zoom')).toBe(
      String(expected),
    );
    expect(subscribeViewport).toHaveBeenCalledWith(
      expect.objectContaining({ bbox: '-180,-85,180,85', zoom: expected }),
    );
    stop();
  });
  it('编辑中的关键词不混入已执行搜索的分页游标', async () => {
    const calls: string[] = [];
    const { workspace, stop } = harness(async (path) => {
      calls.push(path);
      return { items: [], nextCursor: 'cursor-A' };
    });
    workspace.search.value = 'A';
    await workspace.find(false);
    workspace.search.value = 'B';
    await workspace.find(true);
    expect(new URL(calls[1]!, 'http://test').searchParams.get('query')).toBe('A');
    expect(new URL(calls[1]!, 'http://test').searchParams.get('cursor')).toBe('cursor-A');
    stop();
  });
  it('新首屏等待期间分页不能发出请求，失败仍明确显示旧结果所属查询', async () => {
    const calls: string[] = [];
    let rejectSearch: (reason: Error) => void = () => {};
    const { workspace, stop } = harness(async (path) => {
      calls.push(path);
      return calls.length === 1
        ? { items: [], nextCursor: 'cursor-A' }
        : new Promise((_, reject) => {
            rejectSearch = reject;
          });
    });
    workspace.search.value = 'A';
    await workspace.find(false);
    workspace.search.value = 'B';
    const pending = workspace.find(false);
    void workspace.find(true);
    expect(calls.length).toBe(2);
    rejectSearch(new Error('查询失败'));
    await pending;
    expect(workspace.appliedSearch.value).toBe('A');
    expect(workspace.searchError.value).toBe('查询失败');
    stop();
  });
});
