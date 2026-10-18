import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
const mapErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  mapErrors.set(page, errors);
  page.on('pageerror', (e) => {
    if (/worker|maplibre/i.test(e.message)) errors.push(e.message);
  });
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /worker failed|worker.*404|worker.*load/i.test(message.text())
    )
      errors.push(message.text());
  });
});
test.afterEach(({ page }) => {
  expect(mapErrors.get(page)).toEqual([]);
});
const initial = {
  id: '00000000-0000-4000-8000-000000000001',
  revision: 1,
  title: '近海船舶异常事件',
  summary: '保留来源摘要',
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
  createdAt: '2026-10-18T00:00:00.000Z',
  updatedAt: '2026-10-18T00:00:00.000Z',
};
async function fixture(page: Page, role = 'operator', conflict = false) {
  await chartFixture(page, { role });
  let record = { ...initial };
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/v1/operational-events**', async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname.replace('/api/v1/operational-events', '');
    if (request.method() !== 'GET') {
      const body = request.postDataJSON();
      writes.push(body);
      if (conflict) {
        await route.fulfill({
          status: 409,
          json: { error: { message: 'Event revision conflict' } },
        });
        return;
      }
      record = { ...record, ...(body.fields ?? body), revision: record.revision + 1 };
    }
    await route.fulfill({
      json: path.endsWith('/history')
        ? { items: [record] }
        : path.endsWith('/sources')
          ? { items: [] }
          : !path && request.method() === 'GET'
            ? { items: [record], total: 1 }
            : record,
    });
  });
  return { writes };
}
test('事件列表、详情、人工覆盖与可信海图跳转', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/events');
  await page.getByRole('button', { name: /处理中 · 待定.*近海船舶异常事件/ }).click();
  await expect(page.getByLabel('事件标题', { exact: true })).toHaveValue(initial.title);
  await page.getByLabel('事件标题', { exact: true }).fill('人工确认事件');
  await page.getByRole('button', { name: '保存事件', exact: true }).click();
  await expect(page.getByRole('heading', { name: '人工确认事件' })).toBeVisible();
  expect(state.writes[0]?.fields).toEqual({ title: '人工确认事件' });
  await expect(page.getByRole('link', { name: '海图定位与分析 ↗' })).toHaveAttribute(
    'href',
    `/?operationalEventId=${initial.id}&askEvent=1`,
  );
});
test('冲突保留草稿及重试操作号', async ({ page }) => {
  const state = await fixture(page, 'operator', true);
  await page.goto('/events');
  await page.getByRole('button', { name: /近海船舶异常事件/ }).click();
  await page.getByLabel('事件标题', { exact: true }).fill('冲突草稿');
  await page.getByRole('button', { name: '保存事件', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('草稿');
  await expect(page.getByLabel('事件标题', { exact: true })).toHaveValue('冲突草稿');
  await page.getByRole('button', { name: '保存事件', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(2);
  expect(state.writes[0]?.operationId).toBe(state.writes[1]?.operationId);
});
test('viewer只读与海图问句预填', async ({ page }) => {
  await fixture(page, 'viewer');
  await page.goto('/events');
  await expect(page.getByRole('button', { name: '＋ 人工创建事件' })).toHaveCount(0);
  await page.getByRole('button', { name: /近海船舶异常事件/ }).click();
  await expect(page.getByLabel('事件标题', { exact: true })).toBeDisabled();
  await page.getByRole('link', { name: '海图定位与分析 ↗' }).click();
  await expect(page.getByLabel('人工关注集合')).toContainText('近海船舶异常事件');
  await expect(page.locator('.composer-input')).toHaveValue('分析这个事件：近海船舶异常事件');
});
test('人工事件地图绘制点线面并保存真实几何', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/events');
  await page.getByRole('button', { name: '＋ 人工创建事件' }).click();
  await page.getByLabel('事件标题', { exact: true }).fill('人工绘制区域');
  const map = page.getByLabel('事件几何编辑').locator('canvas');
  await expect(map).toBeVisible();
  await page.getByRole('button', { name: '绘制点', exact: true }).click();
  await map.click({ position: { x: 180, y: 120 } });
  await expect(page.getByLabel('GeoJSON几何')).toHaveValue(/"Point"/);
  await page.getByRole('button', { name: '绘制线', exact: true }).click();
  await map.click({ position: { x: 180, y: 120 } });
  await map.click({ position: { x: 260, y: 160 } });
  await expect(page.getByLabel('GeoJSON几何')).toHaveValue(/"LineString"/);
  await page.getByRole('button', { name: '绘制面', exact: true }).click();
  await map.click({ position: { x: 180, y: 120 } });
  await map.click({ position: { x: 260, y: 160 } });
  await map.click({ position: { x: 240, y: 210 } });
  await expect(page.getByLabel('GeoJSON几何')).toHaveValue(/"Polygon"/);
  await page.getByRole('button', { name: '保存事件', exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  expect(state.writes[0]?.geometry).toMatchObject({ type: 'Polygon' });
});
