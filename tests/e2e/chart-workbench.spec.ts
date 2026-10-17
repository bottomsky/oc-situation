import { test, expect } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { chartResult, chartTopic } from './fixtures/chart-data';
import { openLeftPanel, openConsolePage, selectLeftTab } from './chart-helpers';

test('面板拖动、键盘调整、持久化与窗口缩放保留同一海图', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  await page.setViewportSize({ width: 1920, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => calls.liveConnections).toBe(1);
  await openLeftPanel(page);
  const instance = await map.getAttribute('data-map-instance');
  const connections = calls.liveConnections;
  const left = page.getByRole('separator', { name: '调整操作面板宽度' });
  const right = page.getByRole('separator', { name: '调整协同面板宽度' });
  const composer = page.getByTestId('chart-agent-composer');
  await expect(composer).toBeVisible();
  await expect(page.getByRole('separator', { name: '调整数据列表高度' })).toHaveCount(0);
  await expect(page.getByTestId('chart-bottom-tables')).toHaveCount(0);
  async function drag(handle: typeof left, x: number, y: number) {
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + x, box.y + box.height / 2 + y, { steps: 5 });
    await page.mouse.up();
  }
  await drag(left, 60, 0);
  await expect(left).toHaveAttribute('aria-valuenow', '360');
  await drag(right, -80, 0);
  await expect(right).toHaveAttribute('aria-valuenow', '420');
  const initialZoom = Number(calls.mapQueries.at(-1)?.searchParams.get('zoom'));
  await page.getByRole('button', { name: '放大海图', exact: true }).click();
  await expect
    .poll(() => Number(calls.mapQueries.at(-1)?.searchParams.get('zoom')))
    .toBeGreaterThan(initialZoom);
  const zoom = calls.mapQueries.at(-1)!.searchParams.get('zoom');
  await left.press('Home');
  await expect(left).toHaveAttribute('aria-valuenow', '300');
  expect(calls.mapQueries.at(-1)!.searchParams.get('zoom')).toBe(zoom);
  await left.press('Shift+ArrowRight');
  await left.press('ArrowRight');
  await left.press('ArrowRight');
  await expect(left).toHaveAttribute('aria-valuenow', '360');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  expect(calls.liveConnections).toBe(connections);
  await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
  await openLeftPanel(page);
  await expect(left).toHaveAttribute('aria-valuenow', '360');
  const originalStyles = await page.evaluate(() => {
    const style = document.documentElement.style;
    const original = { userSelect: style.userSelect, cursor: style.cursor };
    style.userSelect = 'text';
    style.cursor = 'crosshair';
    return original;
  });
  await left.evaluate((element) =>
    element.addEventListener(
      'pointerdown',
      (event) => {
        (element as HTMLElement).dataset.testPointerId = String((event as PointerEvent).pointerId);
      },
      { once: true },
    ),
  );
  const leftBox = (await left.boundingBox())!;
  await page.mouse.move(leftBox.x + 4, leftBox.y + 100);
  await page.mouse.down();
  const pointerId = Number(await left.getAttribute('data-test-pointer-id'));
  expect(await left.evaluate((element, id) => element.hasPointerCapture(id), pointerId)).toBe(true);
  await left.dispatchEvent('pointercancel', { pointerId });
  await page.mouse.up();
  await expect(left).not.toHaveClass(/dragging/);
  expect(
    await page.evaluate(() => ({
      userSelect: document.documentElement.style.userSelect,
      cursor: document.documentElement.style.cursor,
    })),
  ).toEqual({ userSelect: 'text', cursor: 'crosshair' });
  await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect(left).not.toHaveClass(/dragging/);
  await page.evaluate((styles) => {
    document.documentElement.style.userSelect = styles.userSelect;
    document.documentElement.style.cursor = styles.cursor;
  }, originalStyles);
  await page.reload();
  await openLeftPanel(page);
  await expect(left).toHaveAttribute('aria-valuenow', '360');
  await expect(right).toHaveAttribute('aria-valuenow', '420');
  await expect(composer).toBeVisible();
  const restoredInstance = await map.getAttribute('data-map-instance');
  await drag(left, 1000, 0);
  await drag(right, -1000, 0);
  await page.setViewportSize({ width: 1440, height: 640 });
  await expect.poll(async () => (await map.boundingBox())!.width).toBeGreaterThanOrEqual(480);
  await expect.poll(async () => (await map.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  await page.getByRole('button', { name: '海图全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true);
  await expect(composer).toBeVisible();
  await expect.poll(async () => (await map.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  await expect(map).toHaveAttribute('data-map-instance', restoredInstance!);
  await page.getByRole('button', { name: '退出海图全屏', exact: true }).click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(left).toHaveCount(0);
  await expect(right).toBeVisible();
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(left).toHaveCount(0);
  await expect(right).toHaveCount(0);
  // Close overlaid drawers to verify the map and composer remain available on mobile.
  if (await page.getByTestId('chart-left-panel').isVisible())
    await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
  if (await page.getByTestId('chart-right-panel').isVisible())
    await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
  await expect(composer).toBeVisible();
  await expect(page.getByRole('button', { name: '折叠列表', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '展开列表', exact: true })).toHaveCount(0);
  await expect(map).toHaveAttribute('data-map-instance', restoredInstance!);
  await expect(map).toHaveAttribute('data-map-initializations', '1');
  expect(pageErrors, '拖动、全屏及窗口缩放期间应无浏览器脚本错误').toEqual([]);
});

for (const width of [1920, 1440, 1280, 768]) {
  test(`海图工作台 ${width}px 独立滚动与折叠保持同一地图实例`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await chartFixture(page);
    await page.goto('/');
    const map = page.getByTestId('sea-map');
    await expect(map).toHaveAttribute('data-ready', 'true');
    await expect(map).toHaveAttribute('data-map-initializations', '1');
    const mapInstance = await map.getAttribute('data-map-instance');
    expect(mapInstance).toMatch(/^[a-f\d-]{36}$/i);
    const bounds = await map.boundingBox();
    expect(bounds!.height).toBeGreaterThan(250);
    expect(bounds!.width).toBeGreaterThan(width < 1024 ? 650 : 500);
    const workspace = page.getByTestId('chart-workspace');
    await expect
      .poll(async () =>
        workspace.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight + 2),
      )
      .toBe(true);
    for (let i = 0; i < 3; i++) {
      await openLeftPanel(page);
      await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
      await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
      await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
      if (await page.getByTestId('chart-right-panel').isVisible())
        await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
      await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
      await expect(page.getByTestId('chart-right-panel')).toBeVisible();
      await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
      await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
      await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
    }
    await expect(map).toHaveAttribute('data-map-initializations', '1');
    if (await page.getByTestId('chart-right-panel').isVisible())
      await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
    await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
    await expect(page.getByTestId('chart-right-panel')).toBeVisible();
    await page.getByRole('tab', { name: 'AI 对话', exact: true }).click();
    await expect(page.getByTestId('agent-panel').getByText(/区域研判智能体尚未启用/)).toBeVisible();
    await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
    if (width >= 1440) {
      await openLeftPanel(page);
      await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
      await expect(page.getByTestId('chart-left-panel')).toBeVisible();
      await expect(page.getByTestId('chart-right-panel')).toBeVisible();
    } else {
      await expect(page.getByTestId('chart-left-panel')).not.toBeVisible();
      await page.getByRole('button', { name: '打开协同面板', exact: true }).click();
      await expect(page.getByTestId('chart-right-panel')).toBeVisible();
    }
    await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
    await page.screenshot({ path: test.info().outputPath(`chart-${width}.png`), fullPage: true });
    if (width < 1024) {
      await page.getByRole('button', { name: '关闭协同面板', exact: true }).click();
      await openLeftPanel(page);
      await expect(page.getByTestId('chart-left-panel')).toBeVisible();
      await expect(map).toHaveAttribute('data-map-instance', mapInstance!);
      await page.screenshot({
        path: test.info().outputPath(`chart-${width}-operations.png`),
        fullPage: true,
      });
    }
  });
}

test('全局搜索首次q、重复q、游标分页和空白清空', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/?q=夹具船&searchRevision=7');
  await expect(page.getByTestId('vessel-result')).toContainText('夹具船');
  expect(calls.search[0]!.searchParams.get('limit')).toBe('20');
  const search = page.getByLabel('搜索船名、MMSI或IMO');
  const count = calls.search.length;
  await search.fill('夹具船');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await expect.poll(() => calls.search.length).toBe(count + 1);
  await expect(page).toHaveURL(/searchRevision=8/);
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await expect.poll(() => calls.search.at(-1)?.searchParams.get('cursor')).toBe('page-2');
  await search.fill('  ');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('vessel-result')).toHaveCount(0);
  await expect(page.getByLabel('船舶搜索', { exact: true })).toHaveValue('');
});

test('分组菜单点击搜索收起，搜索从治理页回到海图', async ({ page }) => {
  await chartFixture(page);
  await page.goto('/');
  await page.getByRole('button', { name: '展开任务管理导航' }).click();
  await expect(page.getByRole('link', { name: '采集任务', exact: true })).toBeVisible();
  await page.getByLabel('搜索船名、MMSI或IMO').click();
  await expect(page.getByRole('link', { name: '采集任务', exact: true })).toHaveCount(0);
  await openConsolePage(page, '分析专题');
  await page.getByLabel('搜索船名、MMSI或IMO').fill('返回海图');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await expect(page.getByTestId('vessel-result')).toContainText('返回海图');
});

test('聚合海图不请求单船详情，专题列表与证据保留历史修订', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page, { clusters: true });
  await page.goto('/');
  await expect(page.getByTestId('chart-bottom-tables')).toHaveCount(0);
  await expect(page.locator('.map-status')).toContainText('20 艘船');
  expect(calls.vesselDetail).toBe(0);
  await expect.poll(() => calls.resultList).toBe(1);
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await page
    .getByTestId('fusion-events')
    .getByRole('button', { name: chartResult.title, exact: true })
    .click();
  await expect.poll(() => calls.resultDetail).toBe(1);
  const evidence = page.getByRole('region', { name: '结论证据' });
  await expect(evidence).toContainText('测试夹具原文：港区临时限制通行。');
  await page.getByRole('button', { name: '放大阅读证据' }).click();
  await evidence.getByRole('button', { name: /修订 1/ }).click();
  await expect(evidence.getByRole('heading', { name: '历史修订 1' })).toBeVisible();
  await expect(page.getByTestId('evidence-map-legend')).toContainText('修订 1');
  await page.getByRole('button', { name: '返回紧凑视图' }).click();
  await expect(evidence.getByRole('heading', { name: '历史修订 1' })).toBeVisible();
  expect(calls.resultDetail).toBe(1);
});

test('真实回放帧和AIS图层开关保留采集连接', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/?q=回放船&searchRevision=1');
  await page.getByTestId('vessel-result').click();
  await selectLeftTab(page, '时间回放');
  await page.getByRole('button', { name: '查询轨迹', exact: true }).click();
  await expect(page.getByTestId('track-summary')).toContainText('2 / 2 点');
  await page.getByRole('button', { name: '播放轨迹', exact: true }).click();
  await expect(page.getByLabel('轨迹播放位置')).toHaveValue('1');
  await selectLeftTab(page, '图层控制');
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('AIS 船位', { exact: true }).uncheck();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect(page.locator('.map-status')).toContainText('1 艘船');
  expect(calls.vesselDetail).toBe(1);
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('AIS 船位', { exact: true }).check();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-map-initializations', '1');
});

test('观测筛选在应用后更新地图，取消保留原条件', async ({ page }) => {
  const calls = await chartFixture(page);
  await page.goto('/');
  await openLeftPanel(page);
  await page.getByRole('button', { name: '设置观测筛选' }).click();
  const dialog = page.getByRole('dialog', { name: '观测筛选条件设置' });
  await dialog.getByLabel('数据来源', { exact: true }).selectOption('fixture-ais');
  await dialog.getByLabel('船型代码', { exact: true }).fill('70');
  await dialog.getByRole('button', { name: '7天', exact: true }).click();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  expect(calls.mapQueries.at(-1)?.searchParams.has('sourceId')).toBe(false);
  await page.getByRole('button', { name: '设置观测筛选' }).click();
  await expect(dialog.getByLabel('船型代码', { exact: true })).toHaveValue('');
  await dialog.getByLabel('数据来源', { exact: true }).selectOption('fixture-ais');
  await dialog.getByLabel('船型代码', { exact: true }).fill('70');
  await dialog.getByRole('button', { name: '7天', exact: true }).click();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('shipType')).toBe('70');
  expect(calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('168');
  expect(calls.mapQueries.at(-1)?.searchParams.get('sourceId')).toBe('fixture-ais');
  await page.getByRole('button', { name: '移除船型：70', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.has('shipType')).toBe(false);
  await page.getByRole('button', { name: '设置观测筛选' }).click();
  await dialog.getByRole('button', { name: '重置', exact: true }).click();
  await dialog.getByRole('button', { name: '应用', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('24');
  expect(calls.mapQueries.at(-1)?.searchParams.has('sourceId')).toBe(false);
});

test('任务中心只读取所选专题运行，幂等提交后待执行时禁用', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  let idempotency = '';
  let csrf = '';
  await page.route('**/api/v1/topics/instances/*/run', async (route) => {
    idempotency = route.request().headers()['idempotency-key'] ?? '';
    csrf = route.request().headers()['x-csrf-token'] ?? '';
    await route.fallback();
  });
  await page.goto('/');
  await page.getByRole('tab', { name: '任务中心', exact: true }).click();
  const tasks = page.getByTestId('chart-task-center');
  await expect(tasks.getByRole('button', { name: new RegExp(chartTopic.name) })).toBeVisible();
  expect(calls.runs.length).toBe(0);
  await tasks.getByRole('button', { name: new RegExp(chartTopic.name) }).click();
  await expect(tasks.getByRole('button', { name: '立即分析', exact: true })).toBeEnabled();
  expect(calls.runs.length).toBe(1);
  await tasks.getByRole('button', { name: '立即分析', exact: true }).click();
  await expect(tasks.getByRole('button', { name: '已有运行等待完成' })).toBeDisabled();
  expect(calls.manual).toBe(1);
  expect(idempotency).toMatch(/^[a-f\d-]{36}$/i);
  expect(csrf).toBe('fixture-csrf');
});

test('本地深色底图忽略旧图层偏好和外部样式配置，业务图层仍可绘制', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  const externalRequests: string[] = [];
  page.on('request', (request) => {
    if (/gebco|openseamap|maptiler|legacy-chart\.example/i.test(request.url()))
      externalRequests.push(request.url());
  });
  await page.addInitScript(() => {
    for (const layer of ['bathymetry', 'seamarks', 'custom'])
      localStorage.setItem(`ais:chart:fixture-user:${layer}`, 'true');
    localStorage.setItem(
      'ais:chart:fixture-user:layers',
      JSON.stringify({ bathymetry: true, seamarks: true, custom: true }),
    );
  });
  await page.route(
    new URL('/', test.info().project.use.baseURL ?? 'http://127.0.0.1:13001').href,
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '</body>',
        '<script>window.__NUXT__.config.public.mapStyleUrl="https://legacy-chart.example/style.json";window.__NUXT__.config.public.mapTilerKey="legacy-test-key";</script></body>',
      );
      await route.fulfill({ response, body });
    },
  );
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  expect(externalRequests, '旧偏好及配置应无法触发外部底图请求').toEqual([]);
  await expect(page.getByTestId('chart-source-note')).toContainText('本地深色底图');
  await expect(page.getByTestId('chart-source-note')).toContainText('Natural Earth');
  const map = page.getByTestId('sea-map');
  const instance = await map.getAttribute('data-map-instance');
  async function renderedColors() {
    const png = (await page.locator('.maplibregl-canvas').screenshot()).toString('base64');
    return page.evaluate(async (encoded) => {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sea = 0;
      let land = 0;
      let ais = 0;
      let tracks = 0;
      let evidence = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 8 && pixels[i + 1] === 29 && pixels[i + 2] === 49) sea++;
        else if (pixels[i] === 23 && pixels[i + 1] === 55 && pixels[i + 2] === 69) land++;
        else if (
          pixels[i]! > 170 &&
          pixels[i + 1]! > 85 &&
          pixels[i + 1]! < 140 &&
          pixels[i + 2]! < 80
        )
          ais++;
        if (pixels[i] === 215 && pixels[i + 1] === 121 && pixels[i + 2] === 53) tracks++;
        if (pixels[i] === 186 && pixels[i + 1] === 74 && pixels[i + 2] === 67) evidence++;
      }
      return { sea, land, ais, tracks, evidence };
    }, png);
  }
  await expect
    .poll(async () => {
      const colors = await renderedColors();
      return colors.sea > 500 && colors.land > 500 && colors.ais > 5;
    })
    .toBe(true);
  await expect(page.locator('.map-status')).toContainText('1 艘船');
  await openLeftPanel(page);
  await selectLeftTab(page, '图层控制');
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await expect(
    page.getByRole('dialog', { name: '海图图层设置' }).getByRole('checkbox'),
  ).toHaveCount(3);
  await page.getByLabel('AIS 船位', { exact: true }).uncheck();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).ais).toBe(0);
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('AIS 船位', { exact: true }).check();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).ais).toBeGreaterThan(5);
  await page.getByLabel('搜索船名、MMSI或IMO').fill('底图回归船');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await page.getByTestId('vessel-result').click();
  await selectLeftTab(page, '时间回放');
  await page.getByRole('button', { name: '查询轨迹', exact: true }).click();
  await expect.poll(async () => (await renderedColors()).tracks).toBeGreaterThan(20);
  await selectLeftTab(page, '图层控制');
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('船舶轨迹', { exact: true }).uncheck();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).tracks).toBe(0);
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('船舶轨迹', { exact: true }).check();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).tracks).toBeGreaterThan(20);
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await page
    .getByTestId('fusion-events')
    .getByRole('button', { name: chartResult.title, exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).evidence).toBeGreaterThan(15);
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('专题证据', { exact: true }).uncheck();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).evidence).toBe(0);
  await page.getByRole('button', { name: '设置海图图层' }).click();
  await page.getByLabel('专题证据', { exact: true }).check();
  await page
    .getByRole('dialog', { name: '海图图层设置' })
    .getByRole('button', { name: '应用', exact: true })
    .click();
  await expect.poll(async () => (await renderedColors()).evidence).toBeGreaterThan(15);
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await expect(map).toHaveAttribute('data-map-initializations', '1');
  expect(externalRequests).toEqual([]);
  expect(calls.liveConnections).toBe(1);
  await page.screenshot({ path: test.info().outputPath('chart-dark-basemap.png'), fullPage: true });
});

test('搜索竞态：较晚返回的旧关键词响应保持失效', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chartFixture(page);
  let release: (() => void) | undefined;
  let oldStarted = false;
  let oldReturned = false;
  await page.route('**/api/v1/vessels?*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('query') === '旧关键词') {
      oldStarted = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    await route.fallback();
    if (new URL(route.request().url()).searchParams.get('query') === '旧关键词') oldReturned = true;
  });
  await page.goto('/');
  const search = page.getByLabel('搜索船名、MMSI或IMO');
  await search.fill('旧关键词');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await expect.poll(() => oldStarted).toBe(true);
  await search.fill('新关键词');
  await page.getByRole('button', { name: '搜索船舶', exact: true }).click();
  await expect(page.getByTestId('vessel-result')).toContainText('新关键词');
  release!();
  await expect.poll(() => oldReturned).toBe(true);
  await expect(page.getByTestId('vessel-result')).toContainText('新关键词');
  await expect(page.getByTestId('vessel-result')).not.toContainText('旧关键词');
});

test('菜单Tab移出搜索关闭，Escape恢复导航按钮焦点', async ({ page }) => {
  await chartFixture(page);
  await page.goto('/');
  const trigger = page.getByRole('button', { name: '展开任务管理导航' });
  await trigger.click();
  await expect(page.getByRole('link', { name: '采集任务', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('link', { name: '采集任务', exact: true })).toHaveCount(0);
  // The menu is at the end of the header; reverse tabbing passes identity and submit.
  await page.getByRole('button', { name: '展开系统设置导航' }).click();
  await expect(page.getByRole('link', { name: '账号权限', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('link', { name: '账号权限', exact: true })).toHaveCount(0);
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByLabel('搜索船名、MMSI或IMO')).toBeFocused();
  await expect(page.getByRole('link', { name: '账号权限', exact: true })).toHaveCount(0);
});

test('来源配置状态与AISStream启用条件按真实元数据展示', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chartFixture(page);
  await page.goto('/');
  await expect(page.locator('.chart-source-status')).toHaveCount(0);
  await openConsolePage(page, '数据来源');
  const row = page.getByRole('row').filter({ hasText: 'fixture-ais' });
  await expect(row).toContainText('AISStream');
  await expect(row.locator('.status-disabled')).toBeVisible();
  await expect(row.locator('td').nth(3)).toHaveText('—');
  await expect(row).toContainText('待确认授权');
  await expect(row).not.toContainText('运行正常');
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await expect(page.getByLabel('凭证变量名', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('已确认采购或来源访问授权')).not.toBeChecked();
});

test('证据放大为原生模态，限制焦点与地图快捷键并恢复触发按钮', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await page
    .getByTestId('fusion-events')
    .getByRole('button', { name: chartResult.title, exact: true })
    .click();
  const trigger = page.getByRole('button', { name: '放大阅读证据' });
  await trigger.click();
  const modal = page.getByRole('dialog', { name: '结论证据放大阅读' });
  await expect(modal).toBeVisible();
  await expect(modal).toHaveJSProperty('open', true);
  await expect(modal.getByRole('button', { name: '返回紧凑视图' })).toBeFocused();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Tab');
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog')))
      .toBe(true);
  }
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('dialog')))
      .toBe(true);
  }
  await modal.getByRole('button', { name: '返回紧凑视图' }).focus();
  // 等待证据定位的 moveend 视口请求，正常定位回调不计为快捷键动作。
  await expect
    .poll(() => {
      const query = calls.mapQueries.at(-1);
      const bounds = query?.searchParams.get('bbox')?.split(',').map(Number);
      if (!bounds || bounds.length !== 4 || !bounds.every(Number.isFinite)) return false;
      const centerLongitude = (bounds[0]! + bounds[2]!) / 2;
      const centerLatitude = (bounds[1]! + bounds[3]!) / 2;
      const [west, south, east, north] = chartResult.bbox;
      return (
        centerLongitude >= west &&
        centerLongitude <= east &&
        centerLatitude >= south &&
        centerLatitude <= north
      );
    })
    .toBe(true);
  const before = calls.mapQueries.length;
  await page.keyboard.press('+');
  await page.keyboard.press('Home');
  await page.waitForTimeout(300); // Map viewport callbacks are debounced for 150ms.
  expect(calls.mapQueries.length).toBe(before);
  await page.keyboard.press('Escape');
  await expect(modal).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('+');
  await expect.poll(() => calls.mapQueries.length).toBeGreaterThan(before);
});

test('任务状态后续请求失败时禁止重复运行，显式重试成功恢复', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/');
  await page.getByRole('tab', { name: '任务中心', exact: true }).click();
  const tasks = page.getByTestId('chart-task-center');
  await tasks.getByRole('button', { name: new RegExp(chartTopic.name) }).click();
  await expect(tasks.getByRole('button', { name: '立即分析', exact: true })).toBeEnabled();
  let fail = true;
  await page.route('**/api/v1/topics/instances/*/runs', (route) =>
    fail ? route.fulfill({ status: 503, json: { message: 'outage' } }) : route.fallback(),
  );
  await tasks.getByRole('button', { name: '刷新运行状态' }).click();
  await expect(tasks.getByRole('alert')).toContainText('服务');
  await expect(tasks.getByRole('button', { name: '立即分析', exact: true })).toBeDisabled();
  await expect(tasks).toContainText('运行状态待确认');
  expect(calls.manual).toBe(0);
  fail = false;
  await tasks.getByRole('button', { name: '刷新运行状态' }).click();
  await expect(tasks.getByRole('button', { name: '立即分析', exact: true })).toBeEnabled();
});

test('管理操作通知返回海图后保持视口高度，在移动抽屉上可关闭', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await chartFixture(page);
  await page.route('**/api/v1/topics', (route) =>
    route.fulfill({
      json: {
        definitions: [
          {
            id: 'port-restriction',
            name: '港区限制',
            version: '1.0.0',
            description: '夹具专题',
            available: true,
            requiredCapabilities: [],
          },
        ],
        instances: [],
      },
    }),
  );
  await page.goto('/topics');
  await page.getByLabel('专题名称', { exact: true }).fill('通知回归专题');
  await page.getByRole('button', { name: '创建专题', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('专题已创建');
  await page.getByRole('link', { name: '智能海图 · AIS 综合态势系统首页' }).click();
  await expect(page.getByTestId('chart-workspace')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 2))
    .toBe(true);
  await openLeftPanel(page);
  const notice = page.locator('.notice');
  const close = notice.getByRole('button', { name: '关闭', exact: true });
  await expect(close).toBeVisible();
  const bounds = await close.boundingBox();
  expect(
    await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.notice'), {
      x: bounds!.x + bounds!.width / 2,
      y: bounds!.y + bounds!.height / 2,
    }),
  ).toBe(true);
  await close.click();
  await expect(notice).toHaveCount(0);
});

test('主动推送选择与证据历史修订保持同一结果标识', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await chartFixture(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  const card = page
    .getByTestId('fusion-events')
    .getByRole('button', { name: chartResult.title, exact: true });
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: '结论证据' })).toBeVisible();
  await page
    .getByRole('region', { name: '结论证据' })
    .getByRole('button', { name: /修订 1/ })
    .click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await page
    .getByRole('region', { name: '结论证据' })
    .getByRole('button', { name: '关闭证据' })
    .click();
  await expect(card).toHaveAttribute('aria-pressed', 'false');
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
});
