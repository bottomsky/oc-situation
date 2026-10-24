import { test, expect, type Page } from '@playwright/test';
import type { AgentFocusResult } from '@ais/contracts';
import { agentFixture } from './fixtures/agent-workbench-fixture';
import { chartPoint, chartResult } from './fixtures/chart-data';
import { captureChartMap } from './fixtures/chart-map';

const sourceTask = '00000000-0000-4000-8000-000000000111';
function focusObjects(
  many = false,
): Pick<AgentFocusResult, 'targets' | 'missing' | 'bbox' | 'displayStatus' | 'omittedCount'> {
  return {
    targets: [
      {
        ref: { kind: 'vessel', id: chartPoint.mmsi, revision: 2 },
        label: '船甲',
        geometry: { type: 'Point', coordinates: [122, 32] },
        observedAt: chartPoint.observedAt,
        source: 'fixture-ais',
      },
      {
        ref: { kind: 'intelligence', id: 'fixture-intelligence', revision: 2 },
        label: '航警甲',
        geometry: { type: 'Point', coordinates: [123, 32] },
        observedAt: chartPoint.observedAt,
      },
      {
        ref: { kind: 'track', id: chartPoint.mmsi, revision: 1, sourceTaskId: sourceTask },
        label: '旧航迹',
        geometry: {
          type: 'LineString',
          coordinates: [
            [122, 32],
            [123, 33],
          ],
        },
        observedAt: chartPoint.observedAt,
      },
      ...(many
        ? Array.from({ length: 53 }, (_, i) => ({
            ref: { kind: 'region' as const, id: `region-${i}`, revision: 1 },
            label: `区域 ${i}`,
            geometry: {
              type: 'Point' as const,
              coordinates: [122 + i * 0.001, 32.1] as [number, number],
            },
          }))
        : []),
    ],
    missing: [{ kind: 'vessel', id: '413000099' }],
    bbox: [122, 32, 123, 33],
    displayStatus: 'partial',
    omittedCount: 7,
  };
}
async function fixture(page: Page, many = false, focus = focusObjects(many), submit = true) {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/intelligence/plot-set') && request.method() !== 'GET')
      writes.push(request.method());
  });
  await page.route('https://**/*', (route) => route.abort());
  const agent = await agentFixture(page, {
    focus,
    chatReplies: { 查看关联对象: '已整理本轮对象。', 下一轮: '新一轮对象。' },
  });
  await page.route('**/api/v1/intelligence/events/fixture-intelligence', (route) =>
    route.fulfill({
      json: {
        event: {
          ...chartResult.evidence.documents[0],
          id: 'fixture-intelligence',
          category: 'navigation-warning',
          title: '航警甲当前详情',
          version: 3,
          status: 'active',
          reviewStatus: 'confirmed',
          summary: '详情为当前资料，回复保持引用二版。',
          relations: [],
        },
        relations: [],
        history: [],
      },
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  const input = page.getByRole('textbox', { name: '分析问题或继续追问' });
  if (submit) {
    await input.fill('查看关联对象');
    await input.press('Enter');
    await expect(page.getByTestId('chart-agent-current-reply')).toContainText('已整理本轮对象');
  }
  return { ...agent, writes, input };
}
const panel = (page: Page) => page.getByTestId('reply-objects-panel');
const more = (page: Page) => page.getByRole('button', { name: /查看更多关联对象，已关联/ });
const detail = (page: Page) => page.getByTestId('chart-detail-float').filter({ visible: true });

test('单船右侧构图与内容更新保持一次相机预算，定位采用新AIS呈现', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const focus = focusObjects();
  focus.targets = focus.targets.slice(0, 1);
  focus.missing = [];
  focus.omittedCount = 0;
  focus.displayStatus = 'complete';
  focus.bbox = [122, 32, 122, 32];
  await fixture(page, false, focus);
  await captureChartMap(page, '__replyObjectMap');
  const camera = () =>
    page.evaluate(() => {
      const map = (globalThis as unknown as { __replyObjectMap: import('maplibre-gl').Map })
        .__replyObjectMap;
      return { center: map.getCenter().toArray(), zoom: map.getZoom(), moving: map.isMoving() };
    });
  await expect.poll(async () => (await camera()).moving).toBe(false);
  const overlay = page.getByTestId('chart-focus-overlay');
  await expect(overlay.locator('.focus-reply-position')).toHaveAttribute('data-placement', 'right');
  await expect
    .poll(() =>
      overlay.evaluate((element) => {
        const shape = element.querySelector('.focus-shapes')!.getBoundingClientRect();
        const card = element.querySelector('.focus-reply-position')!.getBoundingClientRect();
        return card.left - shape.right;
      }),
    )
    .toBeGreaterThanOrEqual(23);
  const before = await camera();
  await page.screenshot({ path: test.info().outputPath('reply-single-right-initial.png') });
  const liveAt = '2026-10-02T00:30:00Z';
  await page.route('**/api/v1/map/points?**', (route) =>
    route.fulfill({
      json: {
        snapshotId: 'live-new',
        sequence: 1,
        items: [{ ...chartPoint, lon: 125, lat: 34, observedAt: liveAt }],
        total: 1,
        complete: true,
        nextCursor: null,
        generatedAt: liveAt,
        expiresAt: '2099-01-01T00:00:00Z',
      },
    }),
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(overlay.locator('.focus-details')).toContainText(liveAt);
  expect(await camera()).toEqual(before);
  await more(page).click();
  await panel(page).getByRole('button', { name: '定位船甲', exact: true }).click();
  await expect.poll(async () => (await camera()).center).not.toEqual(before.center);
  await expect(panel(page)).toContainText('2026');
  await page.screenshot({ path: test.info().outputPath('reply-single-right.png') });
});

test('分散对象预估低缩放后使用顶部卡片，低高度保持正文滚动', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 620 });
  const focus = focusObjects();
  focus.targets = [
    {
      ref: { kind: 'region', id: 'west' },
      label: '西侧区域',
      geometry: { type: 'Point', coordinates: [-100, 15] },
    },
    {
      ref: { kind: 'region', id: 'east' },
      label: '东侧区域',
      geometry: { type: 'Point', coordinates: [100, 45] },
    },
  ];
  focus.bbox = [100, 15, -100, 45];
  focus.missing = [];
  focus.omittedCount = 0;
  focus.displayStatus = 'complete';
  await fixture(page, false, focus);
  const overlay = page.getByTestId('chart-focus-overlay');
  await expect(overlay.locator('.focus-reply-position')).toHaveAttribute('data-placement', 'top');
  await expect
    .poll(() =>
      overlay.evaluate((element) => {
        const card = element.querySelector('.focus-reply-position')!.getBoundingClientRect();
        const map = element.getBoundingClientRect();
        return {
          top: card.top - map.top,
          within: card.bottom <= map.bottom,
          guideCount: element.querySelectorAll('.focus-guide,.focus-frame').length,
        };
      }),
    )
    .toMatchObject({ within: true, guideCount: 0 });
  expect(
    await page
      .getByTestId('chart-agent-current-reply')
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(360);
  await page.screenshot({ path: test.info().outputPath('reply-dispersed-top-low.png') });
});

test('全屏保留回复对象抽屉和左详情的可见层级', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await fixture(page);
  await page.getByRole('button', { name: '海图全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await more(page).click();
  await panel(page).getByRole('button', { name: '查看情报详情：航警甲' }).click();
  await expect(detail(page)).toContainText('航警甲当前详情');
  expect(
    await panel(page).evaluate((element) => document.fullscreenElement?.contains(element)),
  ).toBe(true);
  expect(
    await detail(page).evaluate((element) => document.fullscreenElement?.contains(element)),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath('reply-objects-fullscreen.png') });
});

test('回复名称读取详情不写标绘不移动镜头；左右共存并逐层Esc恢复焦点', async ({ page }) => {
  const calls = await fixture(page);
  await captureChartMap(page, '__replyObjectMap');
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          !(
            globalThis as unknown as { __replyObjectMap: import('maplibre-gl').Map }
          ).__replyObjectMap.isMoving(),
      ),
    )
    .toBe(true);
  const camera = () =>
    page.evaluate(() => {
      const map = (globalThis as unknown as { __replyObjectMap: import('maplibre-gl').Map })
        .__replyObjectMap;
      return { center: map.getCenter().toArray(), zoom: map.getZoom() };
    });
  const before = await camera();
  await more(page).click();
  const name = panel(page).getByRole('button', { name: '查看情报详情：航警甲', exact: true });
  await name.click();
  await expect(detail(page)).toContainText('航警甲当前详情');
  await expect(detail(page).getByTestId('reply-object-snapshot')).toContainText('版本 2');
  await expect(detail(page).getByTestId('reply-object-snapshot')).toContainText('3 版');
  await expect(panel(page)).toBeVisible();
  expect(calls.writes).toEqual([]);
  expect(await camera()).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(detail(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(name).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(panel(page)).not.toBeVisible();
  await expect(more(page)).toBeFocused();
  await expect(page.getByTestId('chart-agent-current-reply')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('chart-agent-current-reply')).toHaveCount(0);
  await expect(calls.input).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('reply-objects-esc.png') });
});

test('对象抽屉搜索类型分页与未定位状态，其他类型查看固定版本快照', async ({ page }) => {
  await fixture(page, true);
  await more(page).click();
  await expect(panel(page).locator('.reply-object-row')).toHaveCount(50);
  await expect(panel(page)).toContainText('另有 7 项超出本次快照范围');
  await panel(page).getByRole('button', { name: '关联对象下一页' }).click();
  await expect(panel(page).locator('.reply-object-row')).toHaveCount(7);
  const missing = panel(page).locator('.reply-object-row').filter({ hasText: '413000099' });
  await expect(missing).toContainText('未定位');
  await expect(missing.getByRole('button', { name: /定位/ })).toBeDisabled();
  await panel(page).getByRole('combobox', { name: '筛选回复对象类型' }).selectOption('track');
  await expect(panel(page).locator('.reply-object-row')).toHaveCount(1);
  await panel(page).getByRole('button', { name: '查看航迹详情：旧航迹' }).click();
  await expect(panel(page).getByLabel('关联对象快照概要')).toContainText('引用版本 1');
  await expect(panel(page)).toContainText(sourceTask);
  await expect(detail(page)).toHaveCount(0);
  await panel(page).getByRole('searchbox', { name: '搜索回复关联对象' }).fill('不存在');
  await expect(panel(page)).toContainText('没有符合搜索和类型条件');
  await page.screenshot({ path: test.info().outputPath('reply-objects-filter.png') });
});

test('详情权限或删除错误留在局部并可重试，回复与对象列表持续可读', async ({ page }) => {
  const calls = await fixture(page);
  let failed = true;
  await page.route('**/api/v1/vessels/' + chartPoint.mmsi, (route) =>
    failed
      ? route.fulfill({ status: 403, json: { message: '此船详情无权访问' } })
      : route.fulfill({
          json: {
            mmsi: chartPoint.mmsi,
            staticFields: { name: '船甲新资料' },
            latestPosition: chartPoint,
            provenance: {},
          },
        }),
  );
  await more(page).click();
  await panel(page).getByRole('button', { name: '查看船舶详情：船甲' }).click();
  await expect(detail(page).getByRole('alert')).toContainText('当前账号没有此操作权限');
  await expect(panel(page)).toBeVisible();
  await expect(page.getByTestId('chart-agent-current-reply')).toBeVisible();
  failed = false;
  await detail(page).getByRole('button', { name: '重新加载' }).click();
  await expect(detail(page)).toContainText('船甲新资料');
  expect(calls.writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('reply-objects-with-detail.png') });
});

test('新任务关闭对象状态并隔离旧任务迟到详情', async ({ page }) => {
  const calls = await fixture(page);
  let release: () => void = () => {};
  await page.route('**/api/v1/vessels/' + chartPoint.mmsi, async (route) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.fulfill({
      json: {
        mmsi: chartPoint.mmsi,
        staticFields: { name: '迟到旧资料' },
        latestPosition: chartPoint,
        provenance: {},
      },
    });
  });
  await more(page).click();
  await panel(page).getByRole('button', { name: '查看船舶详情：船甲' }).click();
  await expect(detail(page)).toContainText('正在读取');
  await calls.input.fill('下一轮');
  await calls.input.press('Enter');
  await expect(page.getByTestId('chart-agent-current-reply')).toContainText('新一轮对象');
  release();
  await expect(panel(page)).not.toBeVisible();
  await expect(detail(page)).toHaveCount(0);
  await expect(page.getByText('迟到旧资料', { exact: true })).toHaveCount(0);
});

test('回复情报历史读取403可见并重试同一历史id，引用快照继续保留', async ({ page }) => {
  const calls = await fixture(page);
  const event = {
    ...chartResult.evidence.documents[0],
    category: 'navigation-warning',
    status: 'active',
    reviewStatus: 'confirmed',
    summary: '历史读取夹具',
    relations: [],
  };
  await page.route('**/api/v1/intelligence/events/fixture-intelligence', (route) =>
    route.fulfill({
      json: {
        event: { ...event, id: 'fixture-intelligence', title: '航警当前三版', version: 3 },
        relations: [],
        history: [
          {
            kind: 'event-version',
            eventId: 'history-one',
            version: 1,
            recordedAt: chartPoint.observedAt,
          },
        ],
      },
    }),
  );
  const reads: string[] = [];
  let denied = true;
  await page.route('**/api/v1/intelligence/events/history-one', (route) => {
    reads.push(new URL(route.request().url()).pathname);
    return denied
      ? route.fulfill({ status: 403, json: { message: '历史版本无权访问' } })
      : route.fulfill({
          json: {
            event: { ...event, id: 'history-one', title: '历史第一版证据', version: 1 },
            relations: [],
            history: [],
          },
        });
  });
  await more(page).click();
  await panel(page).getByRole('button', { name: '查看情报详情：航警甲' }).click();
  await detail(page).getByRole('button', { name: '查看版本证据' }).click();
  await expect(detail(page).getByRole('alert')).toContainText('当前账号没有此操作权限');
  await expect(panel(page)).toBeVisible();
  denied = false;
  await detail(page).getByRole('button', { name: '重新加载' }).click();
  await expect(detail(page)).toContainText('历史第一版证据');
  await expect(detail(page).getByTestId('reply-object-snapshot')).toContainText('版本 2');
  expect(reads).toEqual([
    '/api/v1/intelligence/events/history-one',
    '/api/v1/intelligence/events/history-one',
  ]);
  expect(calls.writes).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('reply-history-retry.png') });
});

for (const size of [
  { width: 600, height: 800 },
  { width: 390, height: 620 },
])
  test(`窄屏${size.width}对象抽屉之上打开详情，Esc仅关闭最上层`, async ({ page }) => {
    await page.setViewportSize(size);
    await fixture(page);
    await more(page).click();
    await panel(page).getByRole('button', { name: '查看船舶详情：船甲' }).click();
    await expect(detail(page)).toContainText('夹具船舶');
    const visible = await detail(page).evaluate((element) => {
      const close = element.querySelector('.chart-detail-close')!;
      const rect = close.getBoundingClientRect();
      return close.contains(
        document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
      );
    });
    expect(visible).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`reply-objects-narrow-${size.width}.png`),
    });
    await page.keyboard.press('Escape');
    await expect(detail(page)).toHaveCount(0);
    await expect(panel(page)).toBeVisible();
  });

test('单对象靠近顶部时窄屏卡片预留后自动适配，目标与顶部回复不重叠', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 800 });
  const focus = focusObjects();
  focus.targets = focus.targets.slice(0, 1);
  focus.missing = [];
  focus.omittedCount = 0;
  focus.displayStatus = 'complete';
  const calls = await fixture(page, false, focus, false);
  const close = page.getByRole('button', { name: '关闭协同面板', exact: true });
  if (await close.isVisible()) await close.click();
  await captureChartMap(page, '__replyObjectMap');
  const coordinate = await page.evaluate(() => {
    const map = (globalThis as unknown as { __replyObjectMap: import('maplibre-gl').Map })
      .__replyObjectMap;
    return map.unproject([map.getCanvas().clientWidth / 2, 30]).toArray();
  });
  focus.targets[0]!.geometry = { type: 'Point', coordinates: coordinate as [number, number] };
  focus.bbox = [coordinate[0]!, coordinate[1]!, coordinate[0]!, coordinate[1]!];
  await calls.input.fill('查看关联对象');
  await calls.input.press('Enter');
  await expect(page.getByTestId('chart-agent-current-reply')).toContainText('已整理本轮对象');
  const overlay = page.getByTestId('chart-focus-overlay');
  await expect(overlay.locator('.focus-reply-position')).toHaveAttribute('data-placement', 'top');
  await expect
    .poll(() =>
      overlay.evaluate((element) => {
        const shape = element.querySelector('.focus-shapes')!.getBoundingClientRect();
        const card = element.querySelector('.focus-reply-position')!.getBoundingClientRect();
        return (
          shape.top >= card.bottom + 23 ||
          shape.bottom <= card.top - 23 ||
          shape.left >= card.right + 23 ||
          shape.right <= card.left - 23
        );
      }),
    )
    .toBe(true);
  await page.screenshot({ path: test.info().outputPath('reply-single-narrow-top.png') });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 568 },
])
  test(`长名称${viewport.width}在hover和键盘聚焦时完整显示且低高footer可点`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const longName = '东海联合观测计划中的完整业务对象名称与来源版本需要全部可读'.repeat(6);
    const focus = focusObjects();
    const index = viewport.width < 768 ? 0 : 2;
    focus.targets[index]!.label = longName;
    await fixture(page, false, focus);
    await captureChartMap(page, '__replyTooltipMap');
    const camera = () =>
      page.evaluate(() => {
        const map = (globalThis as unknown as { __replyTooltipMap: import('maplibre-gl').Map })
          .__replyTooltipMap;
        return { center: map.getCenter().toArray(), zoom: map.getZoom(), moving: map.isMoving() };
      });
    await expect.poll(async () => (await camera()).moving).toBe(false);
    const card = page.getByTestId('chart-agent-current-reply');
    const entry = card.locator('.reply-object-entry').filter({ hasText: longName });
    const name = entry.locator('.reply-object-name');
    const tooltip = page.getByRole('tooltip').filter({ hasText: longName });
    await name.hover();
    await expect(tooltip).toHaveCSS('opacity', '1');
    await expect(tooltip).toContainText(longName);
    const tooltipId = await tooltip.getAttribute('id');
    expect(tooltipId).toBeTruthy();
    await expect(name).toHaveAttribute('aria-describedby', tooltipId!);
    const ratio = () =>
      tooltip.evaluate(
        (element) =>
          new Promise<number>((resolve) => {
            const observer = new IntersectionObserver((entries) => {
              observer.disconnect();
              resolve(entries[0]!.intersectionRatio);
            });
            observer.observe(element);
          }),
      );
    expect(await ratio(), '完整名称提示应实际落在可见图区，包含CSS祖先裁切').toBeGreaterThanOrEqual(
      0.99,
    );
    await name.focus();
    await page.mouse.move(0, 0);
    await expect(tooltip).toHaveCSS('opacity', '1');
    expect(await ratio()).toBeGreaterThanOrEqual(0.99);
    const beforeKeyboard = await camera();
    await tooltip.focus();
    await expect(tooltip).toBeFocused();
    for (const key of ['Home', '+', '-']) await tooltip.press(key);
    await expect.poll(async () => (await camera()).moving).toBe(false);
    expect(await camera(), '聚焦可滚动名称提示时键盘保持海图相机').toEqual(beforeKeyboard);
    const footer = more(page);
    expect(
      await footer.evaluate((button) => {
        const rect = button.getBoundingClientRect();
        return button.contains(
          document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2),
        );
      }),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`reply-long-name-${viewport.width}.png`),
    });
  });
