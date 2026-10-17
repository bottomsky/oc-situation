import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { chartResult } from './fixtures/chart-data';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
import type { AgentInputRequest, AgentIntelligenceResult, AgentSelection } from '@ais/contracts';

async function agentFixture(
  page: Page,
  options: {
    enabled?: boolean;
    role?: string;
    queued?: boolean;
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

async function openAgent(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  return page.getByTestId('agent-panel');
}

async function openTaskDetails(page: Page) {
  await page
    .getByTestId('agent-panel')
    .getByRole('button', { name: '查看任务详情', exact: true })
    .click();
  const detail = page
    .getByTestId('chart-detail-float')
    .filter({ visible: true })
    .filter({ has: page.getByLabel('智能体任务详情', { exact: true }) });
  await expect(detail).toHaveAttribute('data-side', 'right');
  return detail;
}

test('结构化补问收起不重弹，确认后原任务自动继续展示船舶', async ({ page }) => {
  const calls = await agentFixture(page, { interactive: true });
  await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('查询某区域有哪些船');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '收起', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const previous = calls.reads.events;
  await expect.poll(() => calls.reads.events).toBeGreaterThan(previous);
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  await dialog.getByRole('button', { name: '使用当前视野', exact: true }).click();
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const detail = await openTaskDetails(page);
  await expect(detail.getByLabel('船舶查询结果')).toContainText('示例船舶');
  expect(calls.submitted).toHaveLength(1);
  expect(calls.answers).toHaveLength(1);
  expect(calls.answers[0]!.body).toMatchObject({
    action: 'accept',
    inputRevision: 0,
    values: { bbox: expect.any(Array) },
  });
  expect(calls.answers[0]!.headers['idempotency-key']).toBeTruthy();
  expect(calls.submitted[0]!.body.mapContext).toMatchObject({ bbox: expect.any(Array), hours: 24 });
});

test('待补充请求刷新仅恢复卡片，矩形框选返回弹窗且保持地图实例', async ({ page }) => {
  const calls = await agentFixture(page, { interactive: true });
  await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('分析这个范围');
  await input.press('Enter');
  await expect(page.getByRole('dialog', { name: '补充任务条件' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '继续选择', exact: true })).toBeVisible();
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  const map = page.getByTestId('sea-map');
  const instance = await map.getAttribute('data-map-instance');
  await dialog.getByRole('button', { name: '地图矩形框选', exact: true }).click();
  const overlay = page.getByTestId('agent-region-overlay');
  await expect(overlay).toBeVisible();
  await expect(dialog).not.toBeVisible();
  const bounds = (await overlay.boundingBox())!;
  await page.mouse.move(bounds.x + 100, bounds.y + 100);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 300, bounds.y + 250);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('agent-region-preview')).toBeVisible();
  await expect(overlay).toHaveCount(0);
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  expect(calls.answers).toHaveLength(0);
});

test('选择船舶目标动态显示选船控件，收起重开保留选择', async ({ page }) => {
  const calls = await agentFixture(page, { interactive: true, inputFields: ['goal'] });
  await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('帮我查询信息');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByLabel('任务目标', { exact: true }).selectOption('vessel_detail');
  await expect(dialog.getByLabel('搜索船舶', { exact: true })).toBeVisible();
  await dialog.getByLabel('搜索船舶', { exact: true }).fill('测试船');
  await dialog.getByRole('button', { name: '搜索', exact: true }).click();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  expect(calls.answers[0]!.body.values).toMatchObject({
    purpose: 'vessel_detail',
    mmsis: expect.any(Array),
  });
  expect(calls.submitted).toHaveLength(1);
});

test('分析目标动态显示区域时间，越界自定义时间保留草稿不提交', async ({ page }) => {
  const calls = await agentFixture(page, { interactive: true, inputFields: ['goal'] });
  await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('帮我研判');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByLabel('任务目标', { exact: true }).selectOption('port-restriction');
  await dialog.getByRole('button', { name: '使用当前视野', exact: true }).click();
  await dialog.getByLabel('分析时间范围').selectOption('custom');
  await dialog.getByLabel('开始时间（北京时间）').fill('2020-01-01T00:00');
  await dialog.getByLabel('结束时间（北京时间）').fill('2020-01-02T00:00');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('最近 30 天');
  await expect(dialog.getByLabel('开始时间（北京时间）')).toHaveValue('2020-01-01T00:00');
  expect(calls.answers).toHaveLength(0);
});

test('情报检索支持超过168小时历史，海况选择未来72小时独立参数', async ({ page }) => {
  const calls = await agentFixture(page, {
    interactive: true,
    inputFields: ['topic', 'time'],
    inputPrefill: {
      purpose: 'intelligence_search',
      intelligenceQuery: {
        kind: 'marine',
        forecastFrom: '2026-10-13T00:00:00Z',
        forecastTo: '2026-10-14T00:00:00Z',
      },
    },
  });
  await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('检索历史公告');
  await input.press('Enter');
  let dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByLabel('情报检索类型').selectOption('events');
  await dialog.getByLabel('情报检索主题', { exact: true }).fill('航行警告');
  await dialog.getByLabel('情报检索时间范围').selectOption('custom');
  await dialog.getByLabel('情报开始时间（北京时间）').fill('2024-01-01T00:00');
  await dialog.getByLabel('情报结束时间（北京时间）').fill('2025-01-01T00:00');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(calls.answers[0]!.body.values).toMatchObject({
    purpose: 'intelligence_search',
    intelligenceTimeRange: { from: '2023-12-31T16:00:00.000Z', to: '2024-12-31T16:00:00.000Z' },
    intelligenceQuery: { keyword: '航行警告' },
  });
  expect(calls.answers[0]!.body.values).not.toHaveProperty('historyHours');
  expect((calls.answers[0]!.body.values as AgentSelection).intelligenceQuery).not.toHaveProperty(
    'forecastFrom',
  );
  expect((calls.answers[0]!.body.values as AgentSelection).intelligenceQuery).not.toHaveProperty(
    'forecastTo',
  );
  await input.fill('检索未来海况');
  await input.press('Enter');
  dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByLabel('情报检索类型').selectOption('marine');
  await dialog.getByLabel('情报检索主题').fill('香港港');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).toContainText('海况仅覆盖六个代表点，请选择代表点');
  expect(calls.answers).toHaveLength(1);
  await dialog.getByLabel('海况代表点').selectOption('bohai');
  await dialog.getByLabel('情报检索时间范围').selectOption('72');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect.poll(() => calls.answers.length).toBe(2);
  const values = calls.answers[1]!.body.values as AgentSelection;
  expect(values.intelligenceQuery?.samplePointId).toBe('bohai');
  expect(
    Date.parse(values.intelligenceQuery!.forecastTo!) -
      Date.parse(values.intelligenceQuery!.forecastFrom!),
  ).toBe(72 * 3600000);
  expect(values).not.toHaveProperty('timeRange');
});

test('命名对象歧义必须选固定候选，允许空关键词且不改变地图', async ({ page }) => {
  const calls = await agentFixture(page, {
    interactive: true,
    inputFields: ['topic'],
    inputPrefill: {
      purpose: 'intelligence_search',
      intelligenceObjectUnclear: true,
      intelligenceObjectCandidates: [
        { id: 'port-east', name: '东港（甲）' },
        { id: 'port-west', name: '东港（乙）' },
      ],
      intelligenceQuery: { kind: 'events' },
    },
  });
  await openAgent(page);
  const map = page.getByTestId('sea-map');
  const instance = await map.getAttribute('data-map-instance');
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('查询东港情报');
  await input.press('Enter');
  const dialog = page.getByRole('dialog', { name: '补充任务条件' });
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect(dialog).toContainText('请选择本次检索对应的对象');
  expect(calls.answers).toHaveLength(0);
  await dialog.getByLabel('选择情报检索对象').selectOption('port-west');
  await dialog.getByRole('button', { name: '收起', exact: true }).click();
  await page.getByRole('button', { name: '继续选择', exact: true }).click();
  await expect(dialog.getByLabel('选择情报检索对象')).toHaveValue('port-west');
  await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
  await expect.poll(() => calls.answers.length).toBe(1);
  expect(calls.answers[0]!.body.values).toMatchObject({
    intelligenceQuery: { kind: 'events', objectId: 'port-west' },
  });
  expect(calls.answers[0]!.body.values).not.toHaveProperty('bbox');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
});

test('历史与浮卡情报引用绑定版本，归档按文本展示且仅已知位置可定位', async ({ page }) => {
  await chartFixture(page);
  const session = {
    id: 'intel-session',
    ownerId: 'fixture-user',
    title: '情报检索',
    createdAt: '2026-10-13T00:00:00Z',
  };
  const task = {
    id: 'intel-task',
    sessionId: session.id,
    ownerId: session.ownerId,
    goal: '查询公告',
    status: 'completed',
    bbox: null,
    historyHours: 24,
    from: session.createdAt,
    to: session.createdAt,
    definitionId: null,
    generation: 1,
    modelCalls: 0,
    toolCalls: 1,
    resultVersion: 2,
    summaryResultVersion: 2,
    inputRevision: 0,
    resultInputRevision: 0,
    summaryInputRevision: 0,
    intent: 'intelligence_search',
    summary: '当前公告[I1]',
    error: null,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
  const messages = [
    {
      id: 'old-intel-message',
      role: 'assistant',
      content: '旧版来源[I1]',
      taskId: task.id,
      sessionId: session.id,
      resultVersion: 1,
      inputRevision: 0,
      createdAt: session.createdAt,
    },
  ];
  const versions: string[] = [];
  function result(version: number): AgentIntelligenceResult {
    return {
      kind: 'intelligence_search',
      version,
      inputRevision: 0,
      asOf: session.createdAt,
      spec: { keyword: '公告' },
      total: 1,
      truncated: false,
      sourceHealth: [
        {
          sourceId: 'public-news',
          name: '公开资讯源',
          enabled: true,
          visibility: 'public',
          status: 'stale',
          lastPolledAt: session.createdAt,
          lastSuccessfulAt: session.createdAt,
          nextPollAt: null,
          lastError: null,
        },
      ],
      coverageNotes: ['这是已入库资料快照'],
      evidence: [
        {
          kind: 'event',
          reference: 'I1',
          event: {
            id: `event-${version}`,
            sourceId: 'public-news',
            sourceName: '公开资讯源',
            externalId: 'external-news',
            version,
            title: version === 1 ? '历史来源标题' : '当前来源标题',
            summary: '公开来源摘要',
            snippet: '<script>window.injected=true</script>',
            category: 'notice',
            status: 'active',
            reviewStatus: 'candidate',
            visibility: 'public',
            publishedAt: null,
            observedAt: session.createdAt,
            collectedAt: session.createdAt,
            effectiveFrom: null,
            effectiveTo: null,
            timeBasis: version === 1 ? 'index-observation' : 'effective',
            originalUrl: 'https://example.com/news',
            originalArchiveId: 'archive-news',
            geometry: version === 1 ? null : { type: 'Point', coordinates: [122, 32] },
            matchBasis: 'keyword',
            locationNote: version === 1 ? '地名提及，未确认位置' : '已登记位置',
          },
        },
      ],
    };
  }
  await page.addInitScript(() =>
    localStorage.setItem('ais-agent-session:fixture-user', 'intel-session'),
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path.endsWith('/config'))
      return route.fulfill({
        json: {
          enabled: true,
          defaultHistoryHours: 24,
          maxHistoryHours: 168,
          maxModelCalls: 12,
          maxToolCalls: 24,
        },
      });
    if (path.endsWith('/sessions')) return route.fulfill({ json: { items: [session] } });
    if (path.endsWith('/messages')) {
      const message = {
        id: 'new-intel-message',
        role: 'user',
        content: route.request().postDataJSON().content,
        taskId: task.id,
        sessionId: session.id,
        resultVersion: 2,
        inputRevision: 0,
        createdAt: session.createdAt,
      };
      messages.push(message, {
        ...message,
        id: 'new-intel-answer',
        role: 'assistant',
        content: '当前公告[I1]',
      });
      return route.fulfill({ json: { task, message, pendingInputRequests: [] } });
    }
    if (path.includes('/tasks/')) {
      const version = url.searchParams.get('resultVersion') ?? '2';
      versions.push(version);
      return route.fulfill({
        json: { task, results: [], steps: [], intelligenceResult: result(Number(version)) },
      });
    }
    if (path.endsWith('/events')) return route.fulfill({ json: { items: [], nextCursor: '0' } });
    return route.fulfill({ json: { session, messages, tasks: [task], pendingInputRequests: [] } });
  });
  await page.route('**/api/v1/intelligence/archives/archive-news', (route) =>
    route.fulfill({ json: { content: '<script>window.injected=true</script>归档正文' } }),
  );
  await openAgent(page);
  await page
    .locator('[data-message-id="old-intel-message"]')
    .getByRole('button', { name: '查看情报来源 [I1]', exact: true })
    .click();
  const dialog = page.locator(
    '[data-testid="chart-detail-float"][data-detail-kind="sources"]:visible',
  );
  await expect(dialog).toContainText('历史来源标题');
  await expect(dialog).toContainText('候选情报 · 待核实');
  await expect(dialog).toContainText('索引观测时间');
  await expect(dialog).toContainText('数据过期');
  await expect(dialog.getByRole('button', { name: '定位已知位置' })).toHaveCount(0);
  await dialog.getByRole('button', { name: '查看归档原文' }).click();
  await expect(dialog.getByLabel('情报归档原文')).toContainText(
    '<script>window.injected=true</script>',
  );
  expect(
    await page.evaluate(() => (window as unknown as { injected?: boolean }).injected),
  ).toBeUndefined();
  await expect(dialog.getByRole('link', { name: '查看来源原文' })).toHaveAttribute(
    'href',
    'https://example.com/news',
  );
  await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('再查当前公告');
  await input.press('Enter');
  await page
    .getByTestId('chart-agent-current-reply')
    .getByRole('button', { name: '查看情报来源 [I1]', exact: true })
    .click();
  await expect(dialog).toContainText('当前来源标题');
  await expect(dialog).toContainText('来源观测 / 更新');
  await expect(dialog).toContainText('发生 / 适用时间');
  const map = page.getByTestId('sea-map');
  const instance = await map.getAttribute('data-map-instance');
  await dialog.getByRole('button', { name: '定位已知位置' }).click();
  await expect(dialog).not.toBeVisible();
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  expect(versions).toContain('1');
  expect(versions).toContain('2');
});

test('情报工作台只读检索与来源登记保留公开属性及适配器', async ({ page }) => {
  await chartFixture(page);
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const searches: URL[] = [];
  const source = {
    sourceId: 'rss-public',
    name: '公开资讯订阅',
    kind: 'rss',
    adapter: 'rss',
    visibility: 'public',
    enabled: true,
    endpoint: 'https://example.com/feed.xml',
    allowedHosts: ['example.com'],
    authorizationConfirmed: true,
    pollSeconds: 300,
    timeoutSeconds: 30,
    requestsPerMinute: 6,
    maxDocuments: 5,
    trust: 'aggregator',
    lastSuccessfulAt: '2026-10-13T00:00:00Z',
  };
  await page.route('**/api/v1/intelligence/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() !== 'GET') {
      writes.push({ path, body: route.request().postDataJSON() });
      return route.fulfill({ json: {} });
    }
    if (path.endsWith('/sources')) return route.fulfill({ json: [source] });
    if (path.endsWith('/plot-set'))
      return route.fulfill({ json: { eventIds: [], hiddenEventIds: [] } });
    if (path.endsWith('/search')) {
      searches.push(url);
      return route.fulfill({
        json: {
          items: [],
          forecasts:
            url.searchParams.get('kind') === 'marine'
              ? [
                  {
                    id: 'marine-test',
                    sourceId: 'marine-public',
                    samplePointId: 'bohai',
                    pointName: '渤海代表点',
                    point: { lon: 120, lat: 39 },
                    grid: { lon: 120, lat: 39 },
                    fetchedAt: '2026-10-13T00:00:00Z',
                    modelPublishedAt: null,
                    validFrom: '2026-10-13T00:00:00Z',
                    validTo: '2026-10-14T00:00:00Z',
                    series: [],
                    originalArchiveId: null,
                    originalUrl: null,
                    visibility: 'public',
                  },
                ]
              : [],
          total: 0,
          nextCursor: null,
          asOf: '2026-10-13T00:00:00Z',
          spec: {},
          sourceHealth: [],
          coverageNotes: ['未连接的来源不会在提问时临时采集'],
        },
      });
    }
    return route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.goto('/intelligence');
  const search = page.getByRole('region', { name: '本地情报检索' });
  await search.getByLabel('检索情报主题').fill('航行警告');
  await search.getByRole('button', { name: '检索情报', exact: true }).click();
  await expect(search).toContainText('未找到匹配结果');
  await expect(search).toContainText('事件 0 条 · 海况 0 组');
  expect(searches[0]!.searchParams.get('keyword')).toBe('航行警告');
  await search.getByLabel('本地情报类型').selectOption('marine');
  await search.getByRole('button', { name: '检索情报', exact: true }).click();
  await expect(search).toContainText('事件 0 条 · 海况 1 组');
  await expect(search.getByText('渤海代表点 · 海况预报', { exact: true })).toBeVisible();
  expect(writes.filter((item) => !item.path.endsWith('/plot'))).toHaveLength(0);
  await page.getByText('已登记情报来源（1）', { exact: true }).click();
  await expect(page.getByRole('link', { name: '查看来源接口' })).toHaveAttribute(
    'href',
    source.endpoint,
  );
  await page.getByRole('button', { name: '停用来源', exact: true }).click();
  await expect
    .poll(() => writes.filter((item) => item.path.endsWith('/rss-public')).length)
    .toBe(1);
  expect(writes.find((item) => item.path.endsWith('/rss-public'))!.body).toMatchObject({
    visibility: 'public',
    adapter: 'rss',
    enabled: false,
  });
  await page.getByText('登记情报来源', { exact: true }).click();
  const form = page.locator('form').filter({ has: page.getByLabel('来源名称', { exact: true }) });
  await form.getByLabel('来源标识', { exact: true }).fill('marine-new');
  await form.getByLabel('来源名称', { exact: true }).fill('新海况源');
  await form.getByLabel('来源类型').selectOption('api');
  await form.getByLabel('来源可见性').selectOption('public');
  await form.getByLabel('采集适配器').selectOption('marine');
  await form.getByLabel('来源接口地址').fill('https://example.com/marine');
  await form.getByRole('checkbox').check();
  await form.getByRole('button', { name: '登记来源', exact: true }).click();
  await expect.poll(() => writes.filter((item) => item.path.endsWith('/sources')).length).toBe(1);
  expect(writes.find((item) => item.path.endsWith('/sources'))!.body).toMatchObject({
    visibility: 'public',
    adapter: 'marine',
    kind: 'api',
  });
});

test('区域补问、明确选区、结果证据及恢复会话', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const calls = await agentFixture(page);
  let panel = await openAgent(page);
  await page
    .getByTestId('chart-agent-composer')
    .getByLabel('分析问题或继续追问')
    .fill('分析低速活动与公告关联');
  await page
    .getByTestId('chart-agent-composer')
    .getByRole('button', { name: '发送分析问题' })
    .click();
  await expect(panel.getByText('请在海图确认需要分析的区域。', { exact: true })).toBeVisible();
  expect(calls.submitted[0]!.body).not.toHaveProperty('bbox');
  await panel.getByRole('button', { name: '确认当前海图视野' }).click();
  await page
    .getByTestId('chart-agent-composer')
    .getByLabel('分析问题或继续追问')
    .fill('已确认区域，请执行');
  await page
    .getByTestId('chart-agent-composer')
    .getByRole('button', { name: '发送分析问题' })
    .click();
  let detail = await openTaskDetails(page);
  await expect(detail.getByRole('heading', { name: '智能体研判' })).toBeVisible();
  await panel.screenshot({ path: test.info().outputPath('agent-panel.png') });
  expect(calls.submitted[1]!.body.historyHours).toBe(24);
  expect(calls.submitted[1]!.body.bbox).toHaveLength(4);
  expect(calls.submitted[1]!.headers['x-csrf-token']).toBe('fixture-csrf');
  expect(calls.submitted[1]!.headers['idempotency-key']).toBeTruthy();
  await detail.getByText(/本地证据 ·/).click();
  await expect(detail.getByText(`MMSI ${chartResult.mmsi}`, { exact: false })).toBeVisible();
  await detail.getByRole('button', { name: '定位海图' }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  panel = page.getByTestId('agent-panel');
  await expect(panel.getByTestId('agent-current-session')).toHaveAttribute(
    'data-session-id',
    'session-a',
  );
  detail = await openTaskDetails(page);
  await expect(detail.getByRole('heading', { name: '智能体研判' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('普通问候与北京时间查询无选区完成并持久恢复助手回复', async ({ page }) => {
  const replies = {
    你好: '你好，我可以帮助你查询信息和研判海域。',
    当前北京时间: '当前北京时间：2026年10月12日 22:30:00（UTC+8）。',
  };
  const calls = await agentFixture(page, { chatReplies: replies });
  let panel = await openAgent(page);
  const composer = page.getByTestId('chart-agent-composer');
  const input = composer.getByLabel('分析问题或继续追问');
  await expect(input).toHaveAttribute('placeholder', '输入问题，咨询信息或分析海域…');
  for (const [question, reply] of Object.entries(replies)) {
    await input.fill(question);
    await input.press('Enter');
    const detail = await openTaskDetails(page);
    await expect(detail.getByRole('heading', { name: '等待执行', exact: true })).toBeVisible();
    await expect(panel.getByLabel('研判对话记录').getByText(reply, { exact: true })).toBeVisible();
    await expect(detail.getByRole('heading', { name: '助手回复', exact: true })).toBeVisible();
    await expect(detail.getByText(/本次算法未形成匹配结果/)).toHaveCount(0);
    await expect(detail.getByText(/确认区域后继续发送/)).toHaveCount(0);
    await expect(detail.getByText(/结合下方证据复核/)).toHaveCount(0);
    await expect(detail.getByText('结果版本 0', { exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: '发送分析问题' })).toBeDisabled();
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  }
  expect(calls.submitted).toHaveLength(2);
  expect(calls.submitted.every((call) => !Object.hasOwn(call.body, 'bbox'))).toBe(true);
  await page.reload();
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  panel = page.getByTestId('agent-panel');
  for (const reply of Object.values(replies))
    await expect(panel.getByLabel('研判对话记录').getByText(reply, { exact: true })).toBeVisible();
  await expect(panel.getByTestId('agent-current-session')).toHaveAttribute(
    'data-session-id',
    'session-a',
  );
  expect(calls.reads.creates).toBe(1);
});

test('当前回复关闭后轮询保持隐藏，第二轮替换卡片并复用完整历史', async ({ page }) => {
  const calls = await agentFixture(page, {
    scriptedTasks: {
      第一轮问题: { status: 'queued', completeOnPoll: false },
      第二轮问题: { status: 'queued', completeOnPoll: false },
    },
  });
  const panel = await openAgent(page);
  const composer = page.getByTestId('chart-agent-composer');
  const input = composer.getByLabel('分析问题或继续追问');
  const card = page.getByTestId('chart-agent-current-reply');
  const map = page.getByTestId('sea-map');
  const instance = await map.getAttribute('data-map-instance');
  await expect(card).toHaveCount(0);
  await input.fill('第一轮问题');
  await input.press('Enter');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('第一轮问题');
  await expect(card).toContainText('等待执行');
  await card.getByRole('button', { name: '查看完整对话', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'AI 对话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    panel.getByLabel('研判对话记录').locator('[data-message-id="message-1"]'),
  ).toContainText('第一轮问题');
  await card.getByRole('button', { name: '关闭当前回复', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(input).toBeFocused();
  calls.setTask('task-1', 'completed', '第一轮持久回答');
  await expect(panel.getByLabel('研判对话记录')).toContainText('第一轮持久回答');
  await expect(card).toHaveCount(0);
  expect(calls.submitted).toHaveLength(1);
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await input.fill('第二轮问题');
  await input.press('Enter');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('第二轮问题');
  await expect(card).not.toContainText('第一轮持久回答');
  calls.setTask('task-2', 'completed', '第二轮持久回答');
  await expect(card).toContainText('第二轮持久回答');
  const reply = calls.messages.find((message) => message.content === '第二轮持久回答')!;
  await expect(card.locator(`[data-message-id="${reply.id}"]`)).toHaveText('第二轮持久回答');
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await card.getByRole('button', { name: '查看完整对话', exact: true }).click();
  const historyReply = panel.getByLabel('研判对话记录').locator(`[data-message-id="${reply.id}"]`);
  await expect(historyReply).toContainText('第二轮持久回答');
  await expect(historyReply).toBeInViewport();
  await panel.getByRole('button', { name: /第一轮问题.*已完成/ }).click();
  await expect(card).toContainText('第二轮问题');
  await expect(card).toContainText('第二轮持久回答');
  await expect(panel.getByLabel('研判对话记录').locator('.agent-message')).toHaveCount(4);
  expect(calls.submitted).toHaveLength(2);
  expect(calls.reads.creates).toBe(1);
  await page.reload();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(card).toHaveCount(0);
  await page.getByRole('tab', { name: 'AI 对话', exact: true }).click();
  await expect(panel.getByLabel('研判对话记录').locator('.agent-message')).toHaveCount(4);
  await expect(panel.getByLabel('研判对话记录')).toContainText('第一轮持久回答');
  await expect(panel.getByLabel('研判对话记录')).toContainText('第二轮持久回答');
  expect(calls.submitted).toHaveLength(2);
});

test('发送请求失败仍保留当前问题和草稿，关闭卡片不会重复请求', async ({ page }) => {
  await agentFixture(page);
  let requests = 0;
  await page.route('**/api/v1/agent/sessions/*/messages', async (route) => {
    requests++;
    await route.fulfill({ status: 503, json: { message: 'fixture scripted POST failure' } });
  });
  await page.goto('/');
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await expect(input).toBeEnabled();
  await input.fill('发送失败保留的问题');
  await input.press('Enter');
  const card = page.getByTestId('chart-agent-current-reply');
  await expect(card).toHaveAttribute('data-status', 'send_failed');
  await expect(card).toContainText('发送失败保留的问题');
  await expect(card.getByRole('alert')).toContainText('服务暂时无法完成请求，请重试');
  await expect(input).toHaveValue('发送失败保留的问题');
  await card.getByRole('button', { name: '关闭当前回复', exact: true }).click();
  await expect(card).toHaveCount(0);
  await expect(input).toBeFocused();
  expect(requests).toBe(1);
});

for (const key of ['+', '-', 'Home']) {
  test(`完整历史消息获得焦点后${key}键保持海图视野`, async ({ page }) => {
    const calls = await agentFixture(page, {
      scriptedTasks: { 历史键盘问题: { status: 'completed', reply: '持久历史回答' } },
    });
    const panel = await openAgent(page);
    const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
    await input.fill('历史键盘问题');
    await input.press('Enter');
    const card = page.getByTestId('chart-agent-current-reply');
    await expect(card).toContainText('持久历史回答');
    await expect.poll(() => calls.mapQueries.length).toBeGreaterThan(0);
    const originalZoom = Number(calls.mapQueries.at(-1)!.searchParams.get('zoom'));
    await page.getByRole('button', { name: '放大海图', exact: true }).click();
    await expect
      .poll(() => Number(calls.mapQueries.at(-1)!.searchParams.get('zoom')))
      .toBeGreaterThan(originalZoom);
    await page.waitForTimeout(600);
    await card.getByRole('button', { name: '查看完整对话', exact: true }).click();
    const message = calls.messages.find((item) => item.content === '持久历史回答')!;
    const historyMessage = panel
      .getByLabel('研判对话记录')
      .locator(`[data-message-id="${message.id}"]`);
    await expect(historyMessage).toBeFocused();
    const previous = calls.mapQueries.at(-1)!;
    const viewport = {
      bbox: previous.searchParams.get('bbox'),
      zoom: previous.searchParams.get('zoom'),
    };
    await historyMessage.press(key);
    await page.waitForTimeout(750);
    await page.screenshot({
      path: test
        .info()
        .outputPath(`history-focus-${key === '+' ? 'plus' : key === '-' ? 'minus' : 'home'}.png`),
    });
    const current = calls.mapQueries.at(-1)!;
    expect({
      bbox: current.searchParams.get('bbox'),
      zoom: current.searchParams.get('zoom'),
    }).toEqual(viewport);
  });
}

for (const [status, label, error] of [
  ['awaiting_input', '等待补充', ''],
  ['waiting_result', '等待算法结果', ''],
  ['failed', '执行失败', '模型服务暂时不可用'],
  ['cancelled', '已取消', ''],
  ['completed', '已完成', ''],
]) {
  test(`当前回复在${status}且无助手消息时显示真实状态`, async ({ page }) => {
    await agentFixture(page, {
      scriptedTasks: {
        普通状态问题: { status: status!, error, summary: '上一轮摘要不能充当本轮答案' },
      },
    });
    await page.goto('/');
    const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
    await expect(input).toBeEnabled();
    await input.fill('普通状态问题');
    await input.press('Enter');
    const card = page.getByTestId('chart-agent-current-reply');
    await expect(card).toContainText('普通状态问题');
    await expect(card).toContainText(label!);
    await expect(card).not.toContainText('上一轮摘要不能充当本轮答案');
    await expect(card.locator('[data-message-id]')).toHaveCount(0);
    if (error) await expect(card).toContainText(error);
  });
}

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1002, height: 780 },
  { width: 390, height: 844 },
  { width: 390, height: 568 },
]) {
  test(`长回复在${viewport.width}x${viewport.height}中央滚动且输入保持可点击`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const longReply = [
      ...Array.from(
        { length: 90 },
        (_, index) => `第${index + 1}段：长回复提供完整的本轮事实与说明。`,
      ),
      '连续内容'.repeat(100),
      '长回复末尾',
    ].join('\n');
    const calls = await agentFixture(page, {
      scriptedTasks: { 长回复问题: { status: 'completed', reply: longReply } },
    });
    await page.goto('/');
    const map = page.getByTestId('sea-map');
    await expect(map).toHaveAttribute('data-ready', 'true');
    const instance = await map.getAttribute('data-map-instance');
    const sidebarWasOpen = await page.getByTestId('chart-right-panel').isVisible();
    const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
    await input.fill('长回复问题');
    await input.press('Enter');
    const card = page.getByTestId('chart-agent-current-reply');
    await expect(card).toContainText('长回复末尾');
    await expect(page.getByTestId('chart-right-panel')).toBeVisible({ visible: sidebarWasOpen });
    await expect(card).toBeInViewport();
    if (!sidebarWasOpen) {
      await card.getByRole('button', { name: '查看完整对话', exact: true }).click();
      await expect(page.getByTestId('chart-right-panel')).toBeVisible();
      await expect(page.getByTestId('agent-panel').getByLabel('研判对话记录')).toContainText(
        longReply,
      );
      await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
    }
    if (viewport.width <= 1002) {
      if (await page.getByTestId('chart-right-panel').isVisible())
        await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
      if (await page.getByTestId('chart-left-panel').isVisible())
        await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
    }
    const bounds = (await card.boundingBox())!;
    const mapBounds = (await map.boundingBox())!;
    const inputBounds = (await input.boundingBox())!;
    const replyBody = card.getByLabel('当前回复内容');
    expect(
      await replyBody.evaluate((element) => element.clientHeight),
      '当前回复正文至少保留可阅读的一至两行高度',
    ).toBeGreaterThanOrEqual(40);
    const close = card.getByRole('button', { name: '关闭当前回复', exact: true });
    expect(
      await close.evaluate((button) => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(
          bounds.x + bounds.width / 2,
          bounds.y + bounds.height / 2,
        );
        return !!hit && button.contains(hit);
      }),
      '关闭当前回复按钮的中心应命中自身，保留实际点击范围',
    ).toBe(true);
    expect(bounds.x).toBeGreaterThanOrEqual(mapBounds.x - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(mapBounds.x + mapBounds.width + 1);
    expect(bounds.y).toBeGreaterThanOrEqual(mapBounds.y - 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(inputBounds.y);
    expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(
      true,
    );
    const reply = card.locator('[data-message-id]');
    const scroller = await reply.evaluateHandle((element) => {
      let current: HTMLElement | null = element as HTMLElement;
      while (current && !current.matches('[data-testid="chart-agent-current-reply"]')) {
        if (
          current.scrollHeight > current.clientHeight &&
          /auto|scroll/.test(getComputedStyle(current).overflowY)
        )
          return current;
        current = current.parentElement;
      }
      return current;
    });
    expect(
      await scroller.evaluate(
        (element) => !!element && element.scrollHeight > element.clientHeight,
      ),
    ).toBe(true);
    const initialScroll = await scroller.evaluate((element) => element!.scrollTop);
    await expect.poll(() => calls.mapQueries.length).toBeGreaterThan(0);
    const previousZoom = calls.mapQueries.at(-1)!.searchParams.get('zoom');
    const firstObservedQuery = calls.mapQueries.length;
    const bodyBounds = (await replyBody.boundingBox())!;
    const wheelPoint = {
      x: bodyBounds.x + bodyBounds.width / 2,
      y: bodyBounds.y + bodyBounds.height / 2,
    };
    expect(
      await replyBody.evaluate(
        (body, point) => body.contains(document.elementFromPoint(point.x, point.y)),
        wheelPoint,
      ),
      '滚轮指针应命中回复正文可视区域',
    ).toBe(true);
    await page.mouse.move(wheelPoint.x, wheelPoint.y);
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => scroller.evaluate((element) => element!.scrollTop))
      .toBeGreaterThan(initialScroll);
    await replyBody.focus();
    for (const key of ['Home', '+', '-']) await replyBody.press(key);
    await page.waitForTimeout(500);
    expect(
      calls.mapQueries
        .slice(firstObservedQuery)
        .every((query) => query.searchParams.get('zoom') === previousZoom),
      '在当前回复滚动或使用键盘时，海图查询中的缩放值保持一致',
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await input.click();
    await expect(input).toBeFocused();
    await page.screenshot({
      path: test.info().outputPath(`current-reply-${viewport.width}x${viewport.height}.png`),
    });
    await card.getByRole('button', { name: '关闭当前回复', exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(input).toBeFocused();
    await expect(map).toHaveAttribute('data-map-instance', instance!);
    expect(calls.submitted).toHaveLength(1);
  });
}

test('新增回复跟随底部，历史阅读保持位置，主动发送重新跟随', async ({ page }) => {
  const calls = await agentFixture(page, { chatReplies: { 你好: '你好，有什么可以帮助你？' } });
  const panel = await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('你好');
  await input.press('Enter');
  const history = panel.getByLabel('研判对话记录');
  await expect(history.getByText('你好，有什么可以帮助你？', { exact: true })).toBeVisible();
  const scroll = page.getByTestId('chart-right-panel').locator('.chart-panel-scroll');
  await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  calls.appendReply(Array.from({ length: 60 }, (_, index) => `历史消息段落 ${index}`).join('\n'));
  await expect(history.getByText(/历史消息段落 59/)).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = (await scroll.boundingBox())!;
      const reply = (await history.locator('.agent-message').last().boundingBox())!;
      return Math.abs(reply.y + reply.height - bounds.y - bounds.height) < 3;
    })
    .toBe(true);
  await scroll.evaluate((el) => {
    el.scrollTop = 0;
  });
  const position = await scroll.evaluate((el) => el.scrollTop);
  calls.appendReply('历史阅读期间收到的新回复');
  await expect(history.getByText('历史阅读期间收到的新回复', { exact: true })).toHaveCount(1);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(position);
  await input.fill('继续分析');
  await input.press('Enter');
  const latest = history.locator('.agent-message').last();
  await expect(latest).toContainText('请在海图确认需要分析的区域。');
  await expect
    .poll(async () => {
      const bounds = (await scroll.boundingBox())!;
      const reply = (await latest.boundingBox())!;
      return reply.y + reply.height <= bounds.y + bounds.height + 2 && reply.y >= bounds.y;
    })
    .toBe(true);
});

test('取消任务后可以继续追问', async ({ page }) => {
  await agentFixture(page, { queued: true });
  const panel = await openAgent(page);
  await panel.getByRole('button', { name: '确认当前海图视野' }).click();
  await page
    .getByTestId('chart-agent-composer')
    .getByLabel('分析问题或继续追问')
    .fill('分析港口限制');
  await page
    .getByTestId('chart-agent-composer')
    .getByRole('button', { name: '发送分析问题' })
    .click();
  await expect(
    page.getByTestId('chart-agent-composer').getByRole('button', { name: '发送分析问题' }),
  ).toBeDisabled();
  await expect(
    page.getByTestId('chart-agent-composer').getByText(/助手正在处理问题/),
  ).toBeVisible();
  await panel.getByRole('button', { name: '取消分析任务' }).click();
  const detail = await openTaskDetails(page);
  await expect(detail.getByRole('heading', { name: '已取消', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page
    .getByTestId('chart-agent-composer')
    .getByLabel('分析问题或继续追问')
    .fill('改为分析低速活动');
  await expect(
    page.getByTestId('chart-agent-composer').getByRole('button', { name: '发送分析问题' }),
  ).toBeEnabled();
});

test('只读账号和未启用服务明确展示状态', async ({ page }) => {
  await agentFixture(page, { role: 'viewer' });
  let panel = await openAgent(page);
  await expect(panel.getByText('当前账号为只读权限，可查看已有会话与证据。')).toBeVisible();
  await expect(panel.getByLabel('分析问题或继续追问')).toHaveCount(0);
  await expect(
    page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问'),
  ).toBeDisabled();
  await expect(
    page.getByTestId('chart-agent-composer').getByRole('button', { name: '发送分析问题' }),
  ).toBeDisabled();
  await agentFixture(page, { enabled: false });
  panel = await openAgent(page);
  await expect(panel.getByText(/区域研判智能体尚未启用/)).toBeVisible();
  await expect(
    page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问'),
  ).toBeDisabled();
});

test('Enter发送、Shift+Enter换行及中文输入组合确认共享草稿', async ({ page }) => {
  const calls = await agentFixture(page);
  await page.goto('/');
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await expect(input).toBeEnabled();
  await input.fill('分析海域');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('分析海域\n');
  await page.keyboard.insertText('中文补充');
  await expect(input).toHaveValue('分析海域\n中文补充');
  expect(calls.submitted).toHaveLength(0);
  await input.dispatchEvent('compositionstart');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: false });
  await input.dispatchEvent('compositionend');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  expect(calls.submitted).toHaveLength(0);
  await input.press('Enter');
  await expect.poll(() => calls.submitted.length).toBe(1);
  expect(calls.submitted[0]!.body.content).toBe('分析海域\n中文补充');
  await expect(input).toHaveValue('');
  await expect(
    page
      .getByTestId('agent-panel')
      .getByLabel('研判对话记录')
      .getByText('分析海域\n中文补充', { exact: true }),
  ).toBeVisible();
});

test('悬浮输入随左右栏和窗口居中且保留海图控件点击范围', async ({ page }) => {
  await agentFixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  const composer = page.getByTestId('chart-agent-composer');
  const capsule = composer.getByRole('form', { name: '海图智能体输入' });
  async function checkGeometry() {
    const bounds = (await map.boundingBox())!;
    const dock = (await capsule.boundingBox())!;
    expect(Math.abs(dock.x + dock.width / 2 - (bounds.x + bounds.width / 2))).toBeLessThan(3);
    expect(dock.x).toBeGreaterThanOrEqual(bounds.x);
    expect(dock.x + dock.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
    expect(dock.y + dock.height).toBeLessThan(bounds.y + bounds.height);
    expect(bounds.height).toBeGreaterThan(400);
    for (const control of await page
      .locator(
        '[data-testid="direction-legend"], [data-testid="chart-source-note"], .maplibregl-ctrl-attrib',
      )
      .all()) {
      const box = await control.boundingBox();
      if (!box) continue;
      const overlapWidth =
        Math.min(dock.x + dock.width, box.x + box.width) - Math.max(dock.x, box.x);
      const overlapHeight =
        Math.min(dock.y + dock.height, box.y + box.height) - Math.max(dock.y, box.y);
      expect(overlapWidth <= 0 || overlapHeight <= 0, '悬浮输入应给图例及底图署名保留位置').toBe(
        true,
      );
    }
    const zoom = page.getByRole('button', { name: '放大海图', exact: true });
    const zoomBounds = (await zoom.boundingBox())!;
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest('button')?.getAttribute('aria-label'),
        { x: zoomBounds.x + zoomBounds.width / 2, y: zoomBounds.y + zoomBounds.height / 2 },
      ),
    ).toBe('放大海图');
    await expect(map).toHaveAttribute('data-map-instance', instance!);
    await expect(page.getByRole('separator', { name: '调整数据列表高度' })).toHaveCount(0);
    expect(
      await page
        .getByTestId('chart-workspace')
        .evaluate((el) => (el as HTMLElement).style.getPropertyValue('--chart-bottom-height')),
    ).toBe('');
  }
  for (const width of [1920, 1440, 1280, 768]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width < 1440) {
      if (await page.getByTestId('chart-left-panel').isVisible())
        await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
      if (await page.getByTestId('chart-right-panel').isVisible())
        await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
    }
    await expect(composer).toBeVisible();
    await checkGeometry();
    if (width === 1920) {
      await openLeftPanel(page);
      await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
      await checkGeometry();
      await openLeftPanel(page);
      await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
      await checkGeometry();
      await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
      await checkGeometry();
    }
    await page.screenshot({ path: test.info().outputPath(`composer-${width}.png`) });
  }
});

test('悬浮输入取代底部表格并复用右侧会话与请求生命周期', async ({ page }) => {
  const calls = await agentFixture(page, { messageDelayMs: 300 });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  const composer = page.getByTestId('chart-agent-composer');
  await expect(composer).toBeVisible();
  await expect(page.getByTestId('chart-bottom-tables')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: '调整数据列表高度' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '折叠列表', exact: true })).toHaveCount(0);
  const input = composer.getByLabel('分析问题或继续追问');
  await expect(input).toBeEnabled();
  await input.fill('分析低速船舶与公告的关联');
  await input.press('Enter');
  await input.press('Enter');
  await expect(page.getByRole('tab', { name: 'AI 对话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const panel = page.getByTestId('agent-panel');
  await expect(
    panel.getByLabel('研判对话记录').getByText('分析低速船舶与公告的关联', { exact: true }),
  ).toBeVisible();
  await expect(input).toHaveValue('');
  expect(calls.submitted).toHaveLength(1);
  expect(calls.submitted[0]!.body).not.toHaveProperty('bbox');
  await expect(panel.getByTestId('agent-current-session')).toHaveAttribute(
    'data-session-id',
    'session-a',
  );
  await expect(panel.getByLabel('分析问题或继续追问')).toHaveCount(0);
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await composer.getByRole('button', { name: '打开智能体对话', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'AI 对话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  expect(calls.reads.config).toBe(1);
  expect(calls.reads.sessions).toBe(1);
  expect(calls.reads.creates).toBe(1);
  const previousReads = calls.reads.events;
  await expect.poll(() => calls.reads.events).toBeGreaterThan(previousReads);
  const reads = calls.reads.events;
  await page.waitForTimeout(700);
  expect(calls.reads.events).toBe(reads);
  await openLeftPanel(page);
  const intelligenceTab = page.getByRole('tab', { name: '情报标绘', exact: true });
  await selectLeftTab(page, '情报标绘');
  await composer.getByRole('button', { name: '打开智能体对话', exact: true }).click();
  await expect(intelligenceTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'AI 对话', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
});

test('移除整排态势指标和来源状态后海图延伸至标题控制栏', async ({ page }) => {
  await agentFixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect(page.getByRole('region', { name: '态势数据状态', exact: true })).toHaveCount(0);
  await expect(page.locator('.chart-status-strip')).toHaveCount(0);
  await expect(page.locator('.chart-source-status')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '全球船位观测', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '放大海图', exact: true })).toBeVisible();
  const bounds = (await map.boundingBox())!;
  const heading = (await page.locator('.chart-map-heading').boundingBox())!;
  const center = (await page.locator('.chart-center').boundingBox())!;
  expect(bounds.y - (heading.y + heading.height)).toBeGreaterThanOrEqual(0);
  expect(bounds.y - (heading.y + heading.height)).toBeLessThanOrEqual(16);
  expect(center.height - bounds.height).toBeLessThanOrEqual(heading.height + 24);
});

test('悬浮输入空闲透明无阴影，聚焦或非空草稿高亮并随清空恢复', async ({ page }) => {
  const calls = await agentFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  const composer = page.getByTestId('chart-agent-composer');
  const capsule = composer.getByRole('form', { name: '海图智能体输入' });
  const input = composer.getByLabel('分析问题或继续追问');
  await expect(input).toBeEnabled();
  async function appearance() {
    return capsule.evaluate((el) => {
      const style = getComputedStyle(el);
      return {
        border: style.borderTopColor,
        shadow: style.boxShadow,
        background:
          style.backgroundImage === 'none' ? style.backgroundColor : style.backgroundImage,
        alphas: [
          ...(style.backgroundImage === 'none'
            ? style.backgroundColor
            : style.backgroundImage
          ).matchAll(/rgba\([^)]*,\s*([\d.]+)\)/g),
        ].map((match) => Number(match[1])),
      };
    });
  }
  await expect(capsule).toHaveAttribute('data-active', 'false');
  const idle = await appearance();
  expect(idle.shadow).toBe('none');
  expect(idle.alphas.length).toBeGreaterThan(0);
  expect(idle.alphas.every((alpha) => alpha < 0.4)).toBe(true);
  await page.screenshot({ path: test.info().outputPath('composer-idle.png') });
  await input.focus();
  await expect(capsule).toHaveAttribute('data-active', 'true');
  await capsule.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((animation) => animation.finished.catch(() => {})));
  });
  await expect.poll(async () => (await appearance()).border).not.toBe(idle.border);
  const active = await appearance();
  expect(active.alphas.length).toBeGreaterThan(0);
  expect(active.alphas.every((alpha) => alpha < 0.4)).toBe(true);
  await input.fill('海上态势研判草稿');
  await input.evaluate((el) => (el as HTMLTextAreaElement).blur());
  await expect(capsule).toHaveAttribute('data-active', 'true');
  expect((await appearance()).border).toBe(active.border);
  await page.screenshot({ path: test.info().outputPath('composer-active.png') });
  await input.fill('');
  await input.evaluate((el) => (el as HTMLTextAreaElement).blur());
  await expect(capsule).toHaveAttribute('data-active', 'false');
  await expect.poll(appearance).toEqual(idle);
  await input.focus();
  await input.press('Shift+Tab');
  await expect(composer.getByRole('button', { name: '打开智能体对话', exact: true })).toBeFocused();
  await expect(capsule).toHaveAttribute('data-active', 'false');
  expect(calls.submitted).toHaveLength(0);
});
