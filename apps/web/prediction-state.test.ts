import { expect, it, vi, afterEach } from 'vitest';
import { ref, computed } from 'vue';
import { useReachability } from './app/composables/useReachability';
afterEach(() => vi.unstubAllGlobals());
function setup(api: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('onBeforeUnmount', () => {});
  vi.stubGlobal('usePlatform', () => ({ api }));
  return useReachability();
}
it('运行单船使用真实API，最多20关注船且去重，保留旧结果直到读取成功', async () => {
  const api = vi.fn().mockResolvedValue({ items: [], instanceId: 'i', runId: 'r' });
  const state = setup(api);
  for (let i = 0; i < 21; i++) state.follow(String(100000000 + i));
  state.follow('100000000');
  expect(state.watchlist.value).toHaveLength(20);
  state.mmsi.value = '123456789';
  await state.run();
  expect(api).toHaveBeenCalledWith(
    '/topics/predictions',
    expect.objectContaining({ method: 'POST', body: { mmsi: '123456789' } }),
  );
});
it('输入错误不创建计算任务，接口失败显示可重试状态', async () => {
  const api = vi.fn().mockRejectedValue(new Error('服务不可用'));
  const state = setup(api);
  state.mmsi.value = 'abc';
  await state.run();
  expect(api).not.toHaveBeenCalled();
  state.mmsi.value = '123456789';
  await state.run();
  expect(state.error.value).toBe('服务不可用');
  expect(state.busy.value).toBe(false);
});
it('按服务端runId提交结果，服务端时钟落后仍可完成', async () => {
  const record = {
    id: 'result',
    runId: 'run-a',
    computedAt: '2020-01-01T00:00:00Z',
    prediction: { mmsi: '123456789' },
    impacts: [],
  };
  const api = vi.fn(async (path: string) =>
    path === '/topics/predictions'
      ? { instanceId: 'instance', runId: 'run-a' }
      : path === '/topics/runs/run-a'
        ? { status: 'succeeded' }
        : { items: [record] },
  );
  const state = setup(api);
  state.mmsi.value = '123456789';
  await state.run();
  expect(state.result.value?.id).toBe('result');
  expect(state.busy.value).toBe(false);
});
it('计算失败立即显示失败原因，保留上一完整结果', async () => {
  const api = vi.fn(async (path: string) =>
    path === '/topics/predictions'
      ? { instanceId: 'instance', runId: 'run-a' }
      : { status: 'failed', error: '近期方向不可靠' },
  );
  const state = setup(api);
  state.mmsi.value = '123456789';
  await state.run();
  expect(state.error.value).toContain('近期方向不可靠');
  expect(state.busy.value).toBe(false);
});
it('取消后原结果保留为历史，航警影响立即停用', async () => {
  const record = {
    id: 'result',
    runId: 'r',
    instanceId: 'i',
    computedAt: '2020-01-01T00:00:00Z',
    prediction: { mmsi: '123456789' },
    impacts: [{ warningId: 'w' }],
  };
  const api = vi.fn(async (path: string) =>
    path === '/topics/predictions'
      ? { instanceId: 'i', runId: 'r' }
      : path === '/topics/runs/r'
        ? { status: 'succeeded' }
        : path.endsWith('/cancel')
          ? { status: 'cancelled' }
          : { items: [record] },
  );
  const state = setup(api);
  state.mmsi.value = '123456789';
  await state.run();
  await state.cancel();
  expect(state.result.value?.id).toBe('result');
  expect(state.result.value?.stale).toBe(true);
  expect(state.result.value?.impacts).toEqual([]);
});
it('关注修订变化使当前历史影响失效，保持当前几何和基准', async () => {
  vi.useFakeTimers();
  try {
    const api = vi
      .fn()
      .mockResolvedValue({ instances: [], items: [{ id: 'same', revision: 2, stale: false }] });
    const state = setup(api);
    state.result.value = {
      id: 'same',
      revision: 1,
      prediction: { asOf: '2020-01-01T00:00:00Z' },
      impacts: [{ warningId: 'w' }],
    } as never;
    await state.loadWatchlist();
    expect(state.result.value?.revision).toBe(1);
    expect(state.result.value?.stale).toBe(true);
    expect(state.result.value?.impacts).toEqual([]);
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});
it('成功运行可按相同输入指纹复用固定旧快照，保留旧asOf与过期标识', async () => {
  const record = {
    id: 'old',
    runId: 'original',
    metadata: { inputFingerprint: 'a'.repeat(64) },
    computedAt: '2020-01-01T00:00:00Z',
    prediction: { mmsi: '123456789', asOf: '2020-01-01T00:00:00Z' },
    stale: true,
    impacts: [],
  };
  const api = vi.fn(async (path: string) =>
    path === '/topics/predictions'
      ? { instanceId: 'i', runId: 'scheduled' }
      : path === '/topics/runs/scheduled'
        ? {
            status: 'succeeded',
            inputSnapshot: { predictionContext: { inputFingerprint: 'a'.repeat(64) } },
          }
        : { items: [record] },
  );
  const state = setup(api);
  state.mmsi.value = '123456789';
  await state.run();
  expect(state.result.value?.id).toBe('old');
  expect(state.result.value?.stale).toBe(true);
  expect(state.message.value).toContain('复用');
});
it('新目标POST尚未受理时取消只绑定新调用，绝不取消上一艘已关注实例', async () => {
  let resolveNew: (value: unknown) => void = () => {};
  const api = vi.fn(
    async (path: string, options?: { method?: string; body?: { mmsi?: string } }) => {
      if (options?.method === 'POST' && path === '/topics/predictions')
        return options.body?.mmsi === '123456789'
          ? { instanceId: 'previous-ship', runId: 'previous-run' }
          : new Promise((resolve) => {
              resolveNew = resolve;
            });
      if (path === '/topics/runs/previous-run') return { status: 'succeeded' };
      if (path.includes('?mmsi='))
        return {
          items: [
            {
              id: 'old-result',
              instanceId: 'previous-ship',
              runId: 'previous-run',
              prediction: { mmsi: '123456789' },
              impacts: [{ warningId: 'old-warning' }],
            },
          ],
        };
      return { status: 'cancelled' };
    },
  );
  const state = setup(api);
  state.mmsi.value = '123456789';
  await state.run();
  state.setMmsi('223456789');
  const pending = state.run();
  await state.cancel();
  expect(api.mock.calls.some(([path]) => path === '/topics/predictions/previous-ship/cancel')).toBe(
    false,
  );
  resolveNew({ instanceId: 'new-ship', runId: 'new-run' });
  await pending;
  expect(api).toHaveBeenCalledWith(
    '/topics/predictions/new-ship/cancel',
    expect.objectContaining({ method: 'POST' }),
  );
  expect(state.result.value?.id).toBe('old-result');
  expect(state.result.value?.stale).not.toBe(true);
});
it('同船提交中取消与重试串行，受理及取消完成前均不发送第二POST', async () => {
  let resolvePost: (value: unknown) => void = () => {},
    resolveCancel: (value: unknown) => void = () => {};
  let posts = 0;
  const api = vi.fn(async (path: string, options?: { method?: string }) => {
    if (path === '/topics/predictions' && options?.method === 'POST') {
      posts++;
      return posts === 1
        ? new Promise((resolve) => {
            resolvePost = resolve;
          })
        : { instanceId: 'same', runId: 'retry' };
    }
    if (path.endsWith('/cancel'))
      return new Promise((resolve) => {
        resolveCancel = resolve;
      });
    return { status: 'failed', error: 'fixture terminal' };
  });
  const state = setup(api);
  state.setMmsi('123456789');
  const original = state.run();
  await state.cancel();
  await state.run();
  expect(posts).toBe(1);
  expect(state.busy.value).toBe(true);
  resolvePost({ instanceId: 'same', runId: 'first' });
  await vi.waitFor(() =>
    expect(api.mock.calls.some(([path]) => path.endsWith('/cancel'))).toBe(true),
  );
  await state.run();
  expect(posts).toBe(1);
  expect(state.busy.value).toBe(true);
  resolveCancel({ status: 'cancelled' });
  await original;
  expect(state.busy.value).toBe(false);
  await state.run();
  expect(posts).toBe(2);
});
