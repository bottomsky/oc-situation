import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useOperationalEvents } from './app/composables/useOperationalEvents';
import { eventPatch, eventChartHref, createHandoffGeneration } from './app/utils/operationalEvents';
import { businessError } from './app/utils/display';
const event = (id = '00000000-0000-4000-8000-000000000001', revision = 1) => ({
  id,
  revision,
  title: '业务事件',
  summary: '',
  category: 'other',
  severity: 'unknown',
  occurredAt: null,
  geometry: null,
  linkedMmsis: [],
  linkedRouteIds: [],
  status: 'active',
  primarySourceKey: null,
  sourceSuggestions: {},
  overrides: {},
  mergedInto: null,
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
});
function setup(api: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('usePlatform', () => ({
    api,
    session: ref({ user: { id: 'a', role: 'operator' } }),
  }));
  const scope = effectScope();
  return { state: scope.run(() => useOperationalEvents())!, stop: () => scope.stop() };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('卸载后丢弃迟到写入且不重新加载列表', async () => {
  let release!: (value: unknown) => void;
  const api = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = setup(api);
  const writing = h.state.mutate('/operational-events', { title: '旧草稿' }, 'POST');
  h.stop();
  release(event());
  expect(await writing).toBeNull();
  expect(api).toHaveBeenCalledTimes(1);
});
it('同账号降权再恢复也不能恢复旧权限代次的写入结果', async () => {
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
  const state = scope.run(() => useOperationalEvents())!;
  const writing = state.mutate('/operational-events', { title: '旧草稿' }, 'POST');
  identity.value.user.role = 'viewer';
  identity.value.user.role = 'operator';
  release(event());
  expect(await writing).toBeNull();
  expect(state.items.value).toEqual([]);
  expect(state.busy.value).toBe(false);
  expect(api).toHaveBeenCalledTimes(1);
  scope.stop();
});
it('URL对象切换和退出使先前可信读取失效', () => {
  const generation = createHandoffGeneration(),
    first = generation.begin(),
    second = generation.begin();
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  generation.invalidate();
  expect(second()).toBe(false);
});
it('局部编辑仅提交变化字段，恢复来源字段从人工字段中移除', () => {
  expect(
    eventPatch({ title: '旧', summary: '保持' }, { title: '新', summary: '保持' }, []),
  ).toEqual({ title: '新' });
  expect(eventPatch({ title: '旧' }, { title: '新' }, ['title'])).toEqual({});
  expect(eventChartHref('abc')).toBe('/?operationalEventId=abc&askEvent=1');
});
it('重试保持operationId，409保留草稿', async () => {
  const api = vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { status: 409 }));
  const h = setup(api),
    draft = { title: '草稿' };
  await h.state.mutate('/operational-events', draft, 'POST');
  await h.state.mutate('/operational-events', draft, 'POST');
  expect(api.mock.calls[0][1].body.operationId).toBe(api.mock.calls[1][1].body.operationId);
  expect(h.state.error.value).toContain('草稿');
  expect(draft.title).toBe('草稿');
  h.stop();
});
it('分页与圆形筛选保留，旧结果不覆盖新条件', async () => {
  let release!: (v: unknown) => void;
  const api = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    )
    .mockResolvedValue({ items: [], total: 3 });
  const h = setup(api),
    first = h.state.load({ keyword: '旧' });
  await h.state.load({
    offset: 20,
    circle: { kind: 'circle', center: [120, 30], radiusMeters: 1000 },
  });
  release({ items: [], total: 99 });
  await first;
  expect(h.state.total.value).toBe(3);
  expect(api.mock.calls[1][0]).toContain('offset=20');
  expect(decodeURIComponent(api.mock.calls[1][0])).toContain('radiusMeters');
  h.stop();
});
it('详情换选与来源换选均拦截迟到结果', async () => {
  const pending: ((v: unknown) => void)[] = [];
  const api = vi
    .fn()
    .mockImplementation((path: string) =>
      path.endsWith('/history') || path.endsWith('/sources')
        ? Promise.resolve({ items: [] })
        : new Promise((r) => pending.push(r)),
    );
  const h = setup(api),
    first = h.state.detail(event().id),
    second = h.state.detail('00000000-0000-4000-8000-000000000002');
  pending[1]!(event('00000000-0000-4000-8000-000000000002'));
  await second;
  pending[0]!(event());
  await first;
  expect(h.state.selected.value?.id.endsWith('2')).toBe(true);
  const oldSource = h.state.readSource('old'),
    newSource = h.state.readSource('new');
  pending[3]!({ items: [] });
  await newSource;
  pending[2]!({ items: [{ key: 'old' }] });
  await oldSource;
  expect(h.state.sourceHistory.value).toEqual([]);
  h.stop();
});
it('后台轮询只提示实时更新，保留当前修订，并在隐藏和卸载时停止', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('document', { visibilityState: 'visible' });
  const api = vi
    .fn()
    .mockImplementation((path: string) =>
      Promise.resolve(
        path.includes('?') || path.endsWith('/history') || path.endsWith('/sources')
          ? { items: [], total: 0 }
          : event(
              undefined,
              api.mock.calls.filter(([p]) => p === `/operational-events/${event().id}`).length > 1
                ? 2
                : 1,
            ),
      ),
    );
  const h = setup(api);
  await h.state.detail(event().id);
  await vi.advanceTimersByTimeAsync(30000);
  expect(h.state.updated.value).toBe(true);
  expect(h.state.selected.value?.revision).toBe(1);
  const count = api.mock.calls.length;
  vi.stubGlobal('document', { visibilityState: 'hidden' });
  await vi.advanceTimersByTimeAsync(30000);
  expect(api.mock.calls.length).toBe(count);
  h.stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(api.mock.calls.length).toBe(count);
});
it('合并提交保留双方修订和主来源，未知后端文本不会暴露', async () => {
  const api = vi
    .fn()
    .mockImplementation((path: string) =>
      Promise.resolve(path.includes('?') ? { items: [], total: 0 } : event()),
    );
  const h = setup(api);
  await h.state.mutate(
    `/operational-events/${event().id}/merge`,
    {
      targetId: '00000000-0000-4000-8000-000000000002',
      expectedRevision: 2,
      targetExpectedRevision: 3,
      primarySourceKey: 'intelligence:a',
    },
    'POST',
  );
  expect(api.mock.calls[0][1].body).toMatchObject({
    expectedRevision: 2,
    targetExpectedRevision: 3,
    primarySourceKey: 'intelligence:a',
  });
  expect(businessError('SQL SELECT SECRET', 500).message).not.toContain('SQL');
  expect(businessError('Event revision conflict', 409).code).toBe('revision_conflict');
  h.stop();
});
