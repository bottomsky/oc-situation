import { expect, test } from '@playwright/test';
import type { AgentVesselHighlightsResult, MapCameraRequest } from '@ais/contracts';
import { dynamicSkillUiFixture } from './fixtures/dynamic-skill-ui-fixture';

const highlights: AgentVesselHighlightsResult = {
  kind: 'vessel_highlights',
  version: 1,
  inputRevision: 1,
  operation: 'show',
  vessels: [
    {
      mmsi: '413793000',
      name: '高亮测试船',
      lon: 122,
      lat: 32,
      observedAt: '2026-10-17T10:00:00Z',
    },
  ],
  missingMmsis: [],
};

test('低缩放聚合下独立高亮，任务引用隔离，热图与航线仍能确认绘制', async ({ page }) => {
  const fixture = await dynamicSkillUiFixture(page, { clusters: true });
  await page.route('**/api/v1/vessels/positions?*', (route) =>
    route.fulfill({
      json: { items: [{ ...highlights.vessels[0], lon: 122.01 }], missing: [] },
    }),
  );
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);
  await expect
    .poll(() => fixture.state()?.components.some((item) => item.id === 'chart.vessel-highlights'))
    .toBe(true);

  async function finished(id: string) {
    await expect
      .poll(
        () =>
          fixture.receipts.find((item) => item.commandId === id && item.status !== 'executing')
            ?.status,
      )
      .toBe('succeeded');
  }
  const first = fixture.issueMap(highlights);
  await finished(first.id);
  await expect(page.getByTestId('vessel-highlights-control')).toContainText('船舶高亮 · 1 艘');
  const second = fixture.issueMap(highlights);
  await finished(second.id);
  const component = () =>
    fixture.state()?.components.find((item) => item.id === 'chart.vessel-highlights');
  expect(component()?.highlightGroups?.map((item) => item.groupId)).toEqual([
    first.artifactRef,
    second.artifactRef,
  ]);

  const heatmap = fixture.issue('ais_heatmap', 'with_ripples');
  await finished(heatmap.id);
  const tracks = fixture.issue('vessel_tracks', 'with_ripples');
  await finished(tracks.id);

  const clearOne = fixture.issueMap({
    ...highlights,
    operation: 'clear',
    vessels: [],
    clear: { mode: 'groups', groupIds: [first.artifactRef!] },
  });
  await finished(clearOne.id);
  expect(component()?.highlightGroups?.map((item) => item.groupId)).toEqual([second.artifactRef]);
  expect(component()?.visible).toBe(true);

  const clearAll = fixture.issueMap({
    ...highlights,
    operation: 'clear',
    vessels: [],
    clear: { mode: 'all' },
  });
  await finished(clearAll.id);
  expect(component()?.highlightGroups).toEqual([]);
  expect(component()?.visible).toBe(false);
  await expect(page.getByTestId('vessel-highlights-control')).toHaveCount(0);
});

test('镜头无已选船舶时可聚焦坐标、调整缩放并返回真实位置', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const fixture = await dynamicSkillUiFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);

  async function camera(request: MapCameraRequest) {
    const command = fixture.issueMap({
      kind: 'map_camera',
      version: 1,
      inputRevision: 1,
      request,
    });
    await expect
      .poll(
        () =>
          fixture.receipts.find(
            (item) => item.commandId === command.id && item.status !== 'executing',
          )?.status,
      )
      .toBe('succeeded');
    const receipt = fixture.receipts.find(
      (item) => item.commandId === command.id && item.status === 'succeeded',
    )!;
    const evidence = receipt.state.components.find(
      (item) => item.id === 'chart.viewport',
    )?.cameraEvidence;
    expect(evidence?.commandId).toBe(command.id);
    return evidence!;
  }
  const point = await camera({ mode: 'point', center: [122, 32], zoom: 7 });
  expect(point.zoom).toBeCloseTo(7, 1);
  expect(point.bbox[1]).toBeLessThan(32);
  expect(point.bbox[3]).toBeGreaterThan(32);
  const relative = await camera({ mode: 'current', zoomDelta: 1 });
  expect(relative.zoom).toBeCloseTo(8, 1);
  await camera({ mode: 'bounds', bbox: [179, 10, -179, 12], maxZoom: 8 });
});

test('百船高亮持续刷新，人工清除与刷新页面释放本页效果', async ({ page }, testInfo) => {
  const fixture = await dynamicSkillUiFixture(page, { clusters: true });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  const vessels = Array.from({ length: 100 }, (_, index) => ({
    ...highlights.vessels[0]!,
    mmsi: String(413000001 + index),
    name: `关注船舶 ${index + 1}`,
    lon: 120 + (index % 10) * 0.2,
    lat: 30 + Math.floor(index / 10) * 0.2,
  }));
  let refreshes = 0;
  await page.route('**/api/v1/vessels/positions?*', async (route) => {
    refreshes++;
    expect(new URL(route.request().url()).searchParams.get('mmsis')!.split(',')).toHaveLength(100);
    await route.fulfill({
      json: {
        items: vessels.map(({ mmsi, lon, lat }) => ({
          mmsi,
          lon: lon + 0.01 * refreshes,
          lat,
          observedAt: '2026-10-17T11:00:00Z',
        })),
        missing: [],
      },
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);
  const camera = fixture.issueMap({
    kind: 'map_camera',
    version: 1,
    inputRevision: 1,
    request: { mode: 'bounds', bbox: [119, 29, 123, 33], maxZoom: 8 },
  });
  await expect
    .poll(() => fixture.receipts.find((r) => r.commandId === camera.id && r.status === 'succeeded'))
    .toBeTruthy();
  const command = fixture.issueMap({ ...highlights, vessels });
  await expect
    .poll(() =>
      fixture.receipts.find((r) => r.commandId === command.id && r.status === 'succeeded'),
    )
    .toBeTruthy();
  const control = page.getByTestId('vessel-highlights-control');
  await expect(control).toContainText('100 艘');
  const summaryBox = await control.locator('summary').boundingBox();
  const panelButtonBox = await page.getByRole('button', { name: '打开人工操控面板' }).boundingBox();
  expect(summaryBox!.y).toBeGreaterThanOrEqual(panelButtonBox!.y + panelButtonBox!.height);
  await expect.poll(() => refreshes, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await page
    .getByTestId('sea-map')
    .screenshot({ path: testInfo.outputPath('hundred-vessel-ripples.png') });
  await control.locator('summary').click();
  await page.getByTestId('vessel-highlights-clear-all').click();
  await expect(control).toHaveCount(0);
  await expect
    .poll(
      () =>
        fixture.state()?.components.find((c) => c.id === 'chart.vessel-highlights')
          ?.highlightGroups,
    )
    .toEqual([]);

  const second = fixture.issueMap(highlights);
  await expect
    .poll(() => fixture.receipts.find((r) => r.commandId === second.id && r.status === 'succeeded'))
    .toBeTruthy();
  await page.reload();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(control).toHaveCount(0);
  expect(failures).toEqual([]);
});

test('手工拖动中断镜头，迟到结束事件不会报告成功', async ({ page }) => {
  const fixture = await dynamicSkillUiFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);
  const command = fixture.issueMap({
    kind: 'map_camera',
    version: 1,
    inputRevision: 1,
    request: { mode: 'point', center: [-74, 40], zoom: 7 },
  });
  await expect
    .poll(
      () => fixture.receipts.some((r) => r.commandId === command.id && r.status === 'executing'),
      { intervals: [10, 20, 50] },
    )
    .toBe(true);
  const canvas = await page.locator('.maplibregl-canvas').boundingBox();
  const x = canvas!.x + canvas!.width * 0.35;
  const y = canvas!.y + canvas!.height * 0.5;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      () =>
        fixture.receipts.find((r) => r.commandId === command.id && r.status !== 'executing')
          ?.status,
    )
    .toBe('failed');
  expect(fixture.receipts.some((r) => r.commandId === command.id && r.status === 'succeeded')).toBe(
    false,
  );
  expect(
    fixture.receipts.find((r) => r.commandId === command.id && r.status === 'failed')?.error,
  ).toBe('STATE_CONFLICT');
});
