import { expect, test, type Locator, type Page } from '@playwright/test';
import type { FeatureCollection } from 'geojson';
import type { GeoJSONSource, Map as ChartMap } from 'maplibre-gl';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
import { chartPoint, chartResult } from './fixtures/chart-data';
import { chartFixture } from './fixtures/chart-fixture';
import { captureChartMap } from './fixtures/chart-map';

type ChartWindow = typeof globalThis & { __effectsMap: ChartMap };
const selection = (page: Page) => page.getByTestId('chart-map-selection');
const effects = (page: Page) => page.getByTestId('chart-map-effects');
const vesselKey = `vessel:${chartPoint.mmsi}`;
const vesselDetail = (page: Page) =>
  page.getByTestId('chart-detail-float').filter({ has: page.locator('.vessel-detail') });
const selectionPath = (page: Page) => selection(page).locator('path[stroke-width="2"]');

async function svgGeometryBox(locator: Locator) {
  return locator.evaluate((element) => {
    const shape = element as SVGGraphicsElement;
    // SVG geometry excludes painted stroke and the selection's drop shadows.
    // Transform every corner so comparisons stay in the same CSS screen space as MapLibre.
    const box = shape.getBBox();
    const transform = shape.getScreenCTM();
    if (!transform) throw new Error('SVG几何缺少屏幕变换');
    const points = [
      [box.x, box.y],
      [box.x + box.width, box.y],
      [box.x, box.y + box.height],
      [box.x + box.width, box.y + box.height],
    ].map(([x, y]) => new DOMPoint(x, y).matrixTransform(transform));
    const x = Math.min(...points.map((point) => point.x));
    const y = Math.min(...points.map((point) => point.y));
    return {
      x,
      y,
      width: Math.max(...points.map((point) => point.x)) - x,
      height: Math.max(...points.map((point) => point.y)) - y,
    };
  });
}

async function ready(page: Page) {
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
}
async function observeAttention(page: Page) {
  return effects(page).evaluateHandle((root) => {
    const stages = new Set<string>();
    const observer = new MutationObserver(() => {
      for (const glyph of root.querySelectorAll<SVGGElement>('[data-testid="chart-map-emphasis"]'))
        stages.add(`${glyph.dataset.phase}:${glyph.dataset.icon}`);
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['data-phase', 'data-icon'],
    });
    return { stages, stop: () => observer.disconnect() };
  });
}
async function selectSearchVessel(page: Page) {
  await page.goto('/?q=夹具船舶&searchRevision=1');
  await ready(page);
  await openLeftPanel(page);
  await page.getByTestId('vessel-result').first().click();
  await expect(vesselDetail(page)).toContainText(chartPoint.mmsi);
  await expect(effects(page)).toHaveAttribute('data-selected-key', vesselKey);
  await vesselDetail(page).getByRole('button', { name: '定位', exact: true }).click();
}
async function projected(page: Page) {
  return page.evaluate((point) => {
    const map = (globalThis as ChartWindow).__effectsMap;
    const p = map.project([point.lon, point.lat]);
    const canvas = map.getCanvas().getBoundingClientRect();
    return { x: p.x + canvas.x, y: p.y + canvas.y, moving: map.isMoving() };
  }, chartPoint);
}
async function highlightLayers(page: Page) {
  return page.evaluate(async () => {
    const map = (globalThis as ChartWindow).__effectsMap;
    const source = map.getSource('vessel-highlights') as GeoJSONSource;
    const data = (await source.getData()) as FeatureCollection;
    return {
      mmsis: data.features.map((f) => f.properties?.mmsi),
      layers: map
        .getStyle()
        .layers.filter((layer) => 'source' in layer && layer.source === 'vessel-highlights'),
    };
  });
}

test('搜索和地图点选共用四角单选框，投影跟随，关闭详情保留而空白与Escape取消', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chartFixture(page);
  await selectSearchVessel(page);
  await captureChartMap(page, '__effectsMap');
  await expect.poll(async () => (await projected(page)).moving).toBe(false);
  await vesselDetail(page).getByRole('button', { name: '高亮', exact: true }).click();
  await vesselDetail(page).getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(vesselDetail(page)).toBeHidden();
  await expect(selection(page)).toHaveCount(1);
  const box = await svgGeometryBox(selectionPath(page));
  expect(box.width).toBeCloseTo(44, 4);
  expect(box.height).toBeCloseTo(44, 4);
  await expect(selectionPath(page)).toHaveCSS('stroke', 'rgb(255, 216, 77)');
  await expect(selection(page)).toHaveAttribute('data-object-key', vesselKey);
  await page.evaluate(() =>
    (globalThis as ChartWindow).__effectsMap.panBy([70, 30], { duration: 0 }),
  );
  await expect
    .poll(async () => {
      const target = await projected(page);
      const frame = await svgGeometryBox(selectionPath(page));
      return Math.hypot(
        frame.x + frame.width / 2 - target.x,
        frame.y + frame.height / 2 - target.y,
      );
    })
    .toBeLessThan(1);
  await page.screenshot({ path: testInfo.outputPath('selection-highlight-dark.png') });
  await page.keyboard.press('Escape');
  await expect(selection(page)).toHaveCount(0);
  await expect.poll(async () => (await highlightLayers(page)).mmsis).toEqual([chartPoint.mmsi]);
  const target = await projected(page);
  await page.mouse.click(target.x, target.y);
  await expect(selection(page)).toHaveAttribute('data-object-key', vesselKey);
  await vesselDetail(page).getByRole('button', { name: '关闭详情', exact: true }).click();
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  await page.mouse.click(canvas!.x + canvas!.width * 0.7, canvas!.y + canvas!.height * 0.72);
  await expect(selection(page)).toHaveCount(0);
  await expect.poll(async () => (await highlightLayers(page)).mmsis).toEqual([chartPoint.mmsi]);
});

test('独立高亮使用带柔光的黄色glyph，普通强调收缩闪烁后停止且刷新与换样式不重播', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await chartFixture(page);
  await selectSearchVessel(page);
  await captureChartMap(page, '__effectsMap');
  await expect.poll(async () => (await projected(page)).moving).toBe(false);
  await expect(page.getByTestId('chart-map-emphasis')).toHaveCount(0);
  const emphasis = page.getByTestId('chart-map-emphasis');
  // Observe before the click: software WebGL can delay the next test command until
  // the complete 1360ms animation has already finished. The handle stays test-owned.
  const attention = await observeAttention(page);
  await vesselDetail(page).getByRole('button', { name: '高亮', exact: true }).click();
  await expect
    .poll(() => attention.evaluate(({ stages }) => [...stages]))
    .toEqual(expect.arrayContaining(['contract:vessel', 'blink:vessel']));
  await attention.evaluate(({ stop }) => stop());
  await attention.dispose();
  // An extinguished 120ms beat also has no SVG glyph. Observe beyond the full
  // lifecycle before checking settlement; exact beat boundaries are unit tested.
  await page.waitForTimeout(1500);
  await expect(emphasis).toHaveCount(0);
  const rendered = await highlightLayers(page);
  expect(rendered.mmsis).toEqual([chartPoint.mmsi]);
  expect(rendered.layers.map(({ id, type }) => ({ id, type }))).toEqual([
    { id: 'vessel-highlight-marker', type: 'symbol' },
  ]);
  expect(rendered.layers.some((layer) => layer.type === 'circle')).toBe(false);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(emphasis).toHaveCount(0);
  await page.getByRole('button', { name: '浅色海图', exact: true }).click();
  await expect.poll(async () => (await highlightLayers(page)).mmsis).toEqual([chartPoint.mmsi]);
  await expect(emphasis).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('highlight-light.png') });
  await expect(effects(page)).toBeVisible();
});

test('业务线面SVG支持Enter单选，四角围住可见几何并保留8px留白', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chartFixture(page);
  const event = {
    id: '00000000-0000-4000-8000-000000000777',
    revision: 1,
    title: '键盘选择事件',
    summary: '海图选择验证',
    category: 'security',
    severity: 'unknown',
    occurredAt: null,
    geometry: {
      type: 'LineString',
      coordinates: [
        [121.9, 31.9],
        [122.1, 32.1],
      ],
    },
    linkedMmsis: [],
    linkedRouteIds: [],
    status: 'active',
    primarySourceKey: null,
    sourceSuggestions: {},
    overrides: {},
    mergedInto: null,
    createdAt: chartPoint.observedAt,
    updatedAt: chartPoint.observedAt,
  };
  await page.route('**/api/v1/routes**', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/operational-events**', (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith(event.id)
        ? event
        : { items: [event], total: 1 },
    }),
  );
  await page.goto('/');
  await ready(page);
  await selectLeftTab(page, '海洋态势');
  const situation = page.getByTestId('maritime-situation-panel');
  await situation.getByRole('button', { name: '添加航线或事件', exact: true }).click();
  await situation.getByLabel('添加关注业务对象').selectOption(`event:${event.id}`);
  await captureChartMap(page, '__effectsMap');
  await expect.poll(async () => (await projected(page)).moving).toBe(false);
  const shape = page
    .locator('.business-objects')
    .getByRole('button', { name: event.title, exact: true });
  await shape.focus();
  await shape.press('Enter');
  await expect(selection(page)).toHaveAttribute('data-object-key', `event:${event.id}:1`);
  await expect(selection(page)).toHaveCount(1);
  await expect.poll(async () => (await projected(page)).moving).toBe(false);
  const geometry = await svgGeometryBox(shape.locator('polyline'));
  const frame = await svgGeometryBox(selectionPath(page));
  expect(frame.x).toBeCloseTo(geometry.x - 8, 3);
  expect(frame.y).toBeCloseTo(geometry.y - 8, 3);
  expect(frame.width).toBeCloseTo(geometry.width + 16, 3);
  expect(frame.height).toBeCloseTo(geometry.height + 16, 3);
  await page.screenshot({ path: testInfo.outputPath('selection-business-line.png') });
});

test('结论证据入口使用统一单选，放大模态优先处理Escape', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chartFixture(page);
  await page.goto('/');
  await ready(page);
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await page
    .getByTestId('fusion-events')
    .getByRole('button', { name: chartResult.title, exact: true })
    .click();
  await expect(page.getByRole('region', { name: '结论证据' })).toContainText('测试夹具原文');
  await expect(selection(page)).toHaveCount(1);
  const key = await effects(page).getAttribute('data-selected-key');
  expect(key).toBe(`result:${chartResult.id}:${chartResult.revision}`);
  await page.getByRole('button', { name: '放大阅读证据' }).click();
  await expect(page.locator('dialog:modal')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await expect(effects(page)).toHaveAttribute('data-selected-key', key!);
  await page.screenshot({ path: testInfo.outputPath('selection-evidence.png') });
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 390, height: 620 },
]) {
  test(`减少动态效果${viewport.width}静态选择与高亮在深浅色海图可辨`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await chartFixture(page);
    await selectSearchVessel(page);
    if (viewport.width === 390) {
      await expect(effects(page)).toHaveAttribute('data-selected-key', vesselKey);
      await expect(selection(page)).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath('effects-detail-occlusion-390.png') });
    }
    const attention = await observeAttention(page);
    await vesselDetail(page).getByRole('button', { name: '高亮', exact: true }).click();
    await vesselDetail(page).getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
    await expect(selection(page)).toHaveAttribute('data-object-key', vesselKey);
    await expect(selection(page)).toBeInViewport();
    await expect(page.getByTestId('chart-map-emphasis')).toHaveCount(0);
    expect(
      await attention.evaluate(({ stages }) =>
        [...stages].some((stage) => /^(contract|blink):/.test(stage)),
      ),
    ).toBe(false);
    await attention.evaluate(({ stop }) => stop());
    await attention.dispose();
    await page.screenshot({ path: testInfo.outputPath(`effects-dark-${viewport.width}.png`) });
    await page.getByRole('button', { name: '浅色海图', exact: true }).click();
    await expect(selection(page)).toHaveAttribute('data-object-key', vesselKey);
    await page.screenshot({ path: testInfo.outputPath(`effects-light-${viewport.width}.png`) });
  });
}
