import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { captureChartMap } from './fixtures/chart-map';
import { openLeftPanel, selectLeftTab } from './chart-helpers';

function result() {
  const to = new Date().toISOString();
  return {
    query: { bbox: [110, 10, 130, 40], from: new Date(Date.now() - 86400000).toISOString(), to },
    grid: { level: 7, cellDegrees: 2.8125 },
    cells: [{ id: '7:107:43', x: 107, y: 43, lon: 122.34375, lat: 32.34375, vesselCount: 3 }],
    totalVessels: 3,
    generatedAt: to,
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  };
}
async function heatmapFixture(page: Page, delayed = false) {
  await chartFixture(page);
  const requests: URL[] = [];
  let complete = !delayed;
  let created = false;
  const snapshot = result();
  const session = {
    id: 'heat-session',
    ownerId: 'fixture-user',
    title: '热图会话',
    createdAt: snapshot.generatedAt,
  };
  const task = {
    id: 'heat-task',
    sessionId: session.id,
    goal: '生成热图',
    status: 'completed',
    intent: 'ais_heatmap',
    inputRevision: 1,
    resultInputRevision: 1,
    resultVersion: 1,
    historyHours: 24,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  };
  await page.route('**/api/v1/map/heatmap?**', async (route) => {
    const url = new URL(route.request().url());
    requests.push(url);
    const query = {
      ...snapshot.query,
      bbox: url.searchParams.get('bbox')!.split(',').map(Number),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    };
    await route.fulfill({ json: { ...snapshot, query } });
  });
  await page.route('**/api/v1/agent/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown;
    const current = { ...task, status: complete ? 'completed' : 'running' };
    if (path.endsWith('/config'))
      json = {
        enabled: true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/sessions')) {
      if (route.request().method() === 'POST') {
        created = true;
        json = session;
      } else json = { items: created ? [session] : [] };
    } else if (path.endsWith('/messages'))
      json = {
        task: current,
        message: {
          id: 'heat-message',
          sessionId: session.id,
          taskId: task.id,
          role: 'user',
          content: '生成热图',
          createdAt: snapshot.generatedAt,
        },
      };
    else if (path.includes('/events')) json = { items: [{ id: 'event' }], nextCursor: '1' };
    else if (path.includes('/tasks/'))
      json = {
        task: current,
        results: [],
        steps: [],
        heatmapResult: complete
          ? { ...snapshot, kind: 'ais_heatmap', version: 1, inputRevision: 1 }
          : null,
      };
    else json = { session, tasks: [current], messages: [], snapshotCursor: '0' };
    await route.fulfill({ json });
  });
  return {
    requests,
    complete: () => {
      complete = true;
    },
  };
}
async function openHeatmap(page: Page) {
  await openLeftPanel(page);
  await selectLeftTab(page, 'AIS 热力图');
  await page.getByLabel('热力图统计口径', { exact: true }).selectOption('historical');
}
test('人工生成锁定范围，缩放不重查，关闭移除图层', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  const fixture = await heatmapFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await captureChartMap(page, 'heatmapTestMap');
  await openHeatmap(page);
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  const legend = page.getByTestId('heatmap-legend');
  await expect(legend).toContainText('海图已展示');
  await expect(legend).toContainText('全区 3 艘');
  expect(fixture.requests[0]!.searchParams.get('bbox')).not.toBe('-180,-85,180,85');
  const before = await legend.textContent();
  await page.getByRole('button', { name: '放大海图', exact: true }).click();
  await expect(legend).toHaveText(before!);
  expect(fixture.requests).toHaveLength(1);
  const cellPoint = await page.evaluate(() => {
    const map = (globalThis as typeof globalThis & { heatmapTestMap: import('maplibre-gl').Map })
      .heatmapTestMap;
    const point = map.project([122.34375, 32.34375]);
    const rect = map.getCanvas().getBoundingClientRect();
    return { x: point.x + rect.x, y: point.y + rect.y };
  });
  await page.mouse.click(cellPoint.x, cellPoint.y);
  await expect(page.locator('.maplibregl-popup')).toContainText('3 艘去重船舶');
  const style = await page.evaluate(async () => {
    const map = (globalThis as typeof globalThis & { heatmapTestMap: import('maplibre-gl').Map })
      .heatmapTestMap;
    const original = map.getStyle();
    // Reproduce restoring a style saved before the grid-centre circles were removed.
    original.layers.push({
      id: 'ais-heatmap-cells',
      type: 'circle',
      source: 'ais-heatmap',
    });
    await new Promise<void>((resolve) => {
      map.once('idle', () => resolve());
      map.setStyle(original, { diff: false });
    });
    const source = map.getSource('ais-heatmap') as import('maplibre-gl').GeoJSONSource;
    const data = await source.getData();
    return {
      count: data.type === 'FeatureCollection' ? data.features.length : -1,
      layers: map.getStyle().layers.map((layer) => layer.id),
    };
  });
  expect(style.count).toBe(1);
  expect(style.layers).not.toContain('ais-heatmap-cells');
  expect(style.layers.indexOf('ais-heatmap')).toBeLessThan(style.layers.indexOf('vessels'));
  expect(fixture.requests).toHaveLength(1);
  await page.screenshot({
    path: '.data/heatmap-browser-results/manual-heatmap.png',
    fullPage: true,
  });
  await legend.getByRole('button', { name: '关闭热力图' }).click();
  await expect(legend).toHaveCount(0);
});
test('热图统计设置独立应用并校验自定义时间', async ({ page }) => {
  const fixture = await heatmapFixture(page);
  await page.goto('/');
  await openHeatmap(page);
  await page.getByRole('button', { name: '设置热图统计条件' }).click();
  const dialog = page.getByRole('dialog', { name: '热图统计条件设置' });
  await dialog.getByLabel('热图统计时段', { exact: true }).selectOption('168');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByRole('region', { name: '统计条件', exact: true })).toContainText(
    '最近1天',
  );
  await page.getByRole('button', { name: '设置热图统计条件' }).click();
  await dialog.getByLabel('热图统计时段', { exact: true }).selectOption('custom');
  await dialog.getByLabel('热图开始时间', { exact: true }).fill('2020-01-01T00:00');
  await dialog.getByLabel('热图结束时间', { exact: true }).fill('2020-01-02T00:00');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('最近30天');
  await dialog.getByLabel('热图统计时段', { exact: true }).selectOption('72');
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  expect(fixture.requests).toHaveLength(0);
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  const query = fixture.requests[0]!.searchParams;
  expect(Date.parse(query.get('to')!) - Date.parse(query.get('from')!)).toBe(72 * 3600000);
});

test('主动任务自动展示，刷新历史需手动点击快照', async ({ page }) => {
  await heatmapFixture(page);
  await page.goto('/');
  const composer = page.getByTestId('chart-agent-composer');
  await composer.locator('textarea').fill('生成热图');
  await composer.getByRole('button', { name: '发送分析问题' }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
  await page.screenshot({
    path: '.data/heatmap-browser-results/agent-heatmap.png',
    fullPage: true,
  });
  await page.reload();
  await page.getByRole('button', { name: '查看任务详情', exact: true }).click();
  await expect(page.getByRole('button', { name: '在海图展示此快照' })).toBeVisible();
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '在海图展示此快照' }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
});
test('矩形选区固定查询范围，零结果和超限均明确反馈', async ({ page }) => {
  const fixture = await heatmapFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await openHeatmap(page);
  await page.getByRole('button', { name: '热图矩形框选' }).click();
  const overlay = page.getByTestId('agent-region-overlay');
  const bounds = await overlay.boundingBox();
  await page.mouse.move(bounds!.x + 80, bounds!.y + 80);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + 300, bounds!.y + 250);
  await page.mouse.up();
  await expect(overlay).toHaveCount(0);
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
  const first = fixture.requests[0]!.searchParams.get('bbox');
  await page.getByRole('button', { name: '放大海图', exact: true }).click();
  await page.route('**/api/v1/map/heatmap?**', async (route) => {
    const url = new URL(route.request().url());
    fixture.requests.push(url);
    await route.fulfill({
      json: {
        ...result(),
        query: { ...result().query, bbox: url.searchParams.get('bbox')!.split(',').map(Number) },
        cells: [],
        totalVessels: 0,
      },
    });
  });
  await page.getByRole('button', { name: '更新热力图' }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('无匹配观测');
  expect(fixture.requests[1]!.searchParams.get('bbox')).toBe(first);
  await page.route('**/api/v1/map/heatmap?**', (route) =>
    route.fulfill({ status: 413, json: { message: '数据超限' } }),
  );
  await page.getByRole('button', { name: '更新热力图' }).click();
  await expect(
    page.getByRole('region', { name: 'AIS 热力图', exact: true }).getByRole('alert'),
  ).toContainText('缩小区域');
});
test('等待智能体期间手动生成并关闭，迟到任务结果不恢复热图', async ({ page }) => {
  const fixture = await heatmapFixture(page, true);
  await page.goto('/');
  const composer = page.getByTestId('chart-agent-composer');
  await composer.locator('textarea').fill('生成热图');
  await composer.getByRole('button', { name: '发送分析问题' }).click();
  await openHeatmap(page);
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
  await page.getByTestId('heatmap-legend').getByRole('button', { name: '关闭热力图' }).click();
  fixture.complete();
  await page.getByRole('button', { name: '查看任务详情', exact: true }).click();
  await expect(page.getByRole('button', { name: '在海图展示此快照' })).toBeVisible();
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '在海图展示此快照' }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示');
});
