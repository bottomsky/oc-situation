import { expect, test } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { chartPoint } from './fixtures/chart-data';
import { captureChartMap } from './fixtures/chart-map';
import { selectLeftTab } from './chart-helpers';

test('当前密度锚定单船坐标并同步筛选，历史热图保留真实格面且互斥', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chartFixture(page);
  const heatmapRequests: string[] = [];
  await page.route('**/api/v1/map/points?**', async (route) => {
    const filtered = new URL(route.request().url()).searchParams.get('shipType') === '70';
    await route.fulfill({
      json: {
        items: [{ ...chartPoint, lon: filtered ? 124 : 122, lat: filtered ? 34 : 32 }],
        total: 1,
        sampled: false,
        truncated: false,
        generatedAt: chartPoint.observedAt,
        snapshotId: filtered ? 'filtered' : 'initial',
        sequence: 1,
        nextCursor: null,
        complete: true,
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  });
  await page.route('**/api/v1/map/heatmap?**', async (route) => {
    const params = new URL(route.request().url()).searchParams;
    heatmapRequests.push(route.request().url());
    await route.fulfill({
      json: {
        query: {
          bbox: params.get('bbox')!.split(',').map(Number),
          from: params.get('from'),
          to: params.get('to'),
        },
        grid: { level: 7, cellDegrees: 2.8125 },
        cells: [{ id: '7:107:43', x: 107, y: 43, lon: 122.34375, lat: 32.34375, vesselCount: 3 }],
        totalVessels: 3,
        generatedAt: new Date().toISOString(),
        metric: 'unique_vessels',
        shipTypeBasis: 'current_profile',
      },
    });
  });
  await page.goto('/?mapDiagnostics=1');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await captureChartMap(page, 'densityTestMap');
  await selectLeftTab(page, 'AIS 热力图');
  await expect(page.getByLabel('热力图统计口径', { exact: true })).toHaveValue('current');
  await page.getByRole('button', { name: '开启当前船位密度', exact: true }).click();
  await expect(page.getByTestId('current-density-legend')).toContainText('1 艘');
  const first = await page.evaluate(async () => {
    const current = (
      globalThis as typeof globalThis & { densityTestMap: import('maplibre-gl').Map }
    ).densityTestMap;
    const layer = current.getStyle().layers.find((item) => item.id === 'ais-current-density')!;
    const data = await (
      current.getSource('vessels') as import('maplibre-gl').GeoJSONSource
    ).getData();
    return {
      layer,
      data,
      visibility: current.getLayoutProperty('ais-current-density', 'visibility'),
    };
  });
  expect(first.layer).toMatchObject({
    type: 'heatmap',
    source: 'vessels',
    paint: { 'heatmap-weight': 1 },
  });
  expect(first.visibility).toBe('visible');
  expect(first.data).toMatchObject({
    type: 'FeatureCollection',
    features: [{ geometry: { type: 'Point', coordinates: [122, 32] } }],
  });
  expect(heatmapRequests).toHaveLength(0);
  await page.getByRole('button', { name: '设置观测筛选', exact: true }).click();
  const filter = page.getByRole('dialog', { name: '观测筛选条件设置' });
  await filter.getByLabel('船型代码', { exact: true }).fill('70');
  await filter.getByRole('button', { name: '应用', exact: true }).click();
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const current = (
          globalThis as typeof globalThis & { densityTestMap: import('maplibre-gl').Map }
        ).densityTestMap;
        const data = await (
          current.getSource('vessels') as import('maplibre-gl').GeoJSONSource
        ).getData();
        return data.type === 'FeatureCollection' ? data.features[0]?.geometry : null;
      }),
    )
    .toEqual({ type: 'Point', coordinates: [124, 34] });
  expect(heatmapRequests).toHaveLength(0);
  await page.screenshot({ path: test.info().outputPath('current-density-coordinates.png') });
  await page.getByLabel('热力图统计口径', { exact: true }).selectOption('historical');
  await expect(page.getByTestId('current-density-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
  const historical = await page.evaluate(async () => {
    const current = (
      globalThis as typeof globalThis & { densityTestMap: import('maplibre-gl').Map }
    ).densityTestMap;
    return {
      type: current.getLayer('ais-heatmap')?.type,
      data: await (
        current.getSource('ais-heatmap') as import('maplibre-gl').GeoJSONSource
      ).getData(),
      currentVisibility: current.getLayoutProperty('ais-current-density', 'visibility'),
    };
  });
  expect(historical.type).toBe('fill');
  expect(historical.currentVisibility).toBe('none');
  expect(historical.data).toMatchObject({
    type: 'FeatureCollection',
    features: [
      {
        id: '7:107:43',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [120.9375, 30.9375],
              [123.75, 30.9375],
              [123.75, 33.75],
              [120.9375, 33.75],
              [120.9375, 30.9375],
            ],
          ],
        },
      },
    ],
  });
  expect(heatmapRequests).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath('historical-cell-footprint.png') });
  await page.getByLabel('热力图统计口径', { exact: true }).selectOption('current');
  await page.getByRole('button', { name: '开启当前船位密度', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await expect(page.getByTestId('current-density-legend')).toBeVisible();
  await page.getByLabel('热力图统计口径', { exact: true }).selectOption('historical');
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
  expect(heatmapRequests).toHaveLength(1);
  await page.getByLabel('热力图统计口径', { exact: true }).selectOption('current');
  await page.getByRole('button', { name: '开启当前船位密度', exact: true }).click();
  await page
    .getByTestId('current-density-legend')
    .getByRole('button', { name: '关闭热力图', exact: true })
    .click();
  const closed = await page.evaluate(() => {
    const current = (
      globalThis as typeof globalThis & { densityTestMap: import('maplibre-gl').Map }
    ).densityTestMap;
    return {
      visibility: current.getLayoutProperty('ais-current-density', 'visibility'),
      hasVessels: Boolean(current.getSource('vessels')),
    };
  });
  expect(closed).toEqual({ visibility: 'none', hasVessels: true });
  await page.getByRole('button', { name: '开启当前船位密度', exact: true }).click();
  await selectLeftTab(page, '图层控制');
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('AIS 船位', { exact: true }).uncheck();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          globalThis as typeof globalThis & { densityTestMap: import('maplibre-gl').Map }
        ).densityTestMap.getLayoutProperty('ais-current-density', 'visibility'),
      ),
    )
    .toBe('none');
  await expect(page.getByTestId('current-density-legend')).toContainText('单船图层已关闭');
  await expect(map).toHaveAttribute('data-map-initializations', '1');
});
