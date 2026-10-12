import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, ref, watch } from 'vue';
import {
  agentTaskHasAnalysis,
  createAgentMessageFollow,
  useAgentConversation,
} from './app/composables/useAgentConversation';

afterEach(() => vi.unstubAllGlobals());
const config = {
  enabled: true,
  defaultHistoryHours: 24,
  maxHistoryHours: 168,
  maxModelCalls: 12,
  maxToolCalls: 24,
};
const session = { id: 'session-a', ownerId: 'user-a', title: '区域研判', createdAt: '2026-10-11' };
const task = {
  id: 'task-a',
  sessionId: session.id,
  status: 'queued',
  historyHours: 24,
  resultVersion: 1,
  summaryResultVersion: null,
};
function harness(
  api: (path: string, options?: Record<string, unknown>) => Promise<unknown>,
  role = 'operator',
) {
  const scope = effectScope();
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', () => {});
  vi.stubGlobal('onBeforeUnmount', () => {});
  vi.stubGlobal('usePlatform', () => ({ api, session: ref({ user: { id: 'user-a', role } }) }));
  return { state: scope.run(() => useAgentConversation())!, stop: () => scope.stop() };
}
describe('智能体会话状态', () => {
  it('共享输入并发提交只创建一次会话和消息，保留发送期间的新草稿', async () => {
    const submitted: Record<string, unknown>[] = [];
    let creates = 0;
    let release: (value: unknown) => void = () => {};
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') {
        if (options?.method === 'POST') {
          creates++;
          return session;
        }
        return { items: [] };
      }
      if (path.endsWith('/messages')) {
        submitted.push(options!);
        return new Promise((resolve) => {
          release = resolve;
        });
      }
      if (path.includes('/tasks/')) return { task, results: [], steps: [] };
      return { session, messages: [], tasks: [task] };
    });
    await state.initialize();
    state.draft.value = '第一次区域提问';
    const first = state.send();
    await state.send();
    await state.poll();
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    expect(creates).toBe(1);
    state.draft.value = '正在编辑下一条问题';
    release({ message: { id: 'message-a', content: '第一次区域提问', role: 'user' }, task });
    await first;
    expect(state.draft.value).toBe('正在编辑下一条问题');
    expect(state.activeSession.value?.id).toBe(session.id);
    expect(state.busy.value).toBe(false);
    stop();
  });
  it('发送失败不会被空轮询或区域确认清空，成功重试后才解除反馈', async () => {
    let attempts = 0;
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
      if (path.includes('/events?')) return { items: [], nextCursor: '0' };
      if (path.endsWith('/messages')) {
        if (++attempts === 1) throw new Error('发送连接中断');
        return { message: { id: 'message-a', content: '你好', role: 'user' }, task };
      }
      if (path.includes('/tasks/')) return { task, results: [], steps: [] };
      return { session, messages: [], tasks: [task] };
    });
    await state.initialize();
    state.draft.value = '你好';
    await state.send();
    await state.poll();
    expect(state.error.value).toBe('发送连接中断');
    state.confirmRegion([121, 30, 122, 31]);
    expect(state.error.value).toBe('发送连接中断');
    await state.send();
    expect(state.error.value).toBe('');
    stop();
  });
  it('普通问候无区域提交，轮询完成后读取结果版本0的持久助手消息', async () => {
    let completed = false;
    const conversationalTask = { ...task, resultVersion: 0, bbox: null };
    const userMessage = { id: 'user-message', content: '你好', role: 'user', taskId: task.id };
    const assistantMessage = {
      id: 'assistant-message',
      content: '你好，我可以帮助你查询信息和分析海域。',
      role: 'assistant',
      taskId: task.id,
    };
    const submitted: Record<string, unknown>[] = [];
    const taskState = () =>
      completed
        ? {
            ...conversationalTask,
            status: 'completed',
            summaryResultVersion: 0,
            summary: assistantMessage.content,
          }
        : conversationalTask;
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
      if (path.endsWith('/messages')) {
        submitted.push(options!.body as Record<string, unknown>);
        return { message: userMessage, task: conversationalTask };
      }
      if (path.includes('/events?')) {
        completed = true;
        return { items: [{ id: '1', type: 'task.completed' }], nextCursor: '1' };
      }
      if (path.includes('/tasks/')) return { task: taskState(), results: [], steps: [] };
      return {
        session,
        messages: completed ? [userMessage, assistantMessage] : [userMessage],
        tasks: [taskState()],
      };
    });
    await state.initialize();
    state.draft.value = '你好';
    await state.send();
    expect(submitted[0]).not.toHaveProperty('bbox');
    expect(state.activeTask.value).toBe(true);
    await state.poll();
    expect(state.activeTask.value).toBe(false);
    expect(state.detail.value?.task.resultVersion).toBe(0);
    expect(state.messages.value.at(-1)?.content).toBe(assistantMessage.content);
    stop();
  });
  it('发送失败重试复用请求键和正文，成功后清空草稿', async () => {
    const submitted: Record<string, unknown>[] = [];
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
      if (path.endsWith('/messages')) {
        submitted.push(options!);
        if (submitted.length === 1) throw new Error('连接中断');
        return { message: { id: 'message-a', content: '分析区域', role: 'user' }, task };
      }
      if (path.includes('/tasks/')) return { task, results: [], steps: [] };
      return { session, messages: [], tasks: [task] };
    });
    await state.initialize();
    state.draft.value = '分析区域';
    state.confirmRegion([121, 30, 122, 31]);
    await state.send();
    expect(state.error.value).toBe('连接中断');
    expect(state.draft.value).toBe('分析区域');
    await state.send();
    expect(submitted[0]?.idempotencyKey).toBeTruthy();
    expect(submitted[1]?.idempotencyKey).toBe(submitted[0]?.idempotencyKey);
    expect(submitted[1]?.body).toEqual(submitted[0]?.body);
    expect(state.draft.value).toBe('');
    stop();
  });
  it('切换会话后迟到的旧会话响应不能污染新会话', async () => {
    let release: (value: unknown) => void = () => {};
    const { state, stop } = harness(async (path) => {
      if (path.endsWith('/session-a'))
        return new Promise((resolve) => {
          release = resolve;
        });
      return {
        session: { ...session, id: 'session-b' },
        messages: [{ id: 'b', content: 'B' }],
        tasks: [],
      };
    });
    const first = state.openSession('session-a');
    await state.openSession('session-b');
    release({ session, messages: [{ id: 'a', content: 'A' }], tasks: [] });
    await first;
    expect(state.activeSession.value?.id).toBe('session-b');
    expect(state.messages.value.map((item) => item.content)).toEqual(['B']);
    stop();
  });
  it('viewer和功能关闭状态无法提交，超出168小时在本地拒绝', async () => {
    const api = vi.fn(async () => config);
    const viewer = harness(api, 'viewer');
    viewer.state.draft.value = '分析';
    await viewer.state.send();
    expect(api).not.toHaveBeenCalled();
    viewer.stop();
    const operator = harness(api);
    await operator.state.initialize();
    api.mockClear();
    operator.state.draft.value = '分析';
    operator.state.historyHours.value = 169;
    await operator.state.send();
    expect(api).not.toHaveBeenCalled();
    expect(operator.state.error.value).toContain('168');
    operator.stop();
  });
  it('权限或会话读取失败立即清除旧证据和任务', async () => {
    const { state, stop } = harness(async (path) => {
      if (path.endsWith('/session-a')) return { session, messages: [], tasks: [task] };
      if (path.includes('/tasks/')) return { task, results: [], steps: [] };
      throw new Error('无权访问');
    });
    await state.openSession('session-a');
    expect(state.tasks.value).toHaveLength(1);
    await state.openSession('denied');
    expect(state.tasks.value).toEqual([]);
    expect(state.detail.value).toBeNull();
    expect(state.error.value).toBe('无权访问');
    stop();
  });
  it('证据刷新失败保留事件游标，恢复连接后重新读取完整结果', async () => {
    const cursors: string[] = [];
    let unavailable = false;
    const { state, stop } = harness(async (path) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return { items: [session] };
      if (path.includes('/events?')) {
        cursors.push(new URL(path, 'http://test').searchParams.get('cursor')!);
        return { items: [{ id: '1', type: 'results.saved' }], nextCursor: '1' };
      }
      if (path.includes('/tasks/')) {
        if (unavailable) throw new Error('证据读取失败');
        return { task, results: [], steps: [] };
      }
      return { session, messages: [], tasks: [task] };
    });
    await state.initialize();
    await state.openSession(session.id);
    unavailable = true;
    await state.poll();
    expect(state.error.value).toBe('证据读取失败');
    expect(state.detail.value).toBeNull();
    unavailable = false;
    await state.poll();
    expect(cursors).toEqual(['0', '0']);
    expect(state.detail.value?.task.id).toBe(task.id);
    expect(state.error.value).toBe('');
    stop();
  });
});

describe('智能体新消息跟随', () => {
  it('读取或切换历史会话时保留原阅读位置', () => {
    const follow = createAgentMessageFollow();
    expect(follow.update('session-a', ['a', 'b'], '', true)).toBe(false);
    expect(follow.update('session-b', ['c', 'd'], '', true)).toBe(false);
  });
  it('仅底部阅读或刚发送的问题跟随新消息，旧消息阅读不被轮询打断', () => {
    const follow = createAgentMessageFollow();
    follow.update('session-a', ['a'], '', true);
    expect(follow.update('session-a', ['a', 'b'], '', true)).toBe(true);
    expect(follow.update('session-a', ['a', 'b', 'c'], '', false)).toBe(false);
    expect(follow.update('session-a', ['a', 'b', 'c', 'd'], 'd', false)).toBe(true);
    expect(follow.update('session-a', ['a', 'b', 'c', 'd', 'e'], 'd', false)).toBe(false);
    expect(follow.update('session-a', ['a', 'b', 'c', 'd', 'e', 'f'], 'd', true)).toBe(true);
    expect(follow.update('session-a', ['a', 'b', 'c', 'd', 'e', 'f'], 'd', true)).toBe(false);
  });
  it('新会话第一条主动发送跟随，重新挂载已有发送记录保留阅读位置', () => {
    const follow = createAgentMessageFollow();
    follow.update(null, [], '', true);
    expect(follow.update('session-a', ['a'], 'a', false)).toBe(true);
    const restored = createAgentMessageFollow();
    expect(restored.update('session-a', ['a', 'b'], 'a', true)).toBe(false);
  });
});

describe('智能体任务展示语义', () => {
  it('普通问答版本0与真实算法执行按服务端任务元数据区分', () => {
    expect(agentTaskHasAnalysis({ definitionId: null, resultVersion: 0 }, [])).toBe(false);
    expect(agentTaskHasAnalysis({ definitionId: 'port-restriction', resultVersion: 0 }, [])).toBe(
      true,
    );
    expect(agentTaskHasAnalysis({ definitionId: null, resultVersion: 1 }, [])).toBe(true);
    expect(
      agentTaskHasAnalysis({ definitionId: null, resultVersion: 0 }, [{ name: 'run_analysis' }]),
    ).toBe(true);
    expect(
      agentTaskHasAnalysis({ definitionId: null, resultVersion: 0 }, [{ name: 'ask_user' }]),
    ).toBe(false);
  });
});
