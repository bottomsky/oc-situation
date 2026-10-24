import type { Page } from '@playwright/test';
import { chartFixture } from './chart-fixture';
import { chartResult } from './chart-data';
import type { AgentInputRequest, AgentSelection, AgentFocusResult } from '@ais/contracts';

export async function agentFixture(
  page: Page,
  options: {
    enabled?: boolean;
    role?: string;
    queued?: boolean;
    spatial?: boolean;
    focus?: Pick<
      AgentFocusResult,
      'targets' | 'missing' | 'bbox' | 'displayStatus' | 'omittedCount'
    >;
    artifacts?: unknown[];
    interactive?: boolean;
    inputFields?: AgentInputRequest['fields'];
    inputPrefill?: AgentSelection;
    messageDelayMs?: number;
    chatReplies?: Record<string, string>;
    scriptedTasks?: Record<
      string,
      { status: string; reply?: string; error?: string; summary?: string; completeOnPoll?: boolean }
    >;
  } = {},
) {
  const chartCalls = await chartFixture(page, { role: options.role ?? 'operator' });
  const session = {
    id: 'session-a',
    ownerId: 'fixture-user',
    title: '区域研判',
    createdAt: '2026-10-11T00:00:00Z',
  };
  const messages: {
    id: string;
    content: string;
    role: string;
    sessionId: string;
    taskId: string;
    createdAt: string;
  }[] = [];
  const tasks: Record<string, unknown>[] = [];
  const submitted: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let inputRequests: AgentInputRequest[] = [];
  const answers: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  let created = false;
  let revision = 0;
  const reads = { config: 0, sessions: 0, creates: 0, events: 0 };
  await page.route('**/api/v1/agent/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    let json: unknown;
    if (path.endsWith('/config')) {
      reads.config++;
      json = {
        enabled: options.enabled ?? true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    } else if (path.endsWith('/sessions')) {
      if (req.method() === 'POST') {
        reads.creates++;
        created = true;
        json = session;
      } else {
        reads.sessions++;
        json = { items: created ? [session] : [] };
      }
    } else if (path.endsWith('/messages')) {
      const body = req.postDataJSON();
      submitted.push({ body, headers: req.headers() });
      if (options.messageDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.messageDelayMs));
      const id = `task-${tasks.length + 1}`;
      // These scripted responses exercise the browser contract; intent routing and DeepSeek run in API tests.
      const chatReply = options.chatReplies?.[body.content];
      const script = options.scriptedTasks?.[body.content];
      const task = {
        id,
        sessionId: session.id,
        ownerId: session.ownerId,
        goal: body.content,
        status:
          script?.status ??
          (chatReply
            ? 'queued'
            : body.bbox
              ? options.queued
                ? 'queued'
                : 'completed'
              : 'awaiting_input'),
        bbox: body.bbox ?? null,
        historyHours: body.historyHours,
        from: chartResult.from,
        to: chartResult.to,
        definitionId: chatReply || script ? null : 'area-low-speed-notice',
        generation: 1,
        modelCalls: 2,
        toolCalls: 3,
        resultVersion: body.bbox ? 1 : 0,
        summaryResultVersion: body.bbox ? 1 : null,
        summary:
          script?.summary ??
          (body.bbox
            ? '观测事实：记录到低速活动。[E1]\n规则匹配：与公告范围共现。\n推测与限制：原因仍需补充证据。'
            : null),
        error: script?.error ?? null,
        createdAt: session.createdAt,
        updatedAt: session.createdAt,
      };
      const message = {
        id: `message-${messages.length + 1}`,
        content: body.content,
        role: 'user',
        sessionId: session.id,
        taskId: id,
        createdAt: session.createdAt,
      };
      tasks.push(task);
      if (options.interactive) {
        Object.assign(task, { inputRevision: 0 });
        inputRequests = [
          {
            id: `request-${tasks.length}`,
            taskId: id,
            sessionId: session.id,
            inputRevision: 0,
            pauseGeneration: 1,
            fields: options.inputFields ?? ['region'],
            reason: options.inputFields?.includes('goal') ? 'missing_goal' : 'missing_region',
            prefill:
              options.inputPrefill ??
              (options.inputFields?.includes('goal') ? {} : { purpose: 'vessel_list' }),
            status: 'pending',
            response: null,
            createdAt: session.createdAt,
            answeredAt: null,
          },
        ];
      }
      messages.push(message);
      if (script?.reply && !['queued', 'running', 'waiting_result'].includes(script.status))
        messages.push({
          ...message,
          id: `message-${messages.length + 1}`,
          role: 'assistant',
          content: script.reply,
        });
      else if (!body.bbox && !chatReply && !script)
        messages.push({
          ...message,
          id: `message-${messages.length + 1}`,
          role: 'assistant',
          content: '请在海图确认需要分析的区域。',
        });
      json = {
        message,
        task,
        ...(options.interactive ? { pendingInputRequests: inputRequests } : {}),
      };
      revision++;
    } else if (path.endsWith('/responses')) {
      const body = req.postDataJSON();
      answers.push({ body, headers: req.headers() });
      const request = inputRequests[0]!;
      const task = tasks.find((item) => item.id === request.taskId)!;
      Object.assign(task, {
        status: 'completed',
        inputRevision: 1,
        resultInputRevision: 1,
        summaryInputRevision: 1,
        resultVersion: 1,
        summaryResultVersion: 1,
        summary: '已找到 1 艘船舶',
        definitionId: null,
      });
      messages.push({
        id: 'answer-a',
        role: 'assistant',
        content: '已找到 1 艘船舶',
        sessionId: session.id,
        taskId: String(task.id),
        createdAt: session.createdAt,
      });
      json = { task, request: { ...request, status: 'answered', response: body.values } };
      inputRequests = [];
      revision++;
    } else if (path.endsWith('/cancel')) {
      const id = path.split('/').at(-2);
      const task = tasks.find((item) => item.id === id)!;
      task.status = 'cancelled';
      revision++;
      json = task;
    } else if (path.includes('/tasks/')) {
      const task = tasks.find((item) => item.id === path.split('/').at(-1));
      json = {
        task,
        artifacts: options.artifacts ?? [],
        ...((options.spatial || options.focus) && task
          ? {
              focusResult: {
                kind: 'map_focus',
                version: task.resultVersion,
                inputRevision: 0,
                sessionId: session.id,
                taskId: task.id,
                targets: [
                  {
                    ref: { kind: 'vessel', id: '413123456' },
                    label: '关注船甲',
                    geometry: { type: 'Point', coordinates: [122, 31] },
                    observedAt: session.createdAt,
                  },
                  {
                    ref: { kind: 'event', id: 'incident-a', revision: 1 },
                    label: '关注事件乙',
                    geometry: {
                      type: 'LineString',
                      coordinates: [
                        [123, 32],
                        [124, 33],
                      ],
                    },
                    observedAt: session.createdAt,
                  },
                ],
                missing: [],
                bbox: [122, 31, 124, 33],
                displayStatus: 'complete',
                cameraPolicy: 'if-needed-once',
                ...options.focus,
              },
            }
          : {}),
        ...(options.interactive
          ? {
              pendingInputRequests: inputRequests,
              queryResult:
                task?.status === 'completed'
                  ? {
                      kind: 'vessel_list',
                      version: 1,
                      inputRevision: 1,
                      total: 1,
                      truncated: false,
                      asOf: session.createdAt,
                      selection: {},
                      items: [
                        {
                          mmsi: '123456789',
                          name: '示例船舶',
                          imo: null,
                          shipType: 70,
                          latestPosition: null,
                        },
                      ],
                    }
                  : null,
            }
          : {}),
        results:
          !options.interactive && task?.status === 'completed' && task.resultVersion === 1
            ? [chartResult]
            : [],
        steps:
          task?.status === 'completed' && task.resultVersion === 1
            ? [
                {
                  key: 'step-a',
                  name: 'run_analysis',
                  input: {},
                  output: {},
                  createdAt: session.createdAt,
                },
              ]
            : [],
      };
    } else if (path.endsWith('/events')) {
      reads.events++;
      for (const task of tasks) {
        const script = options.scriptedTasks?.[String(task.goal)];
        const reply = options.chatReplies?.[String(task.goal)] ?? script?.reply;
        if (script?.completeOnPoll === false) continue;
        if (task.status !== 'queued' || !reply) continue;
        task.status = 'completed';
        task.summary = reply;
        task.summaryResultVersion = 0;
        messages.push({
          id: `message-${messages.length + 1}`,
          role: 'assistant',
          content: reply,
          sessionId: session.id,
          taskId: String(task.id),
          createdAt: session.createdAt,
        });
        revision++;
      }
      json = {
        items:
          Number(url.searchParams.get('cursor')) < revision
            ? [{ id: String(revision), type: 'task.completed' }]
            : [],
        nextCursor: String(revision),
      };
    } else
      json = {
        session,
        messages,
        tasks,
        ...(options.interactive
          ? { pendingInputRequests: inputRequests, snapshotCursor: String(revision) }
          : {}),
      };
    await route.fulfill({ json });
  });
  return {
    submitted,
    answers,
    reads,
    messages,
    mapQueries: chartCalls.mapQueries,
    setTask(id: string, status: string, reply?: string) {
      const task = tasks.find((item) => item.id === id)!;
      task.status = status;
      if (reply) {
        task.summary = reply;
        task.summaryResultVersion = task.resultVersion;
        messages.push({
          id: `message-${messages.length + 1}`,
          role: 'assistant',
          content: reply,
          sessionId: session.id,
          taskId: id,
          createdAt: session.createdAt,
        });
      }
      revision++;
    },
    appendReply(content: string) {
      messages.push({
        id: `message-${messages.length + 1}`,
        content,
        role: 'assistant',
        sessionId: session.id,
        taskId: String(tasks.at(-1)?.id),
        createdAt: session.createdAt,
      });
      revision++;
    },
  };
}
