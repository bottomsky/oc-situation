import { afterEach, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import { useChartTasks } from './app/composables/useChartTasks';
import { chartTopic } from '../../tests/e2e/fixtures/chart-data';
afterEach(() => vi.unstubAllGlobals());
it('所选专题运行状态后续读取失败时失效校验，重试成功后才允许提交', async () => {
  let fail = false;
  let submitted = 0;
  const scope = effectScope();
  for (const [key, value] of Object.entries({
    ref,
    computed,
    watch,
    onMounted: () => {},
    onBeforeUnmount: () => {},
  }))
    vi.stubGlobal(key, value);
  vi.stubGlobal('useFusionEvents', () => ({ analysisVersion: ref(0) }));
  vi.stubGlobal('usePlatform', () => ({
    session: ref({ user: { role: 'operator' } }),
    api: async (path: string) => {
      if (path === '/topics') return { instances: [chartTopic] };
      if (path.endsWith('/run')) {
        submitted++;
        return {};
      }
      if (fail) throw new Error('运行状态读取失败');
      return { items: [] };
    },
  }));
  const tasks = scope.run(useChartTasks)!;
  await tasks.load();
  tasks.selectedId.value = chartTopic.id;
  await nextTick();
  await vi.waitFor(() => expect(tasks.canRun.value).toBe(true));
  fail = true;
  await tasks.loadRuns();
  expect(tasks.canRun.value).toBe(false);
  await tasks.run();
  expect(submitted).toBe(0);
  fail = false;
  await tasks.loadRuns();
  expect(tasks.canRun.value).toBe(true);
  scope.stop();
});
