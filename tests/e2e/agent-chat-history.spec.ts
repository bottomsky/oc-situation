import { expect, test, type Locator, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';

const sessions = [
  { id: 'history-a', title: '区域研判助手', createdAt: new Date().toISOString() },
  { id: 'history-b', title: '目标船舶分析', createdAt: '2026-10-12T09:12:00Z' },
  { id: 'history-c', title: '异常事件研判', createdAt: '2026-09-17T09:12:00Z' },
].map((session) => ({ ...session, ownerId: 'fixture-user' }));
const messageTimes = ['2026-10-17T11:24:01Z', '2026-10-17T11:24:08Z'];

async function fixture(page: Page, options: { empty?: boolean; saved?: boolean } = {}) {
  await chartFixture(page, { role: 'operator' });
  const calls = { reads: [] as string[], writes: 0 };
  if (options.saved !== false)
    await page.addInitScript(() =>
      localStorage.setItem('ais-agent-session:fixture-user', 'history-a'),
    );
  const task = {
    id: 'history-task',
    sessionId: 'history-a',
    ownerId: 'fixture-user',
    goal: '查询港口公告详情',
    status: 'completed',
    bbox: null,
    historyHours: 24,
    from: messageTimes[0],
    to: messageTimes[1],
    definitionId: null,
    generation: 1,
    modelCalls: 0,
    toolCalls: 1,
    resultVersion: 1,
    summaryResultVersion: 1,
    inputRevision: 0,
    resultInputRevision: 0,
    summaryInputRevision: 0,
    intent: 'intelligence_search',
    summary: '查询到港口公告[I1]',
    error: null,
    createdAt: messageTimes[0],
    updatedAt: messageTimes[1],
  };
  await page.route('**/api/v1/agent/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== 'GET') calls.writes++;
    let json: unknown;
    if (path.endsWith('/config'))
      json = {
        enabled: true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/sessions')) json = { items: options.empty ? [] : sessions };
    else if (path.endsWith('/events')) json = { items: [], nextCursor: '0' };
    else if (/^\/api\/v1\/agent\/sessions\/[^/]+\/memory$/.test(path))
      json = {
        sessionId: path.split('/').at(-2)!,
        revision: 0,
        turnSeq: 0,
        generation: 0,
        summary: '',
        conditions: {},
        objectSets: [],
        references: [],
        updatedAt: messageTimes[1]!,
        appliedAccountMemories: [],
        appliedTaskId: null,
        features: { session: true, account: true, proposals: true },
      };
    else if (path.includes('/tasks/'))
      json = {
        task,
        results: [],
        steps: [],
        intelligenceResult: {
          kind: 'intelligence_search',
          version: 1,
          inputRevision: 0,
          asOf: messageTimes[1],
          spec: { keyword: '港口' },
          total: 1,
          truncated: false,
          sourceHealth: [],
          coverageNotes: [],
          evidence: [
            {
              kind: 'event',
              reference: 'I1',
              event: {
                id: 'history-event',
                sourceId: 'manual',
                sourceName: '公开海事公告',
                externalId: 'history-notice',
                version: 1,
                title: '历史会话引用：港口公告原文',
                summary: '港区施工期间暂停靠泊。',
                snippet: '请遵守航行通告。',
                category: 'notice',
                status: 'active',
                reviewStatus: 'confirmed',
                visibility: 'public',
                publishedAt: messageTimes[0],
                observedAt: messageTimes[0],
                collectedAt: messageTimes[0],
                effectiveFrom: messageTimes[0],
                effectiveTo: null,
                timeBasis: 'effective',
                originalUrl: 'https://example.com/notice',
                originalArchiveId: 'history-archive',
                geometry: { type: 'Point', coordinates: [122, 32] },
                matchBasis: 'keyword',
                locationNote: '已登记位置',
              },
            },
          ],
        },
      };
    else {
      const id = path.split('/').at(-1)!;
      calls.reads.push(id);
      const session = sessions.find((item) => item.id === id)!;
      json = {
        session,
        messages: [
          {
            id: `${id}-user`,
            role: 'user',
            content: id === 'history-a' ? '请查询港口公告' : `${session.title}的用户问题`,
            sessionId: id,
            taskId: id === 'history-a' ? task.id : null,
            createdAt: messageTimes[0],
          },
          {
            id: `${id}-assistant`,
            role: 'assistant',
            content: id === 'history-a' ? task.summary : `${session.title}的历史回答`,
            sessionId: id,
            taskId: id === 'history-a' ? task.id : null,
            resultVersion: 1,
            inputRevision: 0,
            createdAt: messageTimes[1],
          },
        ],
        tasks: id === 'history-a' ? [task] : [],
        pendingInputRequests: [],
      };
    }
    await route.fulfill({ json });
  });
  return calls;
}

async function openChat(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  const panel = page.getByTestId('chart-right-panel');
  if (!(await panel.isVisible())) {
    const toggle = page.getByRole('button', { name: '智能协同', exact: true });
    if (await toggle.isVisible()) await toggle.click();
    else await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
  }
  await panel.getByRole('tab', { name: 'AI 对话', exact: true }).click();
  await expect(panel.getByRole('button', { name: '历史会话', exact: true })).toBeEnabled();
  return panel;
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: '历史会话', exact: true }).click();
  const history = page.getByRole('dialog', { name: '历史会话', exact: true });
  await expect(history).toBeVisible();
  await expect(history).toHaveCSS('transform', 'none');
  return history;
}

async function insideViewport(page: Page, element: Locator) {
  const box = (await element.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

for (const width of [1920, 1280, 390]) {
  test(`${width}px 历史栏悬浮且地图和当前会话位置保持稳定`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await fixture(page);
    const panel = await openChat(page);
    const intro = (await panel.getByTestId('agent-chat-intro').boundingBox())!;
    const trigger = (await panel.getByRole('button', { name: '历史会话' }).boundingBox())!;
    expect(trigger.y).toBeGreaterThanOrEqual(intro.y + intro.height - 1);
    const map = page.getByTestId('sea-map');
    const instance = await map.getAttribute('data-map-instance');
    const mapBefore = await map.boundingBox();
    const panelBefore = await panel.boundingBox();
    const history = await openHistory(page);
    await insideViewport(page, history);
    await expect(history).toHaveCSS('opacity', '1');
    const surface = await history.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        radii: [
          style.borderTopLeftRadius,
          style.borderTopRightRadius,
          style.borderBottomLeftRadius,
          style.borderBottomRightRadius,
        ].map(parseFloat),
        shadow: style.boxShadow,
        rightBorder: parseFloat(style.borderRightWidth),
        background: style.backgroundImage,
      };
    });
    expect(surface.radii).toEqual([0, 0, 0, 0]);
    expect(surface.shadow).toBe('none');
    expect(surface.rightBorder).toBe(0);
    expect(surface.background).toMatch(/^linear-gradient\((90deg|to right),/);
    expect(surface.background).toMatch(/(?:rgba\([^)]*,\s*0\)|transparent)\s*(?:100%)?\)$/);
    const search = (await history.getByPlaceholder('搜索会话...').boundingBox())!;
    const searchIcon = (await history.locator('.agent-history-search svg').boundingBox())!;
    expect(
      Math.abs(search.y + search.height / 2 - searchIcon.y - searchIcon.height / 2),
    ).toBeLessThan(2);
    await expect(map).toHaveAttribute('data-map-instance', instance!);
    expect(await map.boundingBox()).toEqual(mapBefore);
    expect(await panel.boundingBox()).toEqual(panelBefore);
    if (width >= 1280) {
      const drawer = (await history.boundingBox())!;
      expect(drawer.x + drawer.width).toBeLessThanOrEqual(panelBefore!.x + 1);
    }
    await page.screenshot({ path: test.info().outputPath(`chat-history-${width}.png`) });
    await history.getByRole('button', { name: '关闭历史会话', exact: true }).click();
    await expect(history).not.toBeVisible();
  });
}

test('会话搜索、空结果、切换及新建使用真实会话状态', async ({ page }) => {
  const calls = await fixture(page);
  const panel = await openChat(page);
  const composer = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await composer.fill('尚未提交的草稿');
  let history = await openHistory(page);
  await expect(history.getByRole('button', { name: '打开会话：区域研判助手' })).toHaveAttribute(
    'aria-current',
    'true',
  );
  await history.getByRole('button', { name: '打开会话：区域研判助手' }).click();
  await expect(history).not.toBeVisible();
  await expect(composer).toHaveValue('尚未提交的草稿');
  history = await openHistory(page);
  const search = history.getByPlaceholder('搜索会话...');
  await search.fill('船舶');
  await expect(history.getByRole('button', { name: '打开会话：目标船舶分析' })).toBeVisible();
  await expect(history.getByRole('button', { name: '打开会话：区域研判助手' })).toHaveCount(0);
  await search.fill('没有匹配的会话');
  await expect(history.getByText('没有匹配的会话', { exact: true })).toBeVisible();
  await search.fill('');
  await history.getByRole('button', { name: '打开会话：目标船舶分析' }).click();
  await expect(history).not.toBeVisible();
  await expect(panel.getByTestId('agent-current-session')).toHaveAttribute(
    'data-session-id',
    'history-b',
  );
  await expect(panel.getByText('目标船舶分析的历史回答', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  expect(calls.reads).toContain('history-b');
  expect(calls.writes).toBe(0);
  await composer.fill('新建前的草稿');
  history = await openHistory(page);
  await history.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(history).not.toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(panel.getByTestId('agent-chat-message')).toHaveCount(0);
  await expect(panel.getByLabel('你可以这样问我')).toBeVisible();
  expect(calls.writes).toBe(0);
});

test('Escape 恢复按钮焦点，切换功能与收起面板关闭历史栏', async ({ page }) => {
  await fixture(page);
  const panel = await openChat(page);
  let history = await openHistory(page);
  await history.getByPlaceholder('搜索会话...').focus();
  await page.keyboard.press('Escape');
  await expect(history).not.toBeVisible();
  await expect(panel.getByRole('button', { name: '历史会话', exact: true })).toBeFocused();
  history = await openHistory(page);
  await panel.getByRole('tab', { name: /^主动推送/ }).click();
  await expect(history).not.toBeVisible();
  await panel.getByRole('tab', { name: 'AI 对话', exact: true }).click();
  history = await openHistory(page);
  await panel.getByRole('button', { name: '关闭协同面板', exact: true }).click();
  await expect(history).not.toBeVisible();
});

test('历史消息区分角色方向并显示接口保存的真实时间', async ({ page }) => {
  await fixture(page);
  const panel = await openChat(page);
  const user = panel
    .getByTestId('agent-chat-message')
    .filter({ has: page.locator('time[datetime="2026-10-17T11:24:01Z"]') });
  const assistant = panel
    .getByTestId('agent-chat-message')
    .filter({ has: page.locator('time[datetime="2026-10-17T11:24:08Z"]') });
  await expect(user).toHaveAttribute('data-role', 'user');
  await expect(assistant).toHaveAttribute('data-role', 'assistant');
  await expect(user.locator('time')).toBeVisible();
  await expect(assistant.locator('time')).toBeVisible();
  const userContent = (await user.locator('.agent-message-text').boundingBox())!;
  const assistantContent = (await assistant.locator('.agent-message-text').boundingBox())!;
  expect(userContent.x).toBeGreaterThan(assistantContent.x);
  await panel.screenshot({ path: test.info().outputPath('chat-message-style.png') });
});

test('复制助手回复写入剪贴板并提供成功状态', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await fixture(page);
  const panel = await openChat(page);
  const assistant = panel.locator('[data-testid="agent-chat-message"][data-role="assistant"]');
  await assistant.getByRole('button', { name: '复制回复', exact: true }).click();
  await expect(assistant.getByRole('button', { name: '已复制回复', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('查询到港口公告[I1]');
});

test('空会话展示引导而不伪造历史，快捷提问只填草稿', async ({ page }) => {
  const calls = await fixture(page, { empty: true, saved: false });
  const panel = await openChat(page);
  await expect(panel.getByTestId('agent-chat-message')).toHaveCount(0);
  const suggestions = panel.getByLabel('你可以这样问我');
  await expect(suggestions).toBeVisible();
  const suggestion = suggestions.getByRole('button').first();
  const text = (await suggestion.innerText()).trim();
  await suggestion.click();
  const composer = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await expect(composer).toHaveValue(text);
  await expect(composer).toBeFocused();
  expect(calls.writes).toBe(0);
  const history = await openHistory(page);
  await expect(history.getByRole('button', { name: /^打开会话：/ })).toHaveCount(0);
});

test('任务详情与引用来源和历史栏互斥，不会重叠覆盖', async ({ page }) => {
  await fixture(page);
  const panel = await openChat(page);
  await panel.getByRole('button', { name: /查询港口公告详情/ }).click();
  const task = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('region', { name: '智能体任务详情' }) });
  await expect(task).toBeVisible();
  let history = await openHistory(page);
  await expect(task).not.toBeVisible();
  await history.getByRole('button', { name: '关闭历史会话', exact: true }).click();
  const citation = panel.getByRole('button', { name: '查看情报来源 [I1]', exact: true });
  await citation.click();
  const source = page.getByRole('dialog', { name: '查看情报引用', exact: true });
  await expect(source).toBeVisible();
  await expect(source).toContainText('历史会话引用：港口公告原文');
  history = await openHistory(page);
  await expect(source).not.toBeVisible();
  await expect(history).toBeVisible();
});
