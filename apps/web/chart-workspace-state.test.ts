import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref, watch } from 'vue';
import { useChartWorkspace } from './app/composables/useChartWorkspace';

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
  vi.stubGlobal('useFusionEvents', () => ({
    status: ref('live'),
    error: ref(''),
    mapData: ref(null),
    subscribeViewport: () => {},
  }));
  const workspace = scope.run(() => useChartWorkspace())!;
  return { workspace, stop: () => scope.stop() };
}
describe('海图实际搜索状态', () => {
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
