import { expect, test, type Locator, type Page } from '@playwright/test';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
import { chartFixture } from './fixtures/chart-fixture';
import { chartResult } from './fixtures/chart-data';
import { captureChartMap } from './fixtures/chart-map';
import type { AgentIntelligenceResult } from '@ais/contracts';

const event = {
  id: 'popover-event',
  sourceId: 'manual',
  externalId: 'popover-notice',
  title: '左侧详情测试：港口临时管制',
  summary: '港区施工期间暂停靠泊，请遵守航行通告并关注后续通知。',
  category: 'port-restriction',
  version: 1,
  status: 'active',
  reviewStatus: 'confirmed',
  publishedAt: '2026-10-17T08:00:00Z',
  effectiveFrom: '2026-10-17T08:00:00Z',
  effectiveTo: null,
  mmsis: [],
  vesselTypes: [],
  paragraphs: Array.from({ length: 12 }, (_, index) => ({
    id: `p${index}`,
    text: `航道管制原文段落 ${index + 1}：船舶需在指定水域待命并遵守港口调度。`,
  })),
  raw: {},
  archiveKey: 'popover-archive',
  checksum: 'popover-checksum',
  recordedAt: '2026-10-17T08:00:00Z',
  originalArchiveId: 'b'.repeat(64),
};

async function fixture(page: Page) {
  const calls = await chartFixture(page);
  const detailReads: string[] = [];
  await page.route('**/api/v1/intelligence/events*', (route) =>
    route.fulfill({ json: { items: [event], nextCursor: null } }),
  );
  await page.route('**/api/v1/intelligence/events/popover-event', (route) => {
    detailReads.push(event.id);
    return route.fulfill({ json: { event, relations: [], history: [] } });
  });
  return { calls, detailReads };
}

async function agentFixture(page: Page) {
  await fixture(page);
  const createdAt = '2026-10-17T08:00:00Z';
  const session = {
    id: 'popover-session',
    ownerId: 'fixture-user',
    title: '浮层验证会话',
    createdAt,
  };
  const task = {
    id: 'popover-task',
    sessionId: session.id,
    ownerId: session.ownerId,
    goal: '查询港口公告详情',
    status: 'completed',
    bbox: null,
    historyHours: 24,
    from: createdAt,
    to: createdAt,
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
    summary: '查到港口公告[I1]',
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
  const intelligenceResult: AgentIntelligenceResult = {
    kind: 'intelligence_search',
    version: 1,
    inputRevision: 0,
    asOf: createdAt,
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
          id: event.id,
          sourceId: 'manual',
          sourceName: '公开海事公告',
          externalId: event.externalId,
          version: 1,
          title: '右侧来源引用：港口公告原文',
          summary: event.summary,
          snippet: event.paragraphs[0]!.text,
          category: 'notice',
          status: 'active',
          reviewStatus: 'confirmed',
          visibility: 'public',
          publishedAt: createdAt,
          observedAt: createdAt,
          collectedAt: createdAt,
          effectiveFrom: createdAt,
          effectiveTo: null,
          timeBasis: 'effective',
          originalUrl: 'https://example.com/notice',
          originalArchiveId: 'popover-archive',
          geometry: { type: 'Point', coordinates: [122, 32] },
          matchBasis: 'keyword',
          locationNote: '已登记位置',
        },
      },
    ],
  };
  const messages = [
    {
      id: 'popover-message',
      role: 'assistant',
      content: task.summary,
      sessionId: session.id,
      taskId: task.id,
      resultVersion: 1,
      inputRevision: 0,
      createdAt,
    },
  ];
  await page.addInitScript(() =>
    localStorage.setItem('ais-agent-session:fixture-user', 'popover-session'),
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/config')
      ? {
          enabled: true,
          defaultHistoryHours: 24,
          maxHistoryHours: 168,
          maxModelCalls: 12,
          maxToolCalls: 24,
        }
      : path.endsWith('/sessions')
        ? { items: [session] }
        : path.endsWith('/events')
          ? { items: [], nextCursor: '0' }
          : path.includes('/tasks/')
            ? { task, results: [], steps: [], intelligenceResult }
            : { session, messages, tasks: [task], pendingInputRequests: [] };
    await route.fulfill({ json });
  });
}

async function visibleInViewport(page: Page, locator: Locator) {
  await expect(locator).toBeVisible();
  await expect
    .poll(async () => {
      const bounds = await locator.boundingBox();
      const viewport = page.viewportSize()!;
      return (
        !!bounds &&
        bounds.x >= 0 &&
        bounds.y >= 0 &&
        bounds.x + bounds.width <= viewport.width + 1 &&
        bounds.y + bounds.height <= viewport.height + 1
      );
    })
    .toBe(true);
}

async function detailPresentation(
  page: Page,
  detail: Locator,
  title: string,
  fadeTo: 'left' | 'right' = 'right',
) {
  const heading = detail.getByRole('heading', { name: title, exact: true });
  await expect(heading).toHaveCount(1);
  await visibleInViewport(page, heading);
  const close = detail.getByRole('button', { name: '关闭详情', exact: true });
  await visibleInViewport(page, close);
  await expect(detail).toHaveAttribute('data-fade-to', fadeTo);
  await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await close.hover();
  await expect(close).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(close).toHaveCSS('border-width', '0px');
  const surface = await detail.evaluate((element) => {
    const style = getComputedStyle(element);
    const scroll = element.querySelector<HTMLElement>('.chart-detail-scroll')!;
    const scrollStyle = getComputedStyle(scroll);
    const colors = [...style.backgroundImage.matchAll(/rgba?\(([^)]+)\)/g)].map((match) =>
      match[1]!
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number),
    );
    return {
      radii: [
        style.borderTopLeftRadius,
        style.borderTopRightRadius,
        style.borderBottomLeftRadius,
        style.borderBottomRightRadius,
      ].map(parseFloat),
      shadow: style.boxShadow,
      leftBorder: parseFloat(style.borderLeftWidth),
      rightBorder: parseFloat(style.borderRightWidth),
      opacity: Number(style.opacity),
      contentOpacity: Number(getComputedStyle(scroll.firstElementChild!).opacity),
      scrollbar: scrollStyle.scrollbarWidth,
      webkitScrollbar: getComputedStyle(scroll, '::-webkit-scrollbar').display,
      overflowY: scrollStyle.overflowY,
      fadeWidth: parseFloat(style.getPropertyValue('--detail-fade-width')),
      angle: style.backgroundImage.match(/^linear-gradient\((90deg|270deg|to right|to left),/)?.[1],
      insetLeft: parseFloat(scrollStyle.paddingLeft),
      insetRight: parseFloat(scrollStyle.paddingRight),
      alphas: colors.map((color) => (color.length === 4 ? color[3]! : 1)),
    };
  });
  expect(surface.radii).toEqual([0, 0, 0, 0]);
  expect(surface.shadow).toBe('none');
  expect(surface.leftBorder).toBe(fadeTo === 'left' ? 0 : 1);
  expect(surface.rightBorder).toBe(fadeTo === 'left' ? 1 : 0);
  expect(surface.opacity).toBe(1);
  expect(surface.contentOpacity).toBe(1);
  expect(surface.scrollbar).toBe('none');
  expect(surface.webkitScrollbar).toBe('none');
  expect(surface.overflowY).toBe('auto');
  expect(surface.angle).toMatch(fadeTo === 'left' ? /^(270deg|to left)$/ : /^(90deg|to right)$/);
  const safeInset = fadeTo === 'left' ? surface.insetLeft : surface.insetRight;
  expect(safeInset).toBe(60);
  expect(surface.fadeWidth).toBeGreaterThan(safeInset * 2);
  expect(surface.alphas.length).toBeGreaterThanOrEqual(5);
  expect(surface.alphas[0]).toBeLessThan(0.9);
  expect(surface.alphas[0]).toBeGreaterThan(surface.alphas.at(-1)!);
  expect(surface.alphas.at(-1)).toBeLessThanOrEqual(0.05);
  await expect
    .poll(() =>
      detail
        .locator('.chart-detail-scroll')
        .evaluate((element) => element.scrollWidth - element.clientWidth),
    )
    .toBeLessThanOrEqual(1);
}

async function openManualDetail(page: Page) {
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  const card = page.getByTestId('chart-left-panel').locator('.intelligence-row').first();
  await card
    .getByRole('button')
    .filter({ has: page.locator('strong') })
    .click();
  const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
  await expect(detail).toHaveAttribute('data-side', 'left');
  await expect(detail.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
  return { card, detail };
}

async function openPushDetail(page: Page) {
  const panel = page.getByTestId('chart-right-panel');
  if (!(await panel.isVisible())) {
    const toolbar = page.getByRole('button', { name: '智能协同', exact: true });
    if (await toolbar.isVisible()) await toolbar.click();
    else await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
  }
  await panel.getByRole('tab', { name: /^主动推送/ }).click();
  const card = panel.getByTestId('fusion-events').getByRole('button', {
    name: chartResult.title,
    exact: true,
  });
  await card.click();
  const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
  await expect(detail).toHaveAttribute('data-side', 'right');
  await expect(detail.getByRole('region', { name: '结论证据' })).toBeVisible();
  return { panel, card, detail };
}

for (const width of [1920, 1280, 390]) {
  test(`${width}px 人工情报详情独立悬浮、源列表保留且关闭后地图不重建`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests = await fixture(page);
    await page.goto('/');
    const map = page.getByTestId('sea-map');
    await expect(map).toHaveAttribute('data-ready', 'true');
    const instance = await map.getAttribute('data-map-instance');
    const { card, detail } = await openManualDetail(page);
    const quoteBackground = await detail
      .locator('blockquote')
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    const channels = quoteBackground.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    expect(channels).toHaveLength(3);
    expect(Math.max(...channels)).toBeLessThan(100);
    await visibleInViewport(page, detail);
    await detailPresentation(page, detail, '情报证据');
    await expect(page.getByTestId('chart-left-panel')).toBeVisible();
    await expect(card).toBeVisible();
    expect(
      await page.getByTestId('chart-left-panel').getByTestId('chart-detail-float').count(),
    ).toBe(0);
    await expect(map).toHaveAttribute('data-map-instance', instance!);
    await page.screenshot({ path: test.info().outputPath(`manual-detail-${width}.png`) });
    if (width === 1920) {
      await page.getByRole('button', { name: '浅色海图', exact: true }).click();
      await expect(page.getByRole('button', { name: '深色海图', exact: true })).toBeVisible();
      await detailPresentation(page, detail, '情报证据');
      await expect(map).toHaveAttribute('data-map-instance', instance!);
      await page.screenshot({ path: test.info().outputPath('manual-detail-1920-light.png') });
      await page.getByRole('button', { name: '深色海图', exact: true }).click();
      await expect(page.getByRole('button', { name: '浅色海图', exact: true })).toBeVisible();
      await detail
        .getByRole('textbox', { name: '认定依据', exact: true })
        .fill('尚未保存的港口关联认定草稿');
    }
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(page.getByTestId('chart-left-panel')).toBeVisible();
    await expect(card).toBeVisible();
    await expect(map).toHaveAttribute('data-map-instance', instance!);
    if (width === 1920) {
      await page
        .getByTestId('chart-left-panel')
        .getByRole('button', { name: '清空标绘', exact: true })
        .click();
      await expect(card).toContainText('未标绘');
      await openManualDetail(page);
      await expect(card).toContainText('已标绘');
      await expect(detail.getByRole('textbox', { name: '认定依据', exact: true })).toHaveValue(
        '尚未保存的港口关联认定草稿',
      );
      expect(requests.detailReads).toEqual([event.id]);
      await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
      await expect(map).toHaveAttribute('data-map-instance', instance!);
    }
  });

  test(`${width}px 主动推送证据浮于协同面板左侧，关闭保留推送列表`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await fixture(page);
    await page.goto('/');
    const map = page.getByTestId('sea-map');
    await expect(map).toHaveAttribute('data-ready', 'true');
    const instance = await map.getAttribute('data-map-instance');
    const { panel, card, detail } = await openPushDetail(page);
    await visibleInViewport(page, detail);
    await detailPresentation(page, detail, '结论证据', 'left');
    await expect(panel).toBeVisible();
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    expect(await panel.getByRole('region', { name: '结论证据' }).count()).toBe(0);
    if (width >= 1024) {
      const source = (await panel.boundingBox())!;
      const floating = (await detail.boundingBox())!;
      expect(floating.x + floating.width).toBeLessThanOrEqual(source.x + 1);
    }
    await page.screenshot({ path: test.info().outputPath(`push-detail-${width}.png`) });
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(panel).toBeVisible();
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await expect(map).toHaveAttribute('data-map-instance', instance!);
  });
}

test('船舶搜索详情在左侧独立浮层，切换情报仅保留一个浮层', async ({ page }) => {
  await fixture(page);
  await page.goto('/?q=夹具船舶&searchRevision=1');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await openLeftPanel(page);
  const source = page.getByTestId('vessel-result').first();
  await source.click();
  const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
  await expect(detail).toHaveAttribute('data-side', 'left');
  await expect(detail.locator('.vessel-detail')).toContainText('413000001');
  await detailPresentation(page, detail, '船舶详情');
  await expect(source).toBeVisible();
  await expect(page.getByTestId('chart-left-panel').locator('.vessel-detail')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('vessel-detail.png') });
  await openManualDetail(page);
  await expect(detail).toHaveCount(1);
  await expect(detail.locator('.vessel-detail')).toHaveCount(0);
});

test('隐藏滚动条的详情支持滚轮与键盘滚动，标题和地图保持稳定', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await fixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  await captureChartMap(page, '__detailScrollingMap');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !(
            globalThis as typeof globalThis & { __detailScrollingMap: import('maplibre-gl').Map }
          ).__detailScrollingMap.isMoving(),
      ),
    )
    .toBe(true);
  const camera = () =>
    page.evaluate(() => {
      const map = (
        globalThis as typeof globalThis & { __detailScrollingMap: import('maplibre-gl').Map }
      ).__detailScrollingMap;
      return { center: map.getCenter().toArray(), zoom: map.getZoom() };
    });
  const { detail } = await openManualDetail(page);
  const before = await camera();
  const scroll = detail.locator('.chart-detail-scroll');
  await expect(scroll).toHaveCSS('scrollbar-width', 'none');
  await expect(scroll).toHaveAttribute('tabindex', '0');
  await scroll.hover();
  await page.mouse.wheel(0, 400);
  await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await scroll.focus();
  const afterWheel = await scroll.evaluate((element) => element.scrollTop);
  await scroll.press('PageDown');
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(afterWheel);
  await scroll.press('End');
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop),
    )
    .toBeLessThanOrEqual(1);
  await visibleInViewport(page, detail.getByRole('heading', { name: '情报证据', exact: true }));
  await visibleInViewport(page, detail.getByRole('button', { name: '关闭详情', exact: true }));
  expect(await camera()).toEqual(before);
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await page.screenshot({ path: test.info().outputPath('manual-detail-hidden-scrollbar.png') });
});

for (const width of [1920, 390]) {
  test(`${width}px Agent 任务详情及来源引用悬浮于右侧，协同会话保留`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await agentFixture(page);
    await page.goto('/');
    await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
    const panel = page.getByTestId('chart-right-panel');
    if (!(await panel.isVisible())) {
      const toggle = page.getByRole('button', { name: '智能协同', exact: true });
      if (await toggle.isVisible()) await toggle.click();
      else await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
    }
    await panel.getByRole('tab', { name: 'AI 对话', exact: true }).click();
    const taskTrigger = panel.getByRole('button', { name: /查询港口公告详情/ });
    await taskTrigger.click();
    const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
    await expect(detail).toHaveAttribute('data-side', 'right');
    await visibleInViewport(page, detail);
    await detailPresentation(page, detail, '智能体任务详情');
    await expect(detail.getByRole('region', { name: '智能体任务详情' })).toBeVisible();
    await expect(panel.getByRole('region', { name: '智能体任务详情' })).toHaveCount(0);
    await detail.getByRole('button', { name: /\[I1\].*右侧来源引用/ }).click();
    await expect(detail).toHaveAttribute('data-detail-kind', 'sources');
    await detailPresentation(page, detail, '情报引用');
    await expect(detail).toContainText('右侧来源引用：港口公告原文');
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(taskTrigger).toBeFocused();
    const citation = panel.getByRole('button', { name: '查看情报来源 [I1]', exact: true });
    await citation.click();
    await expect(detail).toHaveAttribute('data-side', 'right');
    await visibleInViewport(page, detail);
    await expect(detail).toContainText('右侧来源引用：港口公告原文');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('agent-current-session')).toHaveAttribute(
      'data-session-id',
      'popover-session',
    );
    await page.screenshot({ path: test.info().outputPath(`agent-source-${width}.png`) });
    await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
    await expect(citation).toBeFocused();
  });
}

test('浮层随面板调整宽度跟随，Escape 关闭并恢复来源按钮焦点', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  const { detail } = await openManualDetail(page);
  const resize = page.getByRole('separator', { name: '调整操作面板宽度', exact: true });
  const before = (await detail.boundingBox())!;
  await resize.press('ArrowRight');
  await resize.press('ArrowRight');
  await expect
    .poll(async () => Math.round((await detail.boundingBox())!.x))
    .toBe(Math.round(before.x + 20));
  await detail.getByRole('button', { name: '关闭详情', exact: true }).focus();
  await page.keyboard.press('Escape');
  await expect(detail).toHaveCount(0);
  await expect(page.getByTestId('chart-left-panel')).toBeVisible();
  await expect(
    page
      .getByTestId('chart-left-panel')
      .locator('.intelligence-row')
      .first()
      .getByRole('button')
      .filter({ has: page.locator('strong') }),
  ).toBeFocused();
  const push = await openPushDetail(page);
  const rightResize = page.getByRole('separator', { name: '调整协同面板宽度', exact: true });
  const rightBefore = (await push.detail.boundingBox())!;
  await rightResize.press('ArrowRight');
  await expect
    .poll(async () => Math.round((await push.detail.boundingBox())!.x))
    .not.toBe(Math.round(rightBefore.x));
  await visibleInViewport(page, push.detail);
});

test('已打开详情进入和退出海图全屏后保留草稿、可见层级及地图实例', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  const { detail } = await openManualDetail(page);
  const draft = detail.getByRole('textbox', { name: '认定依据', exact: true });
  await draft.fill('全屏切换期间保留的关系草稿');
  await page.getByRole('button', { name: '海图全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect
    .poll(() => detail.evaluate((element) => !!document.fullscreenElement?.contains(element)))
    .toBe(true);
  await visibleInViewport(page, detail);
  await detailPresentation(page, detail, '情报证据');
  await expect(draft).toHaveValue('全屏切换期间保留的关系草稿');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await page.screenshot({ path: test.info().outputPath('manual-detail-fullscreen.png') });
  await page.getByRole('button', { name: '退出海图全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await visibleInViewport(page, detail);
  await expect(draft).toHaveValue('全屏切换期间保留的关系草稿');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(detail).toHaveCount(0);
});
