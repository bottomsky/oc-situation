import { expect, test, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { syntheticChartTile, transparentSeamark } from './fixtures/online-chart-fixture';

async function renderedPixels(page: Page, light = false) {
  const anchor = (await page.getByTestId('sea-map').getAttribute('data-online-label-anchor'))!
    .split(',')
    .map(Number);
  const size = await page
    .locator('.maplibregl-canvas')
    .evaluate((canvas) => ({ width: canvas.clientWidth, height: canvas.clientHeight }));
  const encoded = (await page.locator('.maplibregl-canvas').screenshot()).toString('base64');
  return page.evaluate(
    async ({ encoded, light, anchor, size }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(image, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const seaColor = light ? [220, 236, 241] : [8, 29, 49];
      let sea = 0;
      let text = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (seaColor.every((value, channel) => pixels[i + channel] === value)) ++sea;
        const x = (((i / 4) % image.width) * size.width) / image.width;
        const y = (Math.floor(i / 4 / image.width) * size.height) / image.height;
        // Inspect the actually placed Chinese symbol, including antialiased glyph edges.
        // Grid/UI pixels elsewhere in the canvas cannot satisfy the label assertion.
        if (Math.abs(x - anchor[0]!) > 70 || Math.abs(y - anchor[1]!) > 20) continue;
        const r = pixels[i]!,
          g = pixels[i + 1]!,
          b = pixels[i + 2]!;
        if (
          light
            ? r >= 40 && g <= 185 && b <= 185 && g > r && Math.abs(g - b) < 25
            : r >= 100 && g >= 150 && b >= 150
        )
          ++text;
      }
      return { sea, text };
    },
    { encoded, light, anchor, size },
  );
}

async function onlineFixture(page: Page) {
  const state = {
    failBase: false,
    failSeamarks: false,
    tileRequests: 0,
    seamarkRequests: 0,
    release: Promise.resolve(),
  };
  const unexpected: string[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // The fixture owns every online request; any other external host is a test failure.
  await page.route('https://**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'online-chart.fixture') {
      unexpected.push(url.href);
      return route.abort();
    }
    if (url.pathname === '/tilejson.json')
      return route.fulfill({
        json: {
          tilejson: '3.0.0',
          tiles: ['https://online-chart.fixture/vector/{z}/{x}/{y}.pbf'],
          minzoom: 0,
          maxzoom: 14,
          scheme: 'xyz',
        },
      });
    if (url.pathname.startsWith('/vector/')) {
      ++state.tileRequests;
      await state.release;
      if (state.failBase) return route.fulfill({ status: 404, body: 'missing synthetic tile' });
      return route.fulfill({ contentType: 'application/x-protobuf', body: syntheticChartTile() });
    }
    if (url.pathname.startsWith('/seamarks/')) {
      ++state.seamarkRequests;
      if (state.failSeamarks)
        return route.fulfill({ status: 404, body: 'missing synthetic seamark' });
      return route.fulfill({ contentType: 'image/png', body: transparentSeamark });
    }
    unexpected.push(url.href);
    return route.abort();
  });
  const calls = await chartFixture(page, {
    onlineChart: {
      chartOnlineEnabled: true,
      chartSeamarksEnabled: true,
      chartVectorTileJsonUrl: 'https://online-chart.fixture/tilejson.json',
      chartSeamarkTilesUrl: 'https://online-chart.fixture/seamarks/{z}/{x}/{y}.png',
    },
  });
  return { state, unexpected, pageErrors, calls };
}

test('合成在线底图和中文标注真实绘制，主题切换保留地图与AIS', async ({ page }) => {
  const fixture = await onlineFixture(page);
  await page.goto('/?mapDiagnostics=1');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect(map).toHaveAttribute('data-online-chart-state', 'ready');
  await expect(map).toHaveAttribute('data-online-seamarks-state', 'ready');
  await expect(map).toHaveAttribute('data-online-label-sample', '中国沿海测试城');
  await expect
    .poll(async () => Number(await map.getAttribute('data-rendered-online-labels')))
    .toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const pixels = await renderedPixels(page);
      return pixels.sea > 2_000 && pixels.text > 10;
    })
    .toBe(true);
  const instance = await map.getAttribute('data-map-instance');
  const connections = fixture.calls.liveConnections;
  await page.getByRole('button', { name: '浅色海图', exact: true }).click();
  await expect(page.getByRole('button', { name: '深色海图', exact: true })).toBeVisible();
  await expect(map).toHaveAttribute('data-online-chart-state', 'ready');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await expect(map).toHaveAttribute('data-map-initializations', '1');
  await expect(map).toHaveAttribute('data-vessel-source-loaded', 'true');
  await expect
    .poll(async () => {
      const pixels = await renderedPixels(page, true);
      return pixels.sea > 2_000 && pixels.text > 10;
    })
    .toBe(true);
  expect(fixture.calls.liveConnections).toBe(connections);
  expect(fixture.state.tileRequests).toBeGreaterThan(0);
  await expect(
    page.getByTestId('chart-source-note').getByRole('link', { name: 'OpenStreetMap contributors' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('chart-source-note').getByRole('link', { name: 'CC BY-SA 2.0' }),
  ).toBeVisible();
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});

test('TileJSON先到而瓦片延迟时保留本地回退，随后按当前视口启用', async ({ page }) => {
  const fixture = await onlineFixture(page);
  let release!: () => void;
  fixture.state.release = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.goto('/?mapDiagnostics=1');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => fixture.state.tileRequests).toBeGreaterThan(0);
  await expect(map).toHaveAttribute('data-online-chart-state', 'loading');
  await expect(page.getByTestId('chart-source-note')).toContainText('在线底图载入中');
  release();
  await expect(map).toHaveAttribute('data-online-chart-state', 'ready');
  const instance = await map.getAttribute('data-map-instance');
  await page.getByRole('button', { name: '放大海图', exact: true }).click();
  await expect(map).toHaveAttribute('data-online-chart-state', 'ready');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  expect(fixture.unexpected).toEqual([]);
});

test('底图404回退锁存且人工重试恢复，海标失败独立处理', async ({ page }) => {
  const fixture = await onlineFixture(page);
  fixture.state.failBase = true;
  fixture.state.failSeamarks = true;
  await page.goto('/?mapDiagnostics=1');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  await expect(map).toHaveAttribute('data-online-chart-state', 'fallback');
  await expect(map).toHaveAttribute('data-online-seamarks-state', 'fallback');
  const instance = await map.getAttribute('data-map-instance');
  const attribution = page.locator('.maplibregl-ctrl-attrib');
  if (!(await attribution.getAttribute('class'))!.includes('maplibregl-compact-show'))
    await attribution.locator('.maplibregl-ctrl-attrib-button').click();
  await expect(attribution.locator('.maplibregl-ctrl-attrib-inner')).toBeVisible();
  const noteBounds = (await page.getByTestId('chart-source-note').boundingBox())!;
  const attributionBounds = (await attribution.boundingBox())!;
  expect(noteBounds.x + noteBounds.width + 12).toBeLessThanOrEqual(attributionBounds.x);
  fixture.state.failBase = false;
  await page.getByRole('button', { name: '重试在线底图', exact: true }).click();
  await expect(map).toHaveAttribute('data-online-chart-state', 'ready');
  await expect(map).toHaveAttribute('data-online-seamarks-state', 'fallback');
  fixture.state.failSeamarks = false;
  await page.getByRole('button', { name: '重试在线海标', exact: true }).click();
  await expect(map).toHaveAttribute('data-online-seamarks-state', 'ready');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await expect(map).toHaveAttribute('data-vessel-source-loaded', 'true');
  expect(fixture.unexpected).toEqual([]);
  expect(fixture.pageErrors).toEqual([]);
});
