import { afterEach, describe, expect, it, vi } from 'vitest';
import { computed, effectScope, nextTick, ref, watch } from 'vue';
import type { AgentInputRequest, AgentMapContext } from '@ais/contracts';
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
  context?: () => AgentMapContext,
) {
  const scope = effectScope();
  const identity = ref({ user: { id: 'user-a', role } });
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', () => {});
  vi.stubGlobal('onBeforeUnmount', () => {});
  vi.stubGlobal('usePlatform', () => ({ api, session: identity }));
  return {
    state: scope.run(() => useAgentConversation(context))!,
    identity,
    stop: () => scope.stop(),
  };
}

describe('结构化输入请求与同任务续作', () => {
  it('情报引用固定读取消息版本，独立于当前选中的任务', async () => {
    const paths: string[] = [];
    const evidence = { kind: 'event', reference: 'I1', event: { title: '旧版来源标题' } };
    const fixture = harness(async (path) => {
      paths.push(path);
      return { task, intelligenceResult: { version: 3, evidence: [evidence], sourceHealth: [] } };
    });
    fixture.state.activeSession.value = session;
    fixture.state.selectedTaskId.value = 'unrelated-task';
    await fixture.state.openSource('I1', task.id, 3);
    expect(paths).toEqual([`/agent/tasks/${task.id}?resultVersion=3`]);
    expect(fixture.state.sourceEvidence.value).toEqual(evidence);
    expect(fixture.state.selectedTaskId.value).toBe('unrelated-task');
    fixture.stop();
  });
  it('情报引用版本不匹配时拒绝展示当前版本来源', async () => {
    const fixture = harness(async () => ({
      task,
      intelligenceResult: { version: 9, evidence: [{ reference: 'I1' }], sourceHealth: [] },
    }));
    fixture.state.activeSession.value = session;
    await fixture.state.openSource('I1', task.id, 3);
    expect(fixture.state.sourceEvidence.value).toBeNull();
    expect(fixture.state.sourceError.value).toContain('结果版本不可用');
    fixture.stop();
  });
  it('关闭来源卡后迟到读取不会恢复内容', async () => {
    let release: ((value: unknown) => void) | undefined;
    const fixture = harness(
      async () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    fixture.state.activeSession.value = session;
    const reading = fixture.state.openSource('I1', task.id, 3);
    fixture.state.closeSource();
    release!({
      task,
      intelligenceResult: { version: 3, evidence: [{ reference: 'I1' }], sourceHealth: [] },
    });
    await reading;
    expect(fixture.state.sourceOpen.value).toBe(false);
    expect(fixture.state.sourceEvidence.value).toBeNull();
    fixture.stop();
  });
  const request: AgentInputRequest = {
    id: 'request-a',
    taskId: task.id,
    sessionId: session.id,
    inputRevision: 0,
    pauseGeneration: 1,
    fields: ['region'],
    reason: 'missing_region',
    prefill: {},
    status: 'pending',
    response: null,
    createdAt: '2026-10-13T00:00:00Z',
    answeredAt: null,
  };
  function inputHarness() {
    let pending = [request];
    let responseError: Error | null = null;
    let readError = false;
    const posts: Record<string, unknown>[] = [];
    const currentTask = { ...task, status: 'awaiting_input', inputRevision: 0 };
    const fixture = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return { items: [session] };
      if (path.endsWith('/responses')) {
        posts.push(options!);
        if (responseError) throw responseError;
        pending = [];
        currentTask.status = 'queued';
        currentTask.inputRevision = 1;
        return { task: currentTask, request: { ...request, status: 'answered' } };
      }
      if (path.includes('/events?')) return { items: [{ id: '1' }], nextCursor: '1' };
      if (readError) throw new Error('暂时离线');
      if (path.includes('/tasks/'))
        return { task: currentTask, results: [], steps: [], pendingInputRequests: pending };
      return {
        session,
        messages: [],
        tasks: [currentTask],
        pendingInputRequests: pending,
        snapshotCursor: '0',
      };
    });
    return {
      ...fixture,
      posts,
      fail: (error: Error | null) => {
        responseError = error;
      },
      failRead: () => {
        readError = true;
      },
      setPending: (items: AgentInputRequest[]) => {
        pending = items;
      },
    };
  }
  it('恢复不弹历史请求；新请求弹一次，收起后轮询不重弹', async () => {
    const fixture = inputHarness();
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    expect(fixture.state.inputRequests.value).toHaveLength(1);
    expect(fixture.state.openInput.value).toBeNull();
    fixture.setPending([{ ...request, id: 'request-b' }]);
    await fixture.state.poll();
    expect(fixture.state.openInput.value?.id).toBe('request-b');
    fixture.state.closeInput();
    await fixture.state.poll();
    expect(fixture.state.openInput.value).toBeNull();
    fixture.stop();
  });
  it('网络重试保持幂等键，回传后同任务继续而不追加message请求', async () => {
    const fixture = inputHarness();
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    fixture.state.showInput(request.id);
    fixture.fail(new Error('网络失败'));
    await fixture.state.answerInput(request, { bbox: [1, 2, 3, 4] });
    expect(fixture.state.openInput.value?.id).toBe(request.id);
    expect(fixture.state.inputError.value).toBe('网络失败');
    fixture.fail(null);
    await fixture.state.answerInput(request, { bbox: [1, 2, 3, 4] });
    expect(fixture.posts[0]!.idempotencyKey).toBe(fixture.posts[1]!.idempotencyKey);
    expect(fixture.state.tasks.value[0]).toMatchObject({ id: task.id, status: 'queued' });
    expect(fixture.state.inputRequests.value).toEqual([]);
    fixture.stop();
  });
  it('回答已接受后读取失败不会提示重新回答', async () => {
    const fixture = inputHarness();
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    fixture.state.showInput(request.id);
    fixture.failRead();
    expect(await fixture.state.answerInput(request, { bbox: [1, 2, 3, 4] })).toBe(true);
    expect(fixture.state.openInput.value).toBeNull();
    expect(fixture.state.inputError.value).toBe('');
    expect(fixture.posts).toHaveLength(1);
    fixture.stop();
  });
  it('另一窗口已回答时刷新清理过期弹窗', async () => {
    const fixture = inputHarness();
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    fixture.state.showInput(request.id);
    fixture.setPending([]);
    fixture.fail(Object.assign(new Error('冲突'), { status: 409 }));
    await fixture.state.answerInput(request, { bbox: [1, 2, 3, 4] });
    expect(fixture.state.openInput.value).toBeNull();
    expect(fixture.state.inputRequests.value).toEqual([]);
    fixture.stop();
  });
  it('发送时复制视野与筛选快照，不受发送后的地图变化影响', async () => {
    const context: AgentMapContext = {
      bbox: [1, 2, 3, 4],
      capturedAt: '2026-10-13T00:00:00Z',
      hours: 6,
      sourceId: 'source-a',
      selectedMmsis: ['123456789'],
    };
    let submitted: Record<string, unknown> | undefined;
    const fixture = harness(
      async (path, options) => {
        if (path.endsWith('/config')) return config;
        if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
        if (path.endsWith('/messages')) {
          submitted = options!.body as Record<string, unknown>;
          context.bbox[0] = 100;
          return { task, message: { id: 'message-a' } };
        }
        if (path.includes('/tasks/')) return { task, results: [], steps: [] };
        return { session, tasks: [task], messages: [] };
      },
      'operator',
      () => context,
    );
    await fixture.state.initialize();
    fixture.state.draft.value = '当前视野有哪些船舶';
    await fixture.state.send();
    expect(submitted!.mapContext).toMatchObject({
      bbox: [1, 2, 3, 4],
      hours: 6,
      selectedMmsis: ['123456789'],
    });
    fixture.stop();
  });
  it('发送重试沿用第一次的视野快照和幂等键', async () => {
    const context: AgentMapContext = {
      bbox: [1, 2, 3, 4],
      capturedAt: '2026-10-13T00:00:00Z',
      hours: 6,
    };
    const posts: Record<string, unknown>[] = [];
    const fixture = harness(
      async (path, options) => {
        if (path.endsWith('/config')) return config;
        if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
        if (path.endsWith('/messages')) {
          posts.push(options!);
          if (posts.length === 1) throw new Error('响应丢失');
          return { task, message: { id: 'message-a' } };
        }
        if (path.includes('/tasks/')) return { task, results: [], steps: [] };
        return { session, tasks: [task], messages: [] };
      },
      'operator',
      () => context,
    );
    await fixture.state.initialize();
    fixture.state.draft.value = '当前视野有哪些船舶';
    await fixture.state.send();
    context.bbox = [10, 20, 30, 40];
    context.capturedAt = '2026-10-13T01:00:00Z';
    await fixture.state.send();
    expect(posts[0]!.idempotencyKey).toBe(posts[1]!.idempotencyKey);
    expect(posts[0]!.body).toEqual(posts[1]!.body);
    expect((posts[1]!.body as { mapContext: AgentMapContext }).mapContext.bbox).toEqual([
      1, 2, 3, 4,
    ]);
    fixture.stop();
  });
  it('重试已受理但刷新失败时保留新任务，旧按钮不能创建第二次尝试', async () => {
    let accepted = false;
    const posts: Record<string, unknown>[] = [];
    const original = { ...task, status: 'failed', inputRevision: 0 };
    const retried = { ...task, id: 'task-retry', status: 'queued', inputRevision: 0 };
    const fixture = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return { items: [session] };
      if (path.endsWith('/retry')) {
        posts.push(options!);
        accepted = true;
        return {
          task: retried,
          message: {
            id: 'retry-message',
            sessionId: session.id,
            taskId: retried.id,
            content: '再次尝试',
            role: 'user',
            createdAt: '2026-10-13T00:00:00Z',
          },
        };
      }
      if (accepted) throw new Error('受理后读取失败');
      if (path.includes('/tasks/')) return { task: original, results: [], steps: [] };
      return { session, messages: [], tasks: [original], pendingInputRequests: [] };
    });
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    await fixture.state.retryTask(task.id);
    expect(fixture.state.activeTask.value).toBe(true);
    expect(fixture.state.tasks.value).toContainEqual(retried);
    expect(fixture.state.currentReply.value).toMatchObject({
      taskId: retried.id,
      userMessageId: 'retry-message',
      status: 'queued',
    });
    expect(fixture.state.submittedMessageId.value).toBe('retry-message');
    await fixture.state.retryTask(task.id);
    expect(posts).toHaveLength(1);
    fixture.stop();
  });
  it('另一任务的消息回执仅更新该任务输入请求，保留正在编辑的旧请求', async () => {
    let posted = false;
    let releaseSnapshot: ((value: unknown) => void) | undefined;
    const oldTask = { ...task, status: 'awaiting_input' };
    const newTask = { ...task, id: 'task-new', status: 'completed' };
    const fixture = harness(async (path) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return { items: [session] };
      if (path.endsWith('/messages')) {
        posted = true;
        return { task: newTask, message: { id: 'new-message' }, pendingInputRequests: [] };
      }
      if (path.includes('/tasks/'))
        return { task: path.endsWith(newTask.id) ? newTask : oldTask, results: [], steps: [] };
      if (posted)
        return new Promise((resolve) => {
          releaseSnapshot = resolve;
        });
      return { session, messages: [], tasks: [oldTask], pendingInputRequests: [request] };
    });
    await fixture.state.initialize();
    await fixture.state.openSession(session.id);
    fixture.state.showInput(request.id);
    fixture.state.draft.value = '你好';
    const sending = fixture.state.send();
    await vi.waitFor(() => expect(releaseSnapshot).toBeDefined());
    expect(fixture.state.inputRequests.value).toEqual([request]);
    expect(fixture.state.openInput.value?.id).toBe(request.id);
    releaseSnapshot!({
      session,
      messages: [],
      tasks: [oldTask, newTask],
      pendingInputRequests: [request],
    });
    await sending;
    expect(fixture.state.openInput.value?.id).toBe(request.id);
    fixture.state.closeInput();
    expect(fixture.state.openInput.value).toBeNull();
    fixture.stop();
  });
});

function replyHarness() {
  const messages: Record<string, unknown>[] = [];
  const tasks: Record<string, unknown>[] = [];
  const posts: Record<string, unknown>[] = [];
  const cancelPosts: string[] = [];
  const eventCursors: string[] = [];
  let eventCounter = 0;
  let readError = '';
  let postError = '';
  let eventError = '';
  let emptyEvents = false;
  let nextTaskRead: Promise<unknown> | null = null;
  let nextSessionRead: Promise<unknown> | null = null;
  const state = harness(async (path, options) => {
    if (path.endsWith('/config')) return config;
    if (path === '/agent/sessions')
      return options?.method === 'POST' ? session : { items: [session] };
    if (path.endsWith('/messages')) {
      posts.push(options!);
      if (postError) throw new Error(postError);
      const currentTask = { ...task, id: `task-${tasks.length + 1}`, resultVersion: 0 };
      const message = {
        id: `user-${tasks.length + 1}`,
        sessionId: session.id,
        taskId: currentTask.id,
        role: 'user',
        content: (options!.body as { content: string }).content,
      };
      tasks.push(currentTask);
      messages.push(message);
      return { message, task: currentTask };
    }
    if (path.includes('/events?')) {
      eventCursors.push(new URL(path, 'http://fixture').searchParams.get('cursor')!);
      if (eventError) throw new Error(eventError);
      const revision = String(++eventCounter);
      return {
        items: emptyEvents ? [] : [{ id: revision, type: 'task.updated' }],
        nextCursor: revision,
      };
    }
    if (path.endsWith('/cancel')) {
      cancelPosts.push(path);
      const currentTask = tasks.find((item) => path.includes(`/${item.id}/`))!;
      currentTask.status = 'cancelled';
      return currentTask;
    }
    if (path.startsWith('/agent/sessions/') && nextSessionRead) {
      const response = nextSessionRead;
      nextSessionRead = null;
      return response;
    }
    if (readError) throw new Error(readError);
    if (path.includes('/tasks/') && nextTaskRead) {
      const response = nextTaskRead;
      nextTaskRead = null;
      return response;
    }
    if (path.includes('/tasks/'))
      return { task: tasks.find((item) => path.endsWith(`/${item.id}`)), results: [], steps: [] };
    return { session, messages: [...messages], tasks: [...tasks] };
  });
  return {
    ...state,
    messages,
    tasks,
    posts,
    cancelPosts,
    eventCursors,
    failRead: (error: string) => (readError = error),
    failPost: (error: string) => (postError = error),
    failEvents: (error: string) => (eventError = error),
    returnEmptyEvents: () => (emptyEvents = true),
    deferTaskRead() {
      let resolve: (value: unknown) => void = () => {};
      nextTaskRead = new Promise((release) => {
        resolve = release;
      });
      return resolve;
    },
    deferSessionRead() {
      let resolve: (value: unknown) => void = () => {};
      nextSessionRead = new Promise((release) => {
        resolve = release;
      });
      return resolve;
    },
    complete(content: string, status = 'completed') {
      const currentTask = tasks.at(-1)!;
      currentTask.status = status;
      currentTask.summary = '任务摘要不能替代持久助手消息';
      currentTask.summaryResultVersion = 0;
      const assistant = {
        id: `assistant-${messages.length}`,
        sessionId: session.id,
        taskId: currentTask.id,
        role: 'assistant',
        content,
      };
      messages.push(assistant);
      return assistant;
    },
  };
}

describe('海图当前回复生命周期', () => {
  it('仅关联本轮会话与任务的持久助手消息，选择旧任务保持本轮回复', async () => {
    const fixture = replyHarness();
    const { state } = fixture;
    await state.initialize();
    state.draft.value = '第一轮';
    await state.send();
    const first = fixture.complete('第一轮真实回复');
    await state.poll();
    expect(state.currentReply.value?.assistant?.id).toBe(first.id);
    state.draft.value = '第二轮';
    await state.send();
    fixture.messages.push({
      ...first,
      id: 'wrong-session',
      sessionId: 'session-b',
      taskId: 'task-2',
    });
    fixture.messages.push({ ...first, id: 'wrong-task', taskId: 'task-1' });
    await state.poll();
    expect(state.currentReply.value).toMatchObject({ question: '第二轮', assistant: null });
    const second = fixture.complete('第二轮真实回复');
    await state.poll();
    await state.loadTask('task-1');
    expect(state.currentReply.value?.assistant?.id).toBe(second.id);
    expect(state.currentReply.value?.taskId).toBe('task-2');
    expect(state.messages.value.map((message) => message.id)).toContain(first.id);
    expect(fixture.posts).toHaveLength(2);
    fixture.stop();
  });

  it('关闭当前回复后轮询保持隐藏，下一轮发送重新展示且历史完整', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.state.draft.value = '待处理问题';
    await fixture.state.send();
    fixture.state.dismissCurrentReply();
    const assistant = fixture.complete('关闭后到达的回复');
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toBeNull();
    expect(fixture.state.messages.value.map((message) => message.id)).toContain(assistant.id);
    fixture.state.draft.value = '新问题';
    await fixture.state.send();
    expect(fixture.state.currentReply.value).toMatchObject({
      question: '新问题',
      status: 'queued',
    });
    expect(fixture.posts).toHaveLength(2);
    fixture.stop();
  });

  it.each([
    'queued',
    'running',
    'waiting_result',
    'awaiting_input',
    'failed',
    'cancelled',
    'completed',
  ])('没有本轮助手消息时只呈现%s状态，任务摘要不能伪造答案', async (status) => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.state.draft.value = '状态问题';
    await fixture.state.send();
    Object.assign(fixture.tasks[0]!, { status, summary: '上轮摘要', error: '执行错误' });
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toMatchObject({ status, assistant: null });
    fixture.stop();
  });

  it('提交失败保留问题、草稿和错误，重试成功后替换本轮状态', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.failPost('发送连接中断');
    fixture.state.draft.value = '请回答这个问题';
    await fixture.state.send();
    expect(fixture.state.currentReply.value).toMatchObject({
      question: '请回答这个问题',
      status: 'send_failed',
      error: '发送连接中断',
      assistant: null,
    });
    expect(fixture.state.draft.value).toBe('请回答这个问题');
    fixture.failPost('');
    await fixture.state.send();
    expect(fixture.state.currentReply.value).toMatchObject({ status: 'queued', error: '' });
    expect(fixture.posts[1]?.idempotencyKey).toBe(fixture.posts[0]?.idempotencyKey);
    fixture.stop();
  });

  it('服务端已接受问题后刷新失败保留任务状态，恢复轮询无需再次提交', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.failRead('结果读取失败');
    fixture.state.draft.value = '已经受理的问题';
    await fixture.state.send();
    expect(fixture.state.currentReply.value).toMatchObject({
      question: '已经受理的问题',
      taskId: 'task-1',
      status: 'queued',
      error: '结果读取失败',
    });
    expect(fixture.state.draft.value).toBe('');
    fixture.failRead('');
    const assistant = fixture.complete('恢复读取后的答案');
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toMatchObject({ assistant, error: '' });
    expect(fixture.posts).toHaveLength(1);
    fixture.stop();
  });

  it('轮询权限错误覆盖当前回复并隐藏缓存答案，成功读取后恢复持久消息', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.state.draft.value = '权限测试问题';
    await fixture.state.send();
    const assistant = fixture.complete('已有缓存答案');
    await fixture.state.poll();
    fixture.failEvents('无权访问');
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toMatchObject({ assistant: null, error: '无权访问' });
    expect(fixture.state.messages.value).toEqual([]);
    fixture.failEvents('');
    fixture.returnEmptyEvents();
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toMatchObject({ assistant, error: '' });
    fixture.stop();
  });

  it('关闭锁在轮询连接故障和空事件恢复之后继续生效', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.state.draft.value = '稍后到达的回答';
    await fixture.state.send();
    fixture.state.dismissCurrentReply();
    fixture.failEvents('事件读取失败');
    await fixture.state.poll();
    fixture.complete('恢复期间形成的回答');
    fixture.failEvents('');
    fixture.returnEmptyEvents();
    await fixture.state.poll();
    expect(fixture.state.currentReply.value).toBeNull();
    expect(fixture.state.messages.value.at(-1)?.content).toBe('恢复期间形成的回答');
    expect(fixture.posts).toHaveLength(1);
    fixture.stop();
  });

  it('轮询权限拒绝后挂起的旧任务读取不能回填摘要、结果或调用记录', async () => {
    const fixture = replyHarness();
    try {
      await fixture.state.initialize();
      fixture.state.draft.value = '权限变化期间的任务';
      await fixture.state.send();
      fixture.complete('原本可读的助手答案');
      await fixture.state.poll();
      const resolve = fixture.deferTaskRead();
      const lateRead = fixture.state.loadTask('task-1');
      fixture.failEvents('当前账号没有此操作权限');
      await fixture.state.poll();
      expect(fixture.state.messages.value).toEqual([]);
      resolve({
        task: { ...fixture.tasks[0], summary: '迟到的敏感摘要' },
        results: [{ id: 'sensitive-result' }],
        steps: [{ key: 'sensitive-step', name: 'read_evidence' }],
      });
      await lateRead;
      expect(fixture.state.detail.value).toBeNull();
      expect(fixture.state.detailLoading.value).toBe(false);
      expect(fixture.state.currentReply.value).toMatchObject({
        assistant: null,
        error: '当前账号没有此操作权限',
      });
    } finally {
      fixture.stop();
    }
  });

  it('直接读取任务权限失败清理缓存历史和当前答案，成功空事件刷新后恢复', async () => {
    const fixture = replyHarness();
    try {
      await fixture.state.initialize();
      fixture.state.draft.value = '直接读取权限问题';
      await fixture.state.send();
      const assistant = fixture.complete('此前可读的回答');
      await fixture.state.poll();
      fixture.failRead('当前账号没有此操作权限');
      await fixture.state.loadTask('task-1');
      expect(fixture.state.messages.value).toEqual([]);
      expect(fixture.state.detail.value).toBeNull();
      expect(fixture.state.currentReply.value).toMatchObject({
        assistant: null,
        error: '当前账号没有此操作权限',
      });
      fixture.failRead('');
      fixture.returnEmptyEvents();
      await fixture.state.poll();
      expect(fixture.state.currentReply.value).toMatchObject({ assistant, error: '' });
      expect(fixture.posts).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });

  it('取消请求已接受但会话刷新权限失败时隐藏缓存，空事件成功刷新后恢复', async () => {
    const fixture = replyHarness();
    try {
      await fixture.state.initialize();
      fixture.state.draft.value = '取消读取边界问题';
      await fixture.state.send();
      const assistant = fixture.complete('已有敏感回复', 'awaiting_input');
      await fixture.state.poll();
      fixture.failRead('当前账号没有此操作权限');
      await fixture.state.cancel('task-1');
      expect(fixture.cancelPosts).toHaveLength(1);
      expect(fixture.state.messages.value).toEqual([]);
      expect(fixture.state.detail.value).toBeNull();
      expect(fixture.state.currentReply.value).toMatchObject({
        assistant: null,
        error: '当前账号没有此操作权限',
      });
      fixture.failRead('');
      fixture.returnEmptyEvents();
      await fixture.state.poll();
      expect(fixture.state.currentReply.value).toMatchObject({ assistant, error: '' });
      expect(fixture.posts).toHaveLength(1);
      expect(fixture.cancelPosts).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });

  it('权限错误之后迟到的会话刷新不回填历史任务、不清错误且不推进事件游标', async () => {
    const fixture = replyHarness();
    try {
      await fixture.state.initialize();
      fixture.state.draft.value = '旧会话读取竞争';
      await fixture.state.send();
      fixture.complete('旧缓存回答');
      await fixture.state.poll();
      const release = fixture.deferSessionRead();
      const stalePoll = fixture.state.poll();
      await vi.waitFor(() => expect(fixture.eventCursors).toEqual(['0', '1']));
      fixture.failRead('当前账号没有此操作权限');
      await fixture.state.loadTask('task-1');
      expect(fixture.state.messages.value).toEqual([]);
      fixture.failRead('');
      release({
        session,
        messages: [...fixture.messages],
        tasks: [
          fixture.tasks[0],
          { ...fixture.tasks[0], id: 'task-stale', summary: '迟到的敏感任务' },
        ],
      });
      await stalePoll;
      expect(fixture.state.messages.value).toEqual([]);
      expect(fixture.state.tasks.value.some((item) => item.id === 'task-stale')).toBe(false);
      expect(fixture.state.currentReply.value).toMatchObject({
        assistant: null,
        error: '当前账号没有此操作权限',
      });
      fixture.failRead('');
      fixture.returnEmptyEvents();
      await fixture.state.poll();
      expect(fixture.eventCursors).toEqual(['0', '1', '1']);
      expect(fixture.state.messages.value.at(-1)?.content).toBe('旧缓存回答');
      expect(fixture.state.currentReply.value?.error).toBe('');
      expect(fixture.posts).toHaveLength(1);
    } finally {
      fixture.stop();
    }
  });

  it('恢复历史、切会话、新会话和账号变化清空当前卡，不重发模型请求', async () => {
    const fixture = replyHarness();
    await fixture.state.initialize();
    fixture.state.draft.value = '已存储的问题';
    await fixture.state.send();
    fixture.complete('已存储的回答');
    await fixture.state.poll();
    await fixture.state.openSession(session.id);
    expect(fixture.state.currentReply.value).toBeNull();
    expect(fixture.state.messages.value).toHaveLength(2);
    fixture.state.newSession();
    expect(fixture.state.currentReply.value).toBeNull();
    fixture.state.draft.value = '账号切换之前';
    await fixture.state.send();
    fixture.identity.value = { user: { id: 'user-b', role: 'operator' } };
    await nextTick();
    expect(fixture.state.currentReply.value).toBeNull();
    expect(fixture.posts).toHaveLength(2);
    fixture.stop();
  });

  it('切换会话后迟到的发送受理响应不能重新创建旧会话当前卡', async () => {
    let accept: ((value: unknown) => void) | undefined;
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
      if (path.endsWith('/messages'))
        return new Promise((resolve) => {
          accept = resolve;
        });
      return { session: { ...session, id: 'session-b' }, messages: [], tasks: [] };
    });
    await state.initialize();
    state.draft.value = '旧会话发送快照';
    const sending = state.send();
    await vi.waitFor(() => expect(accept).toBeTypeOf('function'));
    await state.openSession('session-b');
    accept!({
      message: {
        id: 'old-user',
        content: '旧会话发送快照',
        sessionId: session.id,
        taskId: task.id,
        role: 'user',
      },
      task,
    });
    await sending;
    expect(state.currentReply.value).toBeNull();
    expect(state.activeSession.value?.id).toBe('session-b');
    expect(state.messages.value).toEqual([]);
    stop();
  });
});
describe('智能体会话状态', () => {
  it('发送开始即捕获本轮问题，发送期间修改草稿不会改写当前回复', async () => {
    let release: ((value: unknown) => void) | undefined;
    const { state, stop } = harness(async (path, options) => {
      if (path.endsWith('/config')) return config;
      if (path === '/agent/sessions') return options?.method === 'POST' ? session : { items: [] };
      if (path.endsWith('/messages'))
        return new Promise((resolve) => {
          release = resolve;
        });
      if (path.includes('/tasks/')) return { task, results: [], steps: [] };
      return { session, messages: [], tasks: [task] };
    });
    try {
      await state.initialize();
      state.draft.value = '本轮区域问题';
      const sending = state.send();
      expect(state).toHaveProperty('currentReply');
      expect(state.currentReply.value).toMatchObject({
        question: '本轮区域问题',
        status: 'sending',
        assistant: null,
      });
      state.draft.value = '下一轮尚未发送的草稿';
      expect(state.currentReply.value?.question).toBe('本轮区域问题');
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      release!({ message: { id: 'message-a', content: '本轮区域问题', role: 'user' }, task });
      await sending;
      expect(state.currentReply.value).toMatchObject({
        sessionId: session.id,
        taskId: task.id,
        userMessageId: 'message-a',
        status: 'queued',
      });
      expect(state.draft.value).toBe('下一轮尚未发送的草稿');
    } finally {
      stop();
    }
  });
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
