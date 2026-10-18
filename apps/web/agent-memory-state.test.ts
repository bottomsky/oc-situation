import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import { explainMemoryConditions, useAgentMemories } from './app/composables/useAgentMemories';

afterEach(() => vi.unstubAllGlobals());
const settings = { readEnabled: true, proposalsEnabled: true, generation: 0, revision: 0 };
function harness(api: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
  for (const [name, value] of Object.entries({ ref, computed, watch })) vi.stubGlobal(name, value);
  const session = ref({ user: { id: 'owner-a', role: 'viewer' } });
  vi.stubGlobal('usePlatform', () => ({ api, session }));
  const scope = effectScope();
  return { state: scope.run(() => useAgentMemories())!, session, stop: () => scope.stop() };
}
describe('个人记忆管理状态', () => {
  it('将会话空间与时间条件转换为业务可读标签', () => {
    expect(
      explainMemoryConditions({
        intent: 'vessel_tracks',
        historyHours: 24,
        selection: { kind: 'circle', center: [120, 30], radiusNm: 8 },
        mmsi: '413518000',
      }),
    ).toEqual([
      { label: '任务类型', value: '历史航线' },
      { label: '回溯时长', value: '24 小时' },
      { label: '查询条件', value: '圆形海域 · 中心经度 120°，纬度 30° · 半径 8 海里' },
      { label: '船舶 MMSI', value: '413518000' },
    ]);
  });
  it('只读业务账号也可维护自己记忆，重试沿用operationId和原修订', async () => {
    const writes: Record<string, unknown>[] = [];
    const { state, stop } = harness(async (path, options) => {
      if (options?.method) {
        writes.push(options.body as Record<string, unknown>);
        throw new Error('网络连接失败');
      }
      return path.endsWith('/settings') ? settings : { revision: 4, entries: [] };
    });
    await state.load();
    expect(state.canManage.value).toBe(true);
    await state.save({ category: 'preference', key: '语言', value: '中文' });
    await state.save({ category: 'preference', key: '语言', value: '中文' });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.operationId).toBe(writes[1]?.operationId);
    expect(writes[0]?.expectedRevision).toBe(4);
    stop();
  });
  it('冲突保留编辑输入并明确要求刷新，不能默默覆盖', async () => {
    const { state, stop } = harness(async (path, options) => {
      if (options?.method) throw Object.assign(new Error('Conflict'), { status: 409 });
      return path.endsWith('/settings') ? settings : { revision: 3, entries: [] };
    });
    await state.load();
    expect(await state.act('entry', 'confirm')).toBe(false);
    expect(state.error.value).toContain('刷新');
    expect(state.catalog.value.revision).toBe(3);
    stop();
  });
  it('切换账号立即抹除已读记忆，隔离旧请求与忙状态', async () => {
    let release!: (value: unknown) => void;
    const { state, session, stop } = harness(async (path) =>
      path.endsWith('/settings')
        ? settings
        : new Promise((resolve) => {
            release = resolve;
          }),
    );
    const pending = state.load();
    session.value = { user: { id: 'owner-b', role: 'viewer' } };
    await nextTick();
    expect(state.busy.value).toBe(false);
    release({ revision: 9, entries: [{ id: 'private-owner-a' }] });
    await pending;
    expect(state.catalog.value.entries).toEqual([]);
    stop();
  });
  it('会话快速切换时丢弃迟到的旧对象解释', async () => {
    let release!: (value: unknown) => void;
    const { state, stop } = harness(async (path) =>
      path.includes('/old/')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { sessionId: 'new', revision: 1, activeFocus: null, appliedAccountMemories: [] },
    );
    const pending = state.loadSession('old');
    await state.loadSession('new');
    release({ sessionId: 'old', revision: 99 });
    await pending;
    expect(state.sessionMemory.value?.sessionId).toBe('new');
    stop();
  });
});
