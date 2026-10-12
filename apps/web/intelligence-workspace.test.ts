import { afterEach, expect, it, vi } from 'vitest';
import { computed, ref, reactive } from 'vue';
import { useIntelligenceWorkspace } from './app/composables/useIntelligenceWorkspace';
afterEach(() => vi.unstubAllGlobals());
function setup() {
  let page = 0;
  const writes: unknown[] = [];
  for (const [key, value] of Object.entries({
    ref,
    computed,
    reactive,
    onMounted: () => {},
    onBeforeUnmount: () => {},
  }))
    vi.stubGlobal(key, value);
  vi.stubGlobal('usePlatform', () => ({
    api: async (path: string, options?: { body: unknown }) => {
      if (path.includes('/events?'))
        return {
          items: [{ id: ++page === 1 ? 'a' : 'b', title: '公告' }],
          nextCursor: page === 1 ? 'next' : null,
        };
      if (path === '/intelligence/plot')
        return {
          type: 'FeatureCollection',
          features: [],
          items: [{ eventId: 'a', title: '公告', featureCount: 0, reason: '没有可定位关系' }],
        };
      if (path === '/intelligence/plot-set') {
        if (options) writes.push(options.body);
        return { eventIds: [], hiddenEventIds: [] };
      }
      return [];
    },
  }));
  return { state: useIntelligenceWorkspace(), writes };
}
it('跨页勾选保留，重新筛选不清空已标绘集合', async () => {
  const { state } = setup();
  await state.load();
  state.toggleSelection('a');
  await state.load(true);
  state.toggleSelection('b');
  expect(state.selectedIds.value).toEqual(['a', 'b']);
  await state.add(['a']);
  state.filters.keyword = '新条件';
  await state.load();
  expect(state.plottedIds.value).toEqual(['a']);
  expect(state.selectedIds.value).toEqual(['a', 'b']);
  expect(state.feedback.value).toContain('没有可定位关系');
});
it('隐藏与移除独立于勾选并持久化', async () => {
  const { state, writes } = setup();
  state.toggleSelection('a');
  await state.add(['a']);
  await state.hide(['a']);
  expect(state.hiddenIds.value).toEqual(['a']);
  await state.remove(['a']);
  expect(state.plottedIds.value).toEqual([]);
  expect(state.selectedIds.value).toEqual(['a']);
  expect(writes.at(-1)).toEqual({ eventIds: [], hiddenEventIds: [] });
});

it('排队加入后立即清空仍清除全部标绘', async () => {
  const { state } = setup();
  const adding = state.add(['a']);
  const clearing = state.clear();
  await Promise.all([adding, clearing]);
  expect(state.plottedIds.value).toEqual([]);
});
