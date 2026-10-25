import { expect, test, type Page } from '@playwright/test';
import type { GeoJSONSource, Map as ChartMap } from 'maplibre-gl';
import type { FeatureCollection } from 'geojson';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
import { chartPoint } from './fixtures/chart-data';
import { chartFixture } from './fixtures/chart-fixture';
import { captureChartMap } from './fixtures/chart-map';

type ChartWindow = typeof globalThis & { __vesselActionsMap: ChartMap };

async function openVessel(page: Page) {
  await page.goto('/?q=夹具船舶&searchRevision=1');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await openLeftPanel(page);
  await page.getByTestId('vessel-result').first().click();
  const detail = page
    .getByTestId('chart-detail-float')
    .filter({ has: page.locator('.vessel-detail') });
  await expect(detail).toContainText(chartPoint.mmsi);
  return detail;
}

async function camera(page: Page) {
  return page.evaluate(() => {
    const map = (globalThis as ChartWindow).__vesselActionsMap;
    return { center: map.getCenter().toArray(), zoom: map.getZoom(), moving: map.isMoving() };
  });
}

async function highlightedMmsis(page: Page) {
  return page.evaluate(async () => {
    const source = (globalThis as ChartWindow).__vesselActionsMap.getSource(
      'vessel-highlights',
    ) as GeoJSONSource;
    const data = (await source.getData()) as FeatureCollection;
    if (data.type !== 'FeatureCollection') throw new Error('船舶高亮数据应为要素集合');
    return data.features.map((feature) => feature.properties?.mmsi as string);
  });
}

test('详情定位使用当前船位，保持详情和历史轨迹入口', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chartFixture(page);
  const detail = await openVessel(page);
  await captureChartMap(page, '__vesselActionsMap');
  await expect.poll(async () => (await camera(page)).moving).toBe(false);
  const before = await camera(page);
  await detail.getByRole('button', { name: '定位', exact: true }).click();
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(before.zoom);
  await expect.poll(async () => (await camera(page)).moving).toBe(false);
  const after = await camera(page);
  expect(after.zoom).toBe(10);
  const placement = await page.evaluate((point) => {
    const map = (globalThis as ChartWindow).__vesselActionsMap;
    const projected = map.project([point.lon, point.lat]);
    const padding = map.getPadding();
    const canvas = map.getCanvas();
    return {
      projected: { x: projected.x, y: projected.y },
      visibleCenter: {
        x: (canvas.clientWidth + (padding.left ?? 0) - (padding.right ?? 0)) / 2,
        y: (canvas.clientHeight + (padding.top ?? 0) - (padding.bottom ?? 0)) / 2,
      },
    };
  }, chartPoint);
  expect(placement.projected.x).toBeCloseTo(placement.visibleCenter.x, 0);
  expect(placement.projected.y).toBeCloseTo(placement.visibleCenter.y, 0);
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: /查询历史轨迹/ })).toBeVisible();
});

test('详情高亮独立于普通船位图层，关闭重开保留状态，清除全部同步按钮', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await chartFixture(page, { clusters: true });
  await page.route('**/api/v1/vessels/positions?*', (route) =>
    route.fulfill({ json: { items: [chartPoint], missing: [] } }),
  );
  const detail = await openVessel(page);
  await captureChartMap(page, '__vesselActionsMap');
  await expect.poll(async () => (await camera(page)).moving).toBe(false);
  const before = await camera(page);
  const highlight = detail.getByRole('button', { name: '高亮', exact: true });
  await highlight.click();
  await expect(detail.getByRole('button', { name: '取消高亮', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => highlightedMmsis(page)).toEqual([chartPoint.mmsi]);
  const after = await camera(page);
  expect(after).toEqual(before);
  await expect(page.getByTestId('vessel-highlights-control')).toContainText('船舶高亮 · 1 艘');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (globalThis as ChartWindow).__vesselActionsMap
          .queryRenderedFeatures({ layers: ['vessel-highlight-marker'] })
          .map((feature) => feature.properties?.mmsi),
      ),
    )
    .toContain(chartPoint.mmsi);
  await page.screenshot({ path: test.info().outputPath('vessel-detail-actions.png') });

  await detail.getByRole('button', { name: '取消高亮', exact: true }).click();
  await expect.poll(() => highlightedMmsis(page)).toEqual([]);
  expect(await camera(page)).toEqual(before);
  await highlight.click();
  await expect.poll(() => highlightedMmsis(page)).toEqual([chartPoint.mmsi]);
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(detail).toBeHidden();
  await expect(detail).toHaveAttribute('aria-hidden', 'true');
  await expect(detail).toHaveAttribute('inert', '');
  await page.getByTestId('vessel-result').first().click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '取消高亮', exact: true })).toBeVisible();
  await detail.getByRole('button', { name: '关闭详情', exact: true }).click();
  await expect(detail).toBeHidden();
  const control = page.getByTestId('vessel-highlights-control');
  await control.locator('summary').click();
  await control.getByTestId('vessel-highlights-clear-all').click();
  await expect.poll(() => highlightedMmsis(page)).toEqual([]);
  await page.getByTestId('vessel-result').first().click();
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('button', { name: '高亮', exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('详情航迹预测提交当前MMSI，运行中切船不会抢占已有任务', async ({ page }) => {
  const posts: unknown[] = [];
  await chartFixture(page);
  await page.route('**/api/v1/vessels?*', (route) =>
    route.fulfill({
      json: {
        items: [chartPoint.mmsi, '413000002'].map((mmsi) => ({
          mmsi,
          staticFields: { name: mmsi === chartPoint.mmsi ? '夹具船舶' : '另一艘船' },
          latestPosition: { ...chartPoint, mmsi },
        })),
        nextCursor: null,
      },
    }),
  );
  await page.route('**/api/v1/topics/predictions*', async (route) => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ json: { items: [], instances: [] } });
    posts.push(route.request().postDataJSON());
    return route.fulfill({
      status: 202,
      json: { instanceId: 'detail-prediction', runId: 'detail-run' },
    });
  });
  await page.route('**/api/v1/topics/runs/detail-run', (route) =>
    route.fulfill({ json: { id: 'detail-run', status: 'queued' } }),
  );
  const detail = await openVessel(page);
  await detail.getByRole('button', { name: '航迹预测', exact: true }).click();
  const prediction = page.getByTestId('prediction-panel');
  await expect(prediction).toBeVisible();
  await expect(prediction.getByLabel('目标船舶 MMSI')).toHaveValue(chartPoint.mmsi);
  await expect.poll(() => posts).toEqual([{ mmsi: chartPoint.mmsi }]);
  await expect(prediction.getByRole('button', { name: '计算中…', exact: true })).toBeDisabled();

  await selectLeftTab(page, '船舶搜索');
  await page.route('**/api/v1/vessels/413000002', (route) =>
    route.fulfill({
      json: {
        mmsi: '413000002',
        staticFields: { name: '另一艘船' },
        latestPosition: { ...chartPoint, mmsi: '413000002' },
        provenance: {},
      },
    }),
  );
  await page.getByTestId('vessel-result').filter({ hasText: '413000002' }).click();
  await expect(detail).toContainText('413000002');
  await expect(detail.getByRole('button', { name: /航迹预测|预测中/ })).toBeDisabled();
  await expect.poll(() => posts.length).toBe(1);
  await selectLeftTab(page, '航行预测');
  await expect(prediction.getByLabel('目标船舶 MMSI')).toHaveValue(chartPoint.mmsi);
});

test('缺少船位时定位和高亮说明不可用，航迹预测仍可读取服务端观测', async ({ page }) => {
  await chartFixture(page);
  await page.route(`**/api/v1/vessels/${chartPoint.mmsi}`, (route) =>
    route.fulfill({
      json: {
        mmsi: chartPoint.mmsi,
        staticFields: { name: '暂无船位船舶' },
        latestPosition: null,
        provenance: {},
      },
    }),
  );
  const detail = await openVessel(page);
  await expect(detail.getByRole('button', { name: '定位', exact: true })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '高亮', exact: true })).toBeDisabled();
  await expect(detail.getByRole('button', { name: '航迹预测', exact: true })).toBeEnabled();
  await expect(detail).toContainText('暂无船位');
});

test('详情发起的预测失败在原预测面板可见并可重试', async ({ page }) => {
  let submits = 0;
  await chartFixture(page);
  await page.route('**/api/v1/topics/predictions*', async (route) => {
    if (route.request().method() !== 'POST')
      return route.fulfill({ json: { items: [], instances: [] } });
    submits++;
    return route.fulfill({
      status: 202,
      json: { instanceId: 'detail-prediction', runId: 'failed-run' },
    });
  });
  await page.route('**/api/v1/topics/runs/failed-run', (route) =>
    route.fulfill({ json: { id: 'failed-run', status: 'failed', error: '近期观测不足' } }),
  );
  const detail = await openVessel(page);
  await detail.getByRole('button', { name: '航迹预测', exact: true }).click();
  const prediction = page.getByTestId('prediction-panel');
  await expect(prediction.getByRole('alert')).toContainText('预测计算失败：近期观测不足');
  await prediction.getByRole('button', { name: '重新加载', exact: true }).click();
  await expect.poll(() => submits).toBe(2);
  await expect(prediction.getByLabel('目标船舶 MMSI')).toHaveValue(chartPoint.mmsi);
});
