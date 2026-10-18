import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useRoutes } from './app/composables/useRoutes';
import { routePlanError, reorderWaypoint } from './app/utils/routeWorkspace';
function setup(api: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('usePlatform', () => ({
    api,
    session: ref({ user: { id: 'a', role: 'operator' } }),
  }));
  const scope = effectScope();
  return { state: scope.run(() => useRoutes())!, stop: () => scope.stop() };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('查询携带分页、搜索和完整圆条件', async () => {
  const api = vi.fn().mockResolvedValue({ items: [], total: 30 });
  const h = setup(api);
  await h.state.load({
    search: '港口',
    offset: 20,
    limit: 20,
    longitude: 122,
    latitude: 30,
    radiusMeters: 1000,
  });
  expect(api.mock.calls[0][0]).toContain('offset=20');
  expect(api.mock.calls[0][0]).toContain('radiusMeters=1000');
  expect(h.state.total.value).toBe(30);
  h.stop();
});
it('失败重试保持operationId，冲突保留编辑内容', async () => {
  const api = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
  const h = setup(api);
  const draft = {
    name: '草稿',
    status: 'draft' as const,
    mmsis: [],
    waypoints: [
      [120, 30],
      [121, 31],
    ] as [number, number][],
    geometry: {
      type: 'LineString' as const,
      coordinates: [
        [120, 30],
        [121, 31],
      ] as [number, number][],
    },
  };
  await h.state.save(draft);
  await h.state.save(draft);
  expect(api.mock.calls[0][1].body.operationId).toBe(api.mock.calls[1][1].body.operationId);
  expect(h.state.error.value).toContain('草稿');
  expect(draft.name).toBe('草稿');
  h.stop();
});
it('较早列表结果不能覆盖新条件', async () => {
  let release!: (v: unknown) => void;
  const api = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ items: [], total: 2 });
  const h = setup(api);
  const first = h.state.load({ search: '旧' });
  await h.state.load({ search: '新' });
  release({ items: [], total: 99 });
  await first;
  expect(h.state.total.value).toBe(2);
  h.stop();
});
it('卸载中止规划读取而不取消服务端任务', async () => {
  vi.useFakeTimers();
  const api = vi.fn().mockResolvedValue({ id: 'p', status: 'running' });
  const h = setup(api);
  await h.state.plan([
    [120, 30],
    [121, 31],
  ]);
  h.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.mock.calls).toHaveLength(1);
  expect(api.mock.calls[0][0]).toBe('/routes/plans');
});
it('规划错误说明与航点顺序', () => {
  expect(routePlanError('DATASET_UNAVAILABLE')).toContain('数据');
  expect(routePlanError('NO_ROUTE')).toContain('航路');
  expect(
    reorderWaypoint(
      [
        [1, 2],
        [3, 4],
      ],
      1,
      -1,
    ),
  ).toEqual([
    [3, 4],
    [1, 2],
  ]);
});
it('取消/新请求后旧规划结果不能恢复候选，卸载中止当前读取', async () => {
  vi.useFakeTimers();
  let release!: (value: unknown) => void;
  let signal: AbortSignal | undefined;
  const api = vi
    .fn()
    .mockResolvedValueOnce({ id: 'p1', status: 'running' })
    .mockImplementationOnce((_path, options) => {
      signal = options.signal;
      return new Promise((resolve) => {
        release = resolve;
      });
    })
    .mockResolvedValueOnce({ id: 'p2', status: 'failed', error: 'NO_ROUTE' });
  const h = setup(api);
  await h.state.plan([
    [120, 30],
    [121, 31],
  ]);
  await vi.advanceTimersByTimeAsync(1000);
  await h.state.plan([
    [122, 30],
    [123, 31],
  ]);
  expect(signal?.aborted).toBe(true);
  release({ id: 'p1', status: 'completed' });
  await Promise.resolve();
  expect(h.state.candidate.value?.id).toBe('p2');
  expect(h.state.error.value).toContain('航路');
  h.stop();
});
it('成功后新写入使用新operationId，更新带原始revision', async () => {
  const api = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(null);
  const h = setup(api);
  const route = { id: 'id', revision: 7 } as import('@ais/contracts').Route;
  // A null mock response is sufficient to inspect the wire contract without follow-up reloads.
  await h.state.save({ name: 'A', expectedRevision: 7 }, route);
  await h.state.save({ name: 'A', expectedRevision: 7 }, route);
  expect(api.mock.calls[0][1].body.expectedRevision).toBe(7);
  expect(api.mock.calls[0][1].body.operationId).not.toBe(api.mock.calls[1][1].body.operationId);
  h.stop();
});
it('新建规划航线发送planId而不夹带手绘geometry或waypoints', async () => {
  const api = vi.fn().mockResolvedValue(null);
  const h = setup(api);
  await h.state.save({
    name: '规划候选',
    status: 'draft',
    mmsis: ['123456789'],
    planId: 'completed-plan',
  });
  const sent = api.mock.calls[0][1].body;
  expect(sent.planId).toBe('completed-plan');
  expect(sent.geometry).toBeUndefined();
  expect(sent.waypoints).toBeUndefined();
  h.stop();
});
it('只读账号在组合函数层拦截写入', async () => {
  const api = vi.fn();
  vi.stubGlobal('usePlatform', () => ({
    api,
    session: ref({ user: { id: 'viewer', role: 'viewer' } }),
  }));
  const scope = effectScope();
  const state = scope.run(() => useRoutes())!;
  await state.plan([
    [120, 30],
    [121, 31],
  ]);
  expect(api).not.toHaveBeenCalled();
  expect(state.error.value).toContain('只读');
  scope.stop();
});
it('同账号降权后丢弃迟到写入，清空旧权限状态', async () => {
  let release!: (value: unknown) => void;
  const api = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const identity = ref({ user: { id: 'a', role: 'operator' } });
  vi.stubGlobal('usePlatform', () => ({ api, session: identity }));
  const scope = effectScope();
  const state = scope.run(() => useRoutes())!;
  const writing = state.save({ name: '旧权限草稿', planId: 'plan', status: 'draft', mmsis: [] });
  identity.value.user.role = 'viewer';
  await Promise.resolve();
  release({ id: 'old', revision: 1 });
  expect(await writing).toBeNull();
  expect(state.selected.value).toBeNull();
  expect(state.busy.value).toBe(false);
  expect(api).toHaveBeenCalledTimes(1);
  scope.stop();
});
