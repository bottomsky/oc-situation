import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import { useSkills } from './app/composables/useSkills';

afterEach(() => vi.unstubAllGlobals());
function harness(
  api: (path: string, options?: Record<string, unknown>) => Promise<unknown>,
  role = 'operator',
) {
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', () => {});
  const session = ref({ user: { id: 'owner-a', role } });
  vi.stubGlobal('usePlatform', () => ({ api, session }));
  const scope = effectScope();
  return { state: scope.run(() => useSkills())!, session, stop: () => scope.stop() };
}
describe('账号技能目录状态', () => {
  it('开关关闭仍加载自己的目录，只读角色始终无写入口', async () => {
    const api = vi.fn(async (path: string) =>
      path === '/agent/config'
        ? { dynamicSkillsEnabled: false }
        : { catalogRevision: 3, items: [] },
    );
    const { state, stop } = harness(api, 'viewer');
    await state.load();
    expect(state.catalog.value.catalogRevision).toBe(3);
    expect(state.canWrite.value).toBe(false);
    expect(api).toHaveBeenCalledWith('/agent/skills');
    stop();
  });
  it('目录切换后迟到的旧详情不会覆盖当前详情', async () => {
    let release!: (value: unknown) => void;
    const { state, stop } = harness(async (path) =>
      path.endsWith('/a')
        ? new Promise((resolve) => {
            release = resolve;
          })
        : { skill: { skillId: 'b' }, versions: [], catalogRevision: 0 },
    );
    const old = state.select('a');
    await state.select('b');
    release({ skill: { skillId: 'a' }, versions: [], catalogRevision: 0 });
    await old;
    expect(state.detail.value?.skill.skillId).toBe('b');
    stop();
  });
  it('失去响应后同样发布复用operationId且携带目录修订', async () => {
    const writes: Record<string, unknown>[] = [];
    const { state, stop } = harness(async (_path, options) => {
      if (options?.method) {
        writes.push(options.body as Record<string, unknown>);
        throw new Error('网络连接失败');
      }
      return { dynamicSkillsEnabled: true, catalogRevision: 4, items: [] };
    });
    await state.load();
    await state.publish({
      schemaVersion: 1,
      name: 'test',
      description: '测试',
      body: '使用受控工具查询船舶',
      toolIds: ['query_vessels'],
      steps: [{ id: 'query', toolId: 'query_vessels', input: {} }],
    });
    await state.publish({
      schemaVersion: 1,
      name: 'test',
      description: '测试',
      body: '使用受控工具查询船舶',
      toolIds: ['query_vessels'],
      steps: [{ id: 'query', toolId: 'query_vessels', input: {} }],
    });
    expect(writes).toHaveLength(2);
    expect(writes[0]?.operationId).toBe(writes[1]?.operationId);
    expect(writes[0]?.expectedCatalogRevision).toBe(4);
    stop();
  });
  it('切换账号会立即清空忙状态且隔离上一账号迟到请求', async () => {
    let release!: (value: unknown) => void;
    const { state, session, stop } = harness(async (path) =>
      path === '/agent/config'
        ? { dynamicSkillsEnabled: true }
        : new Promise((resolve) => {
            release = resolve;
          }),
    );
    const old = state.load();
    expect(state.busy.value).toBe(true);
    session.value = { user: { id: 'owner-b', role: 'operator' } };
    await nextTick();
    expect(state.busy.value).toBe(false);
    release({ catalogRevision: 99, items: [{ skillId: 'owner-a-secret' }] });
    await old;
    expect(state.catalog.value.items).toEqual([]);
    stop();
  });
  it('同账号较早刷新不能覆盖较新的目录修订', async () => {
    const releases: ((value: unknown) => void)[] = [];
    const { state, stop } = harness(async (path) =>
      path === '/agent/config'
        ? { dynamicSkillsEnabled: true }
        : new Promise((resolve) => {
            releases.push(resolve);
          }),
    );
    const old = state.load();
    const fresh = state.load();
    releases[1]!({ catalogRevision: 5, items: [] });
    await fresh;
    releases[0]!({ catalogRevision: 4, items: [] });
    await old;
    expect(state.catalog.value.catalogRevision).toBe(5);
    stop();
  });
  it('首次发布成功后选中新建技能', async () => {
    const api = vi.fn(async (path: string, options?: Record<string, unknown>) =>
      options?.method
        ? { skill: { skillId: 'new-skill' } }
        : path === '/agent/config'
          ? { dynamicSkillsEnabled: true }
          : path === '/agent/skills'
            ? { catalogRevision: 1, items: [] }
            : { skill: { skillId: 'new-skill' }, versions: [], catalogRevision: 1 },
    );
    const { state, stop } = harness(api);
    await state.load();
    await state.publish({
      schemaVersion: 1,
      name: 'test',
      description: '测试',
      body: '使用受控工具查询船舶',
      toolIds: ['query_vessels'],
      steps: [{ id: 'query', toolId: 'query_vessels', input: {} }],
    });
    expect(state.selectedId.value).toBe('new-skill');
    stop();
  });
});
