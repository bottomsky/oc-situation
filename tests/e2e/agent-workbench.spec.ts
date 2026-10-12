import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { chartResult } from './fixtures/chart-data';
import { openLeftPanel } from './chart-helpers';

async function agentFixture(
  page: Page,
  options: {
    enabled?: boolean;
    role?: string;
    queued?: boolean;
    messageDelayMs?: number;
    chatReplies?: Record<string, string>;
  } = {},
) {
  await chartFixture(page, { role: options.role ?? 'operator' });
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
      const task = {
        id,
        sessionId: session.id,
        ownerId: session.ownerId,
        goal: body.content,
        status: chatReply
          ? 'queued'
          : body.bbox
            ? options.queued
              ? 'queued'
              : 'completed'
            : 'awaiting_input',
        bbox: body.bbox ?? null,
        historyHours: body.historyHours,
        from: chartResult.from,
        to: chartResult.to,
        definitionId: chatReply ? null : 'area-low-speed-notice',
        generation: 1,
        modelCalls: 2,
        toolCalls: 3,
        resultVersion: body.bbox ? 1 : 0,
        summaryResultVersion: body.bbox ? 1 : null,
        summary: body.bbox
          ? '观测事实：记录到低速活动。[E1]\n规则匹配：与公告范围共现。\n推测与限制：原因仍需补充证据。'
          : null,
        error: null,
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
      messages.push(message);
      if (!body.bbox && !chatReply)
        messages.push({
          ...message,
          id: `message-${messages.length + 1}`,
          role: 'assistant',
          content: '请在海图确认需要分析的区域。',
        });
      json = { message, task };
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
        results: task?.status === 'completed' && task.resultVersion === 1 ? [chartResult] : [],
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
        const reply = options.chatReplies?.[String(task.goal)];
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
    } else json = { session, messages, tasks };
    await route.fulfill({ json });
  });
  return {
    submitted,
    reads,
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
  await expect(panel.getByRole('heading', { name: '智能体研判' })).toBeVisible();
  await panel.screenshot({ path: test.info().outputPath('agent-panel.png') });
  expect(calls.submitted[1]!.body.historyHours).toBe(24);
  expect(calls.submitted[1]!.body.bbox).toHaveLength(4);
  expect(calls.submitted[1]!.headers['x-csrf-token']).toBe('fixture-csrf');
  expect(calls.submitted[1]!.headers['idempotency-key']).toBeTruthy();
  await panel.getByText(/本地证据 ·/).click();
  await expect(panel.getByText(`MMSI ${chartResult.mmsi}`, { exact: false })).toBeVisible();
  await panel.getByRole('button', { name: '定位海图' }).click();
  await page.reload();
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  panel = page.getByTestId('agent-panel');
  await expect(panel.getByRole('heading', { name: '智能体研判' })).toBeVisible();
  await expect(panel.getByLabel('研判会话')).toHaveValue('session-a');
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
    await expect(panel.getByRole('heading', { name: '等待执行', exact: true })).toBeVisible();
    await expect(panel.getByLabel('研判对话记录').getByText(reply, { exact: true })).toBeVisible();
    await expect(panel.getByRole('heading', { name: '助手回复', exact: true })).toBeVisible();
    await expect(panel.getByText(/本次算法未形成匹配结果/)).toHaveCount(0);
    await expect(panel.getByText(/确认区域后继续发送/)).toHaveCount(0);
    await expect(panel.getByText(/结合下方证据复核/)).toHaveCount(0);
    await expect(panel.getByText('结果版本 0', { exact: true })).toBeVisible();
    await expect(composer.getByRole('button', { name: '发送分析问题' })).toBeDisabled();
  }
  expect(calls.submitted).toHaveLength(2);
  expect(calls.submitted.every((call) => !Object.hasOwn(call.body, 'bbox'))).toBe(true);
  await page.reload();
  await page.getByRole('tab', { name: 'AI 对话' }).click();
  panel = page.getByTestId('agent-panel');
  for (const reply of Object.values(replies))
    await expect(panel.getByLabel('研判对话记录').getByText(reply, { exact: true })).toBeVisible();
  await expect(panel.getByLabel('研判会话')).toHaveValue('session-a');
  expect(calls.reads.creates).toBe(1);
});

test('新增回复跟随底部，历史阅读保持位置，主动发送重新跟随', async ({ page }) => {
  const calls = await agentFixture(page, { chatReplies: { 你好: '你好，有什么可以帮助你？' } });
  const panel = await openAgent(page);
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('你好');
  await input.press('Enter');
  await expect(panel.getByRole('heading', { name: '助手回复', exact: true })).toBeVisible();
  const history = panel.getByLabel('研判对话记录');
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
  await expect(panel.getByRole('heading', { name: '已取消', exact: true })).toBeVisible();
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
  await expect(panel.getByLabel('研判会话')).toHaveValue('session-a');
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
  await intelligenceTab.click();
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
