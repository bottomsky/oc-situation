import { test, expect, type Page } from '@playwright/test';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
import { chartFixture } from './fixtures/chart-fixture';
import { captureChartMap } from './fixtures/chart-map';
const event = {
  id: 'event-a',
  sourceId: 'manual',
  externalId: 'n-1',
  title: '港口临时管制',
  summary: '暂停靠泊',
  category: 'port-restriction',
  version: 1,
  status: 'active',
  reviewStatus: 'confirmed',
  publishedAt: '2026-10-11T08:00:00Z',
  effectiveFrom: '2026-10-11T08:00:00Z',
  effectiveTo: null,
  mmsis: [],
  vesselTypes: [],
  paragraphs: [{ id: 'p1', text: '港口暂停靠泊，待进一步公告。' }],
  raw: {},
  archiveKey: 'a',
  checksum: 'sum',
  recordedAt: '2026-10-11T08:00:00Z',
  originalArchiveId: 'a'.repeat(64),
};
async function intelligenceFixture(page: Page, overrides: Partial<typeof event> = {}) {
  const record = { ...event, ...overrides };
  const detailRequests: string[] = [];
  const chart = await chartFixture(page);
  let set = { eventIds: [] as string[], hiddenEventIds: [] as string[] };
  const writes: unknown[] = [];
  const queries: URL[] = [];
  await page.route('**/api/v1/intelligence/**', async (route) => {
    const url = new URL(route.request().url());
    let json: unknown = {};
    const path = url.pathname;
    const body = route.request().method() === 'GET' ? {} : route.request().postDataJSON();
    if (path.endsWith('/plot-set')) {
      if (route.request().method() === 'PUT') set = body;
      json = set;
    } else if (path.endsWith('/plot'))
      json = {
        type: 'FeatureCollection',
        features: body.eventIds.map((id: string) => ({
          type: 'Feature',
          id: 'r-' + id,
          geometry: { type: 'Point', coordinates: [122, 31] },
          properties: {
            eventId: id,
            relationId: 'r-' + id,
            kind: 'occurs-at',
            reviewStatus: 'confirmed',
            origin: 'manual',
            basis: '原文位置',
            observedAt: record.publishedAt,
            status: 'active',
            title: id === 'event-a' ? record.title : '港口气象公告',
          },
        })),
        items: body.eventIds.map((id: string) => ({
          eventId: id,
          title: id === 'event-a' ? record.title : '港口气象公告',
          featureCount: 1,
        })),
      };
    else if (path.endsWith('/sources'))
      json = [{ sourceId: 'manual', name: '手工来源', kind: 'manual', enabled: true }];
    else if (path.endsWith('/objects'))
      json = {
        items: [
          {
            id: 'port-a',
            kind: 'port',
            name: '测试港口',
            aliases: [],
            geometry: { type: 'Point', coordinates: [122, 31] },
            metadata: {},
            updatedAt: record.publishedAt,
          },
        ],
      };
    else if (path.endsWith('/archives')) json = { items: [], nextCursor: null };
    else if (path.endsWith('/events')) {
      if (route.request().method() === 'GET') queries.push(url);
      if (route.request().method() === 'POST') {
        writes.push(body);
        json = { ...record, ...body };
      } else
        json = {
          items: [
            url.searchParams.has('cursor')
              ? { ...record, id: 'event-b', title: '港口气象公告' }
              : record,
          ],
          nextCursor: url.searchParams.has('cursor') ? null : 'next',
        };
    } else if (path.endsWith('/relations')) {
      writes.push(body);
      json = { id: 'new-relation' };
    } else if (path.includes('/events/')) {
      detailRequests.push(path);
      json = {
        event: {
          ...record,
          id: path.split('/').at(-1),
          title: path.endsWith('event-b') ? '港口气象公告' : record.title,
        },
        relations: [
          {
            id: 'relation-a',
            eventId: 'event-a',
            revision: 1,
            kind: 'occurs-at',
            objectId: 'port-a',
            basis: '原文 p1 明确测试港口地点，保留审核及来源依据。',
            paragraphIds: ['p1'],
            reviewStatus: 'confirmed',
            origin: 'manual',
            recordedAt: record.publishedAt,
          },
        ],
        history: [{ action: 'created', recordedAt: record.publishedAt, version: 1 }],
      };
    }
    await route.fulfill({ json });
  });
  return { writes, queries, chart, detailRequests, getSet: () => set };
}
const longCardTitle = '港口临时管制公告：跨海航道施工及船舶交通组织调整与气象海况联合提醒'.repeat(
  3,
);
for (const width of [240, 300, 440])
  test(`情报卡片在 ${width}px 面板内包含左上勾选和右下定位，长文本自然换行`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await intelligenceFixture(page, {
      title: longCardTitle,
      summary: 'NAVIGATION_NOTICE_'.repeat(18) + ' 请按公告要求绕行并持续关注港口最新通知。',
      sourceId: 'maritime_source_'.repeat(9),
    });
    await page.goto('/');
    await openLeftPanel(page);
    await selectLeftTab(page, '情报标绘');
    const resize = page.getByRole('separator', { name: '调整操作面板宽度' });
    await resize.press('Home');
    for (let step = 0; step < Math.abs(width - 300) / 10; step++)
      await resize.press(width < 300 ? 'ArrowLeft' : 'ArrowRight');
    await expect(resize).toHaveAttribute('aria-valuenow', String(width));
    const panel = page.getByTestId('chart-left-panel');
    await expect.poll(async () => Math.round((await panel.boundingBox())!.width)).toBe(width);
    const card = panel.locator('.intelligence-row').first();
    await card.scrollIntoViewIfNeeded();
    const checkbox = card.getByRole('checkbox', { name: `勾选 ${longCardTitle}`, exact: true });
    const locate = card.getByRole('button', { name: `定位 ${longCardTitle}`, exact: true });
    await expect(locate).toHaveText('⌖ 定位');
    const bounds = (await card.boundingBox())!;
    const checkBounds = (await checkbox.boundingBox())!;
    const locateBounds = (await locate.boundingBox())!;
    const titleBounds = (await card.locator('strong').boundingBox())!;
    expect(checkBounds.x - bounds.x).toBeGreaterThanOrEqual(8);
    expect(checkBounds.y - bounds.y).toBeGreaterThanOrEqual(8);
    expect(checkBounds.y - bounds.y).toBeLessThanOrEqual(20);
    expect(titleBounds.x).toBeGreaterThanOrEqual(checkBounds.x + checkBounds.width + 8);
    expect(locateBounds.x + locateBounds.width).toBeLessThanOrEqual(bounds.x + bounds.width - 8);
    expect(locateBounds.y).toBeGreaterThan(titleBounds.y + titleBounds.height + 8);
    expect(bounds.y + bounds.height - locateBounds.y - locateBounds.height).toBeGreaterThanOrEqual(
      8,
    );
    expect(bounds.y + bounds.height - locateBounds.y - locateBounds.height).toBeLessThanOrEqual(16);
    const layout = await card.evaluate((element) => ({
      width: element.clientWidth,
      scrollWidth: element.scrollWidth,
      nestedControls: element.querySelectorAll('button button, button input').length,
      overflowingText: [...element.querySelectorAll('strong, span, small')].some(
        (text) => text.scrollWidth > text.clientWidth + 1,
      ),
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.overflowingText).toBe(false);
    expect(layout.nestedControls).toBe(0);
    await card.screenshot({ path: `.data/intelligence-card-browser-results/card-${width}.png` });
  });

test('情报卡片的勾选、详情与定位独立操作，激活详情保持卡片尺寸', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const fixture = await intelligenceFixture(page);
  await page.goto('/');
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  await page.getByRole('button', { name: '加载更多情报' }).click();
  const card = page.locator('.intelligence-row').first();
  const secondCard = page.locator('.intelligence-row').nth(1);
  const checkbox = card.getByRole('checkbox', { name: `勾选 ${event.title}`, exact: true });
  await checkbox.focus();
  await checkbox.press('Space');
  await expect(checkbox).toBeChecked();
  expect(fixture.detailRequests).toEqual([]);
  expect(fixture.getSet().eventIds).toEqual([]);
  await expect(card).not.toHaveClass(/selected/);
  const originalBounds = (await card.boundingBox())!;
  const originalTitleBounds = (await card.locator('strong').boundingBox())!;
  const detail = card.getByRole('button').filter({ has: page.locator('strong') });
  await detail.click();
  await expect(page.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
  await expect(card).toHaveClass(/selected/);
  await expect(checkbox).toBeChecked();
  expect(fixture.detailRequests).toHaveLength(1);
  const activeBounds = (await card.boundingBox())!;
  expect(activeBounds.width).toBe(originalBounds.width);
  expect(activeBounds.height).toBe(originalBounds.height);
  expect((await card.locator('strong').boundingBox())!.x).toBe(originalTitleBounds.x);
  await secondCard.getByRole('button', { name: '定位 港口气象公告', exact: true }).click();
  await expect.poll(() => fixture.getSet().eventIds).toEqual(['event-a', 'event-b']);
  expect(fixture.detailRequests).toHaveLength(1);
  await expect(page.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
  await expect(secondCard.getByRole('checkbox')).not.toBeChecked();
  await expect(secondCard).not.toHaveClass(/selected/);
  await checkbox.uncheck();
  await expect(card).toHaveClass(/selected/);
});

test('情报跨页勾选与标绘持久化，筛选保留集合，单海图绘制取消', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const fixture = await intelligenceFixture(page);
  await page.route('**/api/v1/intelligence/events/event-a', (route) =>
    route.fulfill({
      json: {
        event: {
          ...event,
          paragraphs: Array.from({ length: 12 }, (_, i) => ({
            id: 'p' + (i + 1),
            text: '较长情报原文段落 ' + (i + 1) + '：港口管制与通航范围需要在右侧独立滚动审阅。',
          })),
        },
        relations: [],
        history: [],
      },
    }),
  );
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  await page.getByRole('checkbox', { name: '勾选 港口临时管制' }).check();
  await page.getByRole('button', { name: '加载更多情报' }).click();
  await page.getByRole('checkbox', { name: '勾选 港口气象公告' }).check();
  await page.getByRole('button', { name: '批量加入' }).click();
  await expect.poll(() => fixture.getSet().eventIds.length).toBe(2);
  await page.getByRole('button', { name: '设置情报筛选' }).click();
  await page.getByRole('button', { name: '气象海况', exact: true }).click();
  await page.getByRole('textbox', { name: '情报关键词' }).fill('管制');
  await page
    .getByRole('dialog', { name: '情报筛选条件设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect(page.getByText('当前标绘集合')).toBeVisible();
  await expect.poll(() => fixture.queries.at(-1)?.searchParams.get('category')).toBe('weather');
  await page.getByRole('button', { name: '批量移除' }).click();
  await expect.poll(() => fixture.getSet().eventIds.length).toBe(0);
  const previousZoom = Number(fixture.chart.mapQueries.at(-1)?.searchParams.get('zoom'));
  await page.getByRole('button', { name: '定位 港口临时管制', exact: true }).click();
  await expect.poll(() => fixture.getSet().eventIds).toEqual(['event-a']);
  await expect
    .poll(() => Number(fixture.chart.mapQueries.at(-1)?.searchParams.get('zoom')))
    .toBeGreaterThan(previousZoom);
  await page
    .getByRole('button', { name: /港口临时管制/ })
    .filter({ has: page.locator('strong') })
    .last()
    .click();
  await expect(page.getByRole('heading', { name: '港口临时管制' })).toBeVisible();
  const detail = page.getByRole('region', { name: '情报详情', exact: true });
  await detail.getByRole('button', { name: '绘制点', exact: true }).click();
  const documentBounds = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    height: window.innerHeight,
    scrollY: window.scrollY,
  }));
  expect(documentBounds.scrollHeight).toBeLessThanOrEqual(documentBounds.height);
  expect(documentBounds.scrollY).toBe(0);
  const box = (await map.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(documentBounds.height);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(detail.getByRole('textbox', { name: 'GeoJSON 几何' })).toHaveValue(/Point/);
  await detail.getByRole('button', { name: '取消绘制', exact: true }).click();
  await expect(detail.getByRole('textbox', { name: 'GeoJSON 几何' })).toHaveValue('');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  expect(errors).toEqual([]);
});
test('筛选摘要与独立设置支持取消、应用、移除和重置', async ({ page }) => {
  const fixture = await intelligenceFixture(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  const summary = page.getByRole('region', { name: '筛选条件', exact: true });
  await expect(summary).toContainText('无');
  await expect(page.getByLabel('情报关键词', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: '设置情报筛选' }).click();
  const dialog = page.getByRole('dialog', { name: '情报筛选条件设置' });
  await dialog.getByLabel('情报关键词', { exact: true }).fill('港口');
  await dialog.getByRole('button', { name: '气象海况', exact: true }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(summary).toContainText('无');
  expect(fixture.queries.at(-1)?.searchParams.has('keyword')).toBe(false);
  await page.getByRole('button', { name: '设置情报筛选' }).click();
  await expect(dialog.getByLabel('情报关键词', { exact: true })).toHaveValue('');
  await dialog.getByLabel('情报关键词', { exact: true }).fill('港口');
  await dialog.getByRole('button', { name: '气象海况', exact: true }).click();
  await dialog.getByRole('button', { name: '时间范围', exact: true }).click();
  await dialog.getByRole('button', { name: '近7天', exact: true }).click();
  await dialog.getByRole('button', { name: '地理与对象', exact: true }).click();
  await dialog.getByLabel('关联对象', { exact: true }).selectOption('port-a');
  await dialog.getByLabel('仅当前海图视野', { exact: true }).check();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(summary).toContainText('关键词：港口');
  await expect(summary).toContainText('对象：测试港口');
  await expect.poll(() => fixture.queries.at(-1)?.searchParams.get('category')).toBe('weather');
  expect(fixture.queries.at(-1)?.searchParams.get('from')).toMatch(/Z$/);
  expect(fixture.queries.at(-1)?.searchParams.has('bbox')).toBe(true);
  await summary.getByRole('button', { name: '移除类别：气象海况', exact: true }).click();
  await expect.poll(() => fixture.queries.at(-1)?.searchParams.has('category')).toBe(false);
  await page.getByRole('button', { name: '设置情报筛选' }).click();
  await dialog.getByRole('button', { name: '重置', exact: true }).click();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(summary).toContainText('无');
  await expect.poll(() => fixture.queries.at(-1)?.searchParams.has('objectId')).toBe(false);
  expect(fixture.queries.at(-1)?.searchParams.has('bbox')).toBe(false);

  await page.getByRole('button', { name: '设置情报图层' }).click();
  const layers = page.getByRole('dialog', { name: '情报图层设置' });
  await layers.getByLabel('发生位置', { exact: true }).uncheck();
  await layers.getByRole('button', { name: '取消', exact: true }).click();
  const layerSummary = page.getByRole('region', { name: '当前图层', exact: true });
  await expect(layerSummary).toContainText('发生位置');
  await page.getByRole('button', { name: '设置情报图层' }).click();
  await layers.getByLabel('发生位置', { exact: true }).uncheck();
  await layers.getByRole('button', { name: '应用', exact: true }).click();
  await expect(layerSummary).not.toContainText('发生位置');
  await page.screenshot({ path: '.data/filter-browser-results/compact-panel.png', fullPage: true });
  await page.getByRole('button', { name: '设置情报筛选' }).click();
  await page.screenshot({
    path: '.data/filter-browser-results/filter-settings.png',
    fullPage: true,
  });
  await page.setViewportSize({ width: 520, height: 700 });
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(520);
  await expect(dialog.getByRole('button', { name: '应用', exact: true })).toBeInViewport();
});

test('工作台表单创建原文与关联，查看完整证据', async ({ page }) => {
  const fixture = await intelligenceFixture(page);
  await page.goto('/intelligence');
  await page.getByRole('textbox', { name: '情报标题', exact: true }).fill('航道施工通告');
  await page
    .getByRole('combobox', { name: '情报录入类别', exact: true })
    .selectOption({ label: '气象海况' });
  await page.getByLabel('情报录入来源', { exact: true }).selectOption('manual');
  await page.getByRole('textbox', { name: '原始公告编号' }).fill('notice-2');
  await page.getByRole('textbox', { name: '摘要', exact: true }).fill('施工影响通航');
  await page
    .getByRole('textbox', { name: '原文（空行分隔段落）' })
    .fill('施工区域临时封闭。\n\n请绕行。');
  await page.getByRole('button', { name: '归档情报', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  expect((fixture.writes[0] as { paragraphs: unknown[] }).paragraphs).toHaveLength(2);
  expect((fixture.writes[0] as { category: string }).category).toBe('weather');
  await page
    .getByRole('button', { name: /港口临时管制/ })
    .filter({ has: page.locator('strong') })
    .last()
    .click();
  await expect(page.getByText('港口暂停靠泊，待进一步公告。', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '绘制点', exact: true })).toHaveCount(0);
  await page.getByLabel('目录对象').selectOption('port-a');
  await page.getByRole('textbox', { name: '认定依据' }).fill('依据公告明确涉及测试港口');
  await page.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect.poll(() => fixture.writes.length).toBe(2);
  expect((fixture.writes[1] as { objectId: string }).objectId).toBe('port-a');
});

test('切换情报后迟到的归档原文不会污染新详情', async ({ page }) => {
  await intelligenceFixture(page);
  let release: () => void = () => {};
  let requested = false;
  await page.route('**/api/v1/intelligence/archives/*', async (route) => {
    requested = true;
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({ json: { content: 'A 公告专属原文，不能混入 B' } });
  });
  await page.goto('/intelligence');
  await page
    .getByRole('button', { name: /港口临时管制/ })
    .filter({ has: page.locator('strong') })
    .last()
    .click();
  await page.getByText('完整原始数据与归档校验', { exact: true }).click();
  await page.getByRole('button', { name: '读取采集归档原文' }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('button', { name: '加载更多情报' }).click();
  await page
    .getByRole('button', { name: /港口气象公告/ })
    .filter({ has: page.locator('strong') })
    .last()
    .click();
  await expect(page.getByRole('heading', { name: '港口气象公告', exact: true })).toBeVisible();
  const delayedResponse = page.waitForResponse((response) =>
    response.url().includes('/intelligence/archives/'),
  );
  release();
  await (await delayedResponse).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.getByText('A 公告专属原文，不能混入 B', { exact: true })).toHaveCount(0);
});

test('人工确认有效时间的来源观测公告允许审核', async ({ page }) => {
  await intelligenceFixture(page);
  await page.route('**/api/v1/intelligence/events/event-a', (route) =>
    route.fulfill({
      json: {
        event: { ...event, raw: { requiresOccurrenceTimeReview: true, manualTimeConfirmed: true } },
        relations: [],
        history: [],
      },
    }),
  );
  await page.goto('/intelligence');
  await page
    .getByRole('button', { name: /港口临时管制/ })
    .filter({ has: page.locator('strong') })
    .last()
    .click();
  await expect(page.getByRole('button', { name: '确认公告', exact: true })).toBeEnabled();
  await expect(
    page.getByText(
      '实际有效 / 发生时间待确认；当前时间为来源观测时间。完成修订并填写实际有效期后审核。',
    ),
  ).toHaveCount(0);
});

test('已存点几何加载海图后可拖动并提交候选修订，保留同一地图', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const fixture = await intelligenceFixture(page);
  let relation = {
    id: 'edit-point',
    eventId: 'event-a',
    revision: 1,
    recordedAt: event.publishedAt,
    kind: 'occurs-at',
    geometry: { type: 'Point', coordinates: [123, 34] },
    basis: '来源提供的发生位置',
    paragraphIds: ['p1'],
    reviewStatus: 'confirmed',
    origin: 'source',
  };
  await page.route('**/api/v1/intelligence/events/event-a', (route) =>
    route.fulfill({ json: { event, relations: [relation], history: [] } }),
  );
  await page.route('**/api/v1/intelligence/relations/edit-point', async (route) => {
    const body = route.request().postDataJSON();
    fixture.writes.push(body);
    relation = { ...relation, ...body, revision: relation.revision + 1 };
    await route.fulfill({ json: relation });
  });
  await page.goto('/?eventId=event-a');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  await captureChartMap(page, '__intelligenceGeometryMap');
  const viewport = page.waitForRequest(
    (request) =>
      new URL(request.url()).pathname === '/api/v1/map/points' &&
      Number(new URL(request.url()).searchParams.get('zoom')) > 10,
  );
  await page.getByRole('button', { name: '修订关系', exact: true }).click();
  await viewport;
  const geometry = page.getByRole('textbox', { name: 'GeoJSON 几何', exact: true });
  await expect(geometry).toHaveValue(/Point/);
  const before = await geometry.inputValue();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const map = (
          globalThis as typeof globalThis & {
            __intelligenceGeometryMap: import('maplibre-gl').Map;
          }
        ).__intelligenceGeometryMap;
        return (
          !map.isMoving() &&
          map.getZoom() > 10 &&
          !!map.getLayer('td-point') &&
          map
            .queryRenderedFeatures(map.project([123, 34]), { layers: ['td-point'] })
            .some(
              (feature) => feature.geometry.type === 'Point' && feature.properties.mode === 'point',
            )
        );
      }),
    )
    .toBe(true);
  const vertex = await page.evaluate(() => {
    const map = (
      globalThis as typeof globalThis & {
        __intelligenceGeometryMap: import('maplibre-gl').Map;
      }
    ).__intelligenceGeometryMap;
    const point = map.project([123, 34]);
    const canvas = map.getCanvas().getBoundingClientRect();
    return { x: canvas.x + point.x, y: canvas.y + point.y };
  });
  await page.mouse.move(vertex.x, vertex.y);
  await page.mouse.down();
  await page.mouse.move(vertex.x + 60, vertex.y + 30, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(() => geometry.inputValue()).not.toBe(before);
  await page.getByRole('button', { name: '保存关系修订', exact: true }).click();
  await expect.poll(() => relation.revision).toBe(2);
  expect(relation.geometry.coordinates).not.toEqual([123, 34]);
  expect(relation.reviewStatus).toBe('candidate');
  expect(relation.origin).toBe('manual');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
});
for (const mode of ['LineString', 'Polygon'] as const)
  test('海图' + mode + '绘制完成、顶点编辑与取消保留同一地图', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await intelligenceFixture(page);
    await page.goto('/?eventId=event-a');
    const map = page.getByTestId('sea-map');
    await expect(map).toHaveAttribute('data-ready', 'true');
    const instance = await map.getAttribute('data-map-instance');
    const detail = page.getByRole('region', { name: '情报详情', exact: true });
    await detail
      .getByRole('button', { name: mode === 'LineString' ? '绘制线' : '绘制面', exact: true })
      .click();
    const box = (await map.boundingBox())!;
    const p1 = { x: box.x + box.width / 2 - 80, y: box.y + box.height / 2 - 40 };
    const p2 = { x: p1.x + 160, y: p1.y };
    const p3 = { x: p1.x + 80, y: p1.y + 100 };
    await page.mouse.click(p1.x, p1.y);
    await page.mouse.click(p2.x, p2.y);
    if (mode === 'LineString') await page.mouse.dblclick(p3.x, p3.y);
    else {
      await page.mouse.click(p3.x, p3.y);
      await page.mouse.click(p1.x, p1.y);
    }
    const geometry = detail.getByRole('textbox', { name: 'GeoJSON 几何', exact: true });
    await expect(geometry).toHaveValue(new RegExp(mode));
    const before = await geometry.inputValue();
    await detail.getByRole('button', { name: '编辑绘制', exact: true }).click();
    await page.mouse.move(p1.x, p1.y);
    await page.mouse.down();
    await page.mouse.move(p1.x - 30, p1.y - 20, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => geometry.inputValue()).not.toBe(before);
    expect(JSON.parse(await geometry.inputValue()).type).toBe(mode);
    await detail.getByRole('button', { name: '取消绘制', exact: true }).click();
    await expect(geometry).toHaveValue('');
    await expect(map).toHaveAttribute('data-map-instance', instance!);
  });
test('只读角色可查阅已存几何，隐藏绘制和关系写入', async ({ page }) => {
  await intelligenceFixture(page);
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'viewer', username: '只读测试', role: 'viewer' },
        csrfToken: 'viewer-csrf',
        expiresAt: '2099-01-01',
      },
    }),
  );
  await page.goto('/?eventId=event-a');
  await expect(page.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '绘制点', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '修订关系', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '保存关联', exact: true })).toHaveCount(0);
});
