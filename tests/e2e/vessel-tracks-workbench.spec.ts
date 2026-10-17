import { test, expect, type Page } from '@playwright/test';
import { vesselTracksFixture } from './fixtures/vessel-tracks-fixture';
import { openLeftPanel, selectLeftTab } from './chart-helpers';

async function openTracks(page: Page) {
  await openLeftPanel(page);
  await selectLeftTab(page, '历史航线');
}
async function captureMap(page: Page) {
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((name) => /\/maplibre[-_]gl.*\.js/.test(name) && !name.includes('worker'));
    if (!url) throw new Error('MapLibre module unavailable');
    const library = await import(url);
    const prototype = library.Map.prototype;
    const original = prototype.getSource;
    prototype.getSource = function (id: string) {
      if (id === 'ais-history-tracks') {
        Object.assign(globalThis, { tracksTestMap: this });
        prototype.getSource = original;
      }
      return original.call(this, id);
    };
  });
}
test('人工查询冻结条件，独立单船轨迹，样式重载和关闭', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  const fixture = await vesselTracksFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await openLeftPanel(page);
  await page.getByLabel('船舶搜索', { exact: true }).fill('夹具船舶');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByTestId('vessel-result').first().click();
  await selectLeftTab(page, '时间回放');
  await page.getByRole('button', { name: '查询轨迹', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放轨迹', exact: true })).toBeVisible();
  await captureMap(page);
  await openTracks(page);
  await page.getByLabel('船舶信息', { exact: true }).fill('夹具船舶');
  await page.getByLabel('具体型号', { exact: true }).fill('测试型号');
  await page.getByLabel('AIS 船型类别', { exact: true }).selectOption('70');
  await page.getByLabel('AIS 精确船型编码', { exact: true }).fill('71');
  await expect(page.getByLabel('AIS 船型类别', { exact: true })).toHaveValue('');
  await page.getByLabel('AIS 船型类别', { exact: true }).selectOption('70');
  await page.getByRole('button', { name: '生成历史航线', exact: true }).click();
  const legend = page.getByTestId('vessel-tracks-legend');
  await expect(legend).toContainText('海图已展示');
  expect(fixture.requests[0]!.selector).toEqual({
    query: '夹具船舶',
    model: '测试型号',
    shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79],
  });
  const counts = () =>
    page.evaluate(async () => {
      const map = (globalThis as typeof globalThis & { tracksTestMap: import('maplibre-gl').Map })
        .tracksTestMap;
      const read = async (id: string) => {
        const data = await (map.getSource(id) as import('maplibre-gl').GeoJSONSource).getData();
        return data.type === 'FeatureCollection' ? data.features.length : -1;
      };
      return { batch: await read('ais-history-tracks'), single: await read('track') };
    });
  expect(await counts()).toEqual({ batch: 1, single: 1 });
  await page.evaluate(async () => {
    const map = (globalThis as typeof globalThis & { tracksTestMap: import('maplibre-gl').Map })
      .tracksTestMap;
    await new Promise<void>((resolve) => {
      map.once('idle', () => resolve());
      map.setStyle(map.getStyle(), { diff: false });
    });
  });
  expect(await counts()).toEqual({ batch: 1, single: 1 });
  await page.getByRole('button', { name: '放大海图', exact: true }).click();
  expect(fixture.requests).toHaveLength(1);
  await legend.getByRole('button', { name: '关闭历史航线' }).click();
  await expect(legend).toHaveCount(0);
  await expect.poll(counts).toEqual({ batch: 0, single: 1 });
});
test('关闭中途查询后迟到结果不恢复', async ({ page }) => {
  const fixture = await vesselTracksFixture(page);
  fixture.delay();
  await page.goto('/');
  await openTracks(page);
  await page.getByLabel('船舶信息', { exact: true }).fill('123456789');
  await page.getByRole('button', { name: '生成历史航线', exact: true }).click();
  await expect.poll(() => fixture.requests.length).toBe(1);
  await page.getByRole('button', { name: '关闭历史航线', exact: true }).click();
  fixture.release();
  await expect(page.getByRole('button', { name: '生成历史航线', exact: true })).toBeEnabled();
  await expect(page.getByTestId('vessel-tracks-legend')).toHaveCount(0);
});
test('Agent 服务端命令绘制并确认，关闭独立批量层，历史需手动恢复', async ({ page }) => {
  const fixture = await vesselTracksFixture(page);
  await page.goto('/');
  const composer = page.getByTestId('chart-agent-composer');
  await composer.locator('textarea').fill('绘制货船最近一天历史航线');
  await composer.getByRole('button', { name: '发送分析问题' }).click();
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('海图已展示');
  await expect.poll(() => fixture.receipts.at(-1)?.status).toBe('succeeded');
  fixture.issue('close');
  await expect(page.getByTestId('vessel-tracks-legend')).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: '查看任务详情', exact: true }).click();
  await expect(page.getByRole('button', { name: '在海图展示此航线快照' })).toBeVisible();
  await expect(page.getByTestId('vessel-tracks-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '在海图展示此航线快照' }).click();
  await expect(page.getByTestId('vessel-tracks-legend')).toContainText('海图已展示');
});
test('Agent 无可用航线快照时返回 UNAVAILABLE', async ({ page }) => {
  const fixture = await vesselTracksFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await expect.poll(fixture.ready).toBe(true);
  fixture.issue('show');
  await expect.poll(() => fixture.receipts.at(-1)?.error).toBe('UNAVAILABLE');
  await expect(page.getByTestId('vessel-tracks-legend')).toHaveCount(0);
});

test('Agent 等待地图绘制时人工关闭立即终止，迟到绘制回执不恢复', async ({ page }) => {
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
  const fixture = await vesselTracksFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((name) => /\/maplibre[-_]gl.*\.js/.test(name) && !name.includes('worker'));
    if (!url) throw new Error('MapLibre module unavailable');
    const library = await import(url);
    const prototype = library.Map.prototype;
    const original = prototype.isSourceLoaded;
    let delayed = 0;
    let repaint: (() => void) | undefined;
    prototype.isSourceLoaded = function (id: string) {
      if (id === 'ais-history-tracks') {
        delayed++;
        repaint = () => this.triggerRepaint();
        return false;
      }
      return original.call(this, id);
    };
    Object.assign(globalThis, {
      releaseTracksPaint: () => {
        prototype.isSourceLoaded = original;
        repaint?.();
        return delayed;
      },
    });
  });
  const composer = page.getByTestId('chart-agent-composer');
  await composer.locator('textarea').fill('绘制货船最近一天历史航线');
  await composer.getByRole('button', { name: '发送分析问题' }).click();
  const legend = page.getByTestId('vessel-tracks-legend');
  await expect(legend).toContainText('等待地图绘制');
  await expect.poll(() => fixture.receipts.at(-1)?.status).toBe('executing');
  await legend.getByRole('button', { name: '关闭历史航线' }).click();
  await expect.poll(() => fixture.receipts.at(-1)?.error, { timeout: 2000 }).toBe('STATE_CONFLICT');
  const delayed = await page.evaluate(() =>
    (globalThis as typeof globalThis & { releaseTracksPaint: () => number }).releaseTracksPaint(),
  );
  expect(delayed).toBeGreaterThan(0);
  await expect(legend).toHaveCount(0);
});
