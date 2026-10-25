import { expect, test, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { agentFixture } from './fixtures/agent-workbench-fixture';
import { chartPoint } from './fixtures/chart-data';
import { selectLeftTab } from './chart-helpers';

const panel = (page: Page) => page.getByTestId('maritime-situation-panel');
async function openSituation(page: Page) {
  await selectLeftTab(page, '海洋态势');
  await expect(panel(page)).toBeVisible();
  return panel(page);
}
async function selectShip(page: Page) {
  await selectLeftTab(page, '船舶搜索');
  await page.getByRole('textbox', { name: '船舶搜索', exact: true }).fill(chartPoint.mmsi);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByTestId('vessel-result').first().click();
  await expect(page.getByTestId('chart-detail-float').filter({ visible: true })).toContainText(
    chartPoint.mmsi,
  );
  await page
    .getByTestId('chart-detail-float')
    .filter({ visible: true })
    .getByRole('button', { name: /关闭/ })
    .first()
    .click();
}
function businessEvent(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    revision: 1,
    title: `人工关注事件 ${index + 1}`,
    summary: '供人工关注集合的已取得事件快照。',
    category: 'security',
    severity: 'unknown',
    occurredAt: null,
    geometry: null,
    linkedMmsis: [],
    linkedRouteIds: [],
    status: 'active',
    primarySourceKey: null,
    sourceSuggestions: {},
    overrides: {},
    mergedInto: null,
    createdAt: '2026-10-25T00:00:00Z',
    updatedAt: '2026-10-25T00:00:00Z',
  };
}
async function businesses(page: Page, count = 2) {
  const records = Array.from({ length: count }, (_, index) => businessEvent(index));
  await page.route('**/api/v1/routes**', (route) =>
    route.fulfill({ json: { items: [], total: 0 } }),
  );
  await page.route('**/api/v1/operational-events**', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-1);
    return route.fulfill({
      json: records.find((item) => item.id === id) ?? { items: records, total: records.length },
    });
  });
  return records;
}

test('海洋态势分钟草稿仅应用后生效，HTTP和WS共用范围并忽略旧帧，年龄移除保持地图实例', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const calls = await chartFixture(page);
  await page.goto('/');
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-ready', 'true');
  const instance = await map.getAttribute('data-map-instance');
  const situation = await openSituation(page);
  await expect(situation.getByTestId('situation-current-age')).toContainText('最近 1天');
  await expect(page.locator('.chart-map-stage .business-selection')).toHaveCount(0);
  await expect.poll(() => calls.viewportMessages.length).toBeGreaterThan(0);
  const previousVersion = calls.viewportMessages.at(-1)!.version;
  await situation.getByRole('button', { name: '15分钟', exact: true }).click();
  await expect(situation.getByText('待应用：最近 15分钟')).toBeVisible();
  expect(calls.mapQueries.at(-1)!.searchParams.get('hours')).toBe('24');
  await situation.getByRole('button', { name: '应用范围', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('0.25');
  await expect.poll(() => calls.viewportMessages.at(-1)?.query.hours).toBe(0.25);
  const version = calls.viewportMessages.at(-1)!.version;
  expect(version).toBeGreaterThan(previousVersion);
  const sendSnapshot = (snapshotId: string, frameVersion: number, count: number) =>
    calls.sendLive({
      type: 'ais.points.snapshot',
      version: frameVersion,
      data: {
        snapshotId,
        sequence: 10,
        items: Array.from({ length: count }, (_, i) => ({
          ...chartPoint,
          mmsi: String(413000001 + i),
        })),
        total: count,
        complete: true,
        nextCursor: null,
        generatedAt: new Date().toISOString(),
        expiresAt: '2099-01-01T00:00:00Z',
      },
    });
  sendSnapshot('current-window', version, 1);
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute('data-loaded', '1');
  sendSnapshot('retired-window', previousVersion, 2);
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute('data-loaded', '1');
  calls.sendLive({
    type: 'ais.points.delta',
    version,
    snapshotId: 'current-window',
    sequence: 11,
    upsert: [],
    remove: [chartPoint.mmsi],
    total: 0,
    generatedAt: new Date().toISOString(),
  });
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute('data-loaded', '0');
  await situation.getByLabel('船位时间范围数值').fill('45');
  await situation.getByLabel('船位时间范围单位').selectOption('minutes');
  await situation.getByRole('button', { name: '应用范围', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('0.75');
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await page.screenshot({ path: test.info().outputPath('situation-desktop-time.png') });
});

test('时间偏好刷新恢复并按账号隔离，非法自定义范围不发请求', async ({ page }) => {
  const calls = await chartFixture(page);
  let owner = 'situation-user-a';
  await page.route('**/api/v1/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: owner, username: owner, role: 'operator' },
        csrfToken: 'csrf',
        expiresAt: '2099-01-01',
      },
    }),
  );
  await page.goto('/');
  const situation = await openSituation(page);
  await situation.getByRole('button', { name: '30分钟', exact: true }).click();
  await situation.getByRole('button', { name: '应用范围', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('0.5');
  calls.mapQueries.length = 0;
  await page.reload();
  await openSituation(page);
  await expect.poll(() => calls.mapQueries.length).toBeGreaterThan(0);
  expect(calls.mapQueries[0]!.searchParams.get('hours')).toBe('0.5');
  owner = 'situation-user-b';
  await page.reload();
  await openSituation(page);
  await expect(situation.getByTestId('situation-current-age')).toContainText('最近 1天');
  await situation.getByRole('button', { name: '3小时', exact: true }).click();
  await situation.getByRole('button', { name: '应用范围', exact: true }).click();
  await expect.poll(() => calls.mapQueries.at(-1)?.searchParams.get('hours')).toBe('3');
  owner = 'situation-user-a';
  await page.reload();
  await openSituation(page);
  await expect(situation.getByTestId('situation-current-age')).toContainText('最近 30分钟');
  await situation.getByLabel('船位时间范围数值').fill('0');
  await expect(situation.getByRole('alert')).toContainText('1 分钟至 30 天');
  await expect(situation.getByRole('button', { name: '应用范围', exact: true })).toBeDisabled();
});

test('人工船舶和业务对象迁入态势面板，调整时间不清关注且AI保留同一引用', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const calls = await agentFixture(page, {
    scriptedTasks: { 检查人工关注: { status: 'completed', reply: '已读取人工关注' } },
  });
  const events = await businesses(page);
  await page.goto('/');
  await selectShip(page);
  const situation = await openSituation(page);
  await situation.getByRole('button', { name: '关注当前船舶', exact: true }).click();
  await expect(situation.getByLabel('人工关注船舶')).toContainText(chartPoint.mmsi);
  await situation.getByRole('button', { name: '添加航线或事件', exact: true }).click();
  await situation.getByLabel('添加关注业务对象').selectOption(`event:${events[0]!.id}`);
  await expect(situation.getByLabel('人工关注业务对象')).toContainText(events[0]!.title);
  await situation.getByRole('button', { name: '15分钟', exact: true }).click();
  await situation.getByRole('button', { name: '应用范围', exact: true }).click();
  await situation
    .getByLabel('人工关注船舶')
    .getByRole('button', { name: '夹具船舶', exact: true })
    .click();
  await expect(page.getByRole('tab', { name: '海洋态势', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
  await expect(detail).toContainText(chartPoint.mmsi);
  await detail.getByRole('button', { name: /关闭/ }).first().click();
  const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
  await input.fill('检查人工关注');
  await input.press('Enter');
  await expect.poll(() => calls.submitted.length).toBe(1);
  expect(calls.submitted[0]!.body.mapContext).toEqual(
    expect.objectContaining({
      hours: 0.25,
      selectedMmsis: [chartPoint.mmsi],
      selectedTargets: [
        { kind: 'vessel', id: chartPoint.mmsi },
        { kind: 'event', id: events[0]!.id, revision: 1 },
      ],
    }),
  );
  await page.screenshot({ path: test.info().outputPath('situation-attention-ai.png') });
  await situation
    .getByRole('button', { name: `移除关注船舶 ${chartPoint.mmsi}`, exact: true })
    .click();
  await expect(situation.getByLabel('人工关注船舶')).toHaveCount(0);
  await expect(situation.getByLabel('人工关注业务对象')).toContainText(events[0]!.title);
  await situation.getByRole('button', { name: '清空关注', exact: true }).click();
  await expect(situation.getByText('暂无人工关注对象')).toBeVisible();
  await expect(page.locator('.chart-map-stage .business-selection')).toHaveCount(0);
});

test('人工关注联合100个对象上限保持明确，移除后可继续加入', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await chartFixture(page);
  const events = await businesses(page, 100);
  await page.goto('/');
  const situation = await openSituation(page);
  await situation.getByRole('button', { name: '添加航线或事件', exact: true }).click();
  const choices = situation.getByLabel('添加关注业务对象');
  for (let index = 0; index < events.length; index++) {
    await choices.selectOption(`event:${events[index]!.id}`);
    await expect(situation.getByLabel('人工关注业务对象').locator('li')).toHaveCount(index + 1);
  }
  await expect(choices).toBeDisabled();
  await expect(situation.getByText('关注集合已满，可先移除部分对象再添加。')).toBeVisible();
  await situation
    .getByRole('button', { name: `移除关注事件 ${events[0]!.title}`, exact: true })
    .click();
  await expect(choices).toBeEnabled();
  await choices.selectOption(`event:${events[0]!.id}`);
  await expect(situation.getByLabel('人工关注业务对象').locator('li')).toHaveCount(100);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1002, height: 650 },
]) {
  test(`海洋态势${viewport.width}窄屏范围和关注操作可滚动访问`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await chartFixture(page);
    await page.goto('/');
    const situation = await openSituation(page);
    await situation.getByRole('button', { name: '30分钟', exact: true }).click();
    const apply = situation.getByRole('button', { name: '应用范围', exact: true });
    await apply.click();
    await expect(situation.getByTestId('situation-current-age')).toContainText('最近 30分钟');
    await situation
      .getByRole('button', { name: '添加航线或事件', exact: true })
      .scrollIntoViewIfNeeded();
    const rect = await situation.boundingBox();
    expect(rect?.width).toBeLessThanOrEqual(viewport.width);
    await page.screenshot({
      path: test.info().outputPath(`situation-narrow-${viewport.width}.png`),
    });
    await expect(page.locator('.chart-map-stage .business-selection')).toHaveCount(0);
  });
}
