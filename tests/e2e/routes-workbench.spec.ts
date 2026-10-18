import { test, expect, type Page } from '@playwright/test';
import type { Route } from '@ais/contracts';
import { chartFixture } from './fixtures/chart-fixture';
async function fixture(page: Page, role = 'admin') {
  page.on('pageerror', (e) => console.error('ROUTE_PAGE_ERROR', e.message));
  await chartFixture(page, { role });
  const records: Route[] = [];
  const writes: Record<string, unknown>[] = [];
  await page.route('**/api/v1/routes**', async (request) => {
    const url = new URL(request.request().url()),
      method = request.request().method();
    const path = url.pathname.replace('/api/v1/routes', '');
    const body = method === 'GET' ? {} : request.request().postDataJSON();
    let json: unknown;
    if (method !== 'GET') writes.push(body);
    if (path === '/restrictions') json = { items: [] };
    else if (path === '/plans')
      json = {
        id: crypto.randomUUID(),
        status: 'failed',
        input: body,
        result: null,
        error: 'endpoint_on_land',
        datasetVersion: 'osm-test',
        restrictionVersion: 2,
        stale: false,
      };
    else if (!path && method === 'GET')
      json = {
        items: records.filter(
          (r) =>
            !url.searchParams.get('search') || r.name.includes(url.searchParams.get('search')!),
        ),
        total: records.length,
      };
    else if (!path && method === 'POST') {
      const record: Route = {
        ...body,
        id: crypto.randomUUID(),
        revision: 1,
        generatedBy: 'manual',
        planId: null,
        lengthMeters: 12000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      delete (record as unknown as Record<string, unknown>).operationId;
      records.unshift(record);
      json = record;
    } else {
      const id = path.split('/')[1],
        record = records.find((r) => r.id === id)!;
      if (path.endsWith('/history')) json = { items: [record] };
      else if (path.endsWith('/copy')) {
        json = {
          ...record,
          id: crypto.randomUUID(),
          name: body.name,
          status: 'draft',
          revision: 1,
        };
        records.unshift(json as Route);
      } else if (path.endsWith('/archive')) {
        record.status = 'archived';
        record.revision++;
        json = record;
      } else json = record;
    }
    await request.fulfill({ json });
  });
  return { records, writes };
}
test('海图绘制保存、筛选、详情、复制归档与规划错误', async ({ page }) => {
  const state = await fixture(page);
  await page.goto('/routes');
  await expect(page.getByRole('heading', { name: '计划航线工作台' })).toBeVisible({
    timeout: 60000,
  });
  await page.getByLabel('航线名称', { exact: true }).fill('东海计划航线');
  const map = page.getByLabel('航线绘制海图');
  await expect(map.locator('canvas')).toBeVisible();
  await map.click({ position: { x: 260, y: 220 } });
  await map.click({ position: { x: 340, y: 280 } });
  await expect(page.getByLabel('航点2经度')).toBeVisible();
  await page.getByRole('button', { name: '保存航线', exact: true }).click();
  await expect(page.getByText('东海计划航线', { exact: true })).toBeVisible();
  expect(state.records).toHaveLength(1);
  expect(state.writes[0]).toHaveProperty('operationId');
  await page.getByLabel('搜索航线').fill('东海');
  await page.getByRole('button', { name: '查询航线' }).click();
  await page.getByText(/详情与修订历史/).click();
  await expect(page.getByText('来源 manual', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '复制为独立方案' }).click();
  await expect(page.getByLabel('航线名称', { exact: true })).toHaveValue('东海计划航线 · 副本');
  await page.getByRole('button', { name: '规划航路', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('陆地');
  await page.getByRole('button', { name: '归档航线', exact: true }).click();
  await expect(page.getByLabel('航线状态')).toHaveValue('archived');
});
test('viewer 可浏览且所有写入入口禁用', async ({ page }) => {
  const state = await fixture(page, 'viewer');
  await page.goto('/routes');
  await expect(page.getByText('当前账号为只读权限，可查询、对照和导出航线。')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存航线', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '新建禁行区' })).toBeDisabled();
  expect(state.writes).toHaveLength(0);
});
