import { configureOnlineChart } from './fixtures/online-chart-fixture';
import { test, expect, type Page } from '@playwright/test';
import { openLeftPanel, selectLeftTab } from './chart-helpers';
async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill(username);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
}
test.beforeEach(async ({ page }) => {
  await configureOnlineChart(page);
});

test('真实 API 情报、对象关联、单海图绘制和按用户恢复标绘', async ({ page }) => {
  test.skip(
    !process.env.E2E_USERNAME ||
      !process.env.E2E_PASSWORD ||
      !process.env.E2E_OPERATOR_USERNAME ||
      !process.env.E2E_OPERATOR_PASSWORD,
    '需要真实演示管理员与操作员账号',
  );
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1920, height: 1000 });
  await login(page, process.env.E2E_USERNAME!, process.env.E2E_PASSWORD!);
  const admin = await (await page.request.get('/api/v1/auth/me')).json();
  const key = 'real-' + Date.now();
  let response = await page.request.post('/api/v1/intelligence/sources', {
    headers: { 'X-CSRF-Token': admin.csrfToken, Origin: 'http://127.0.0.1:13001' },
    data: { sourceId: key, name: '真实闭环手工来源', kind: 'manual', enabled: true },
  });
  expect(response.ok()).toBeTruthy();
  await page.request.post('/api/v1/auth/logout', {
    headers: { 'X-CSRF-Token': admin.csrfToken, Origin: 'http://127.0.0.1:13001' },
  });
  await login(page, process.env.E2E_OPERATOR_USERNAME!, process.env.E2E_OPERATOR_PASSWORD!);
  const session = await (await page.request.get('/api/v1/auth/me')).json();
  const headers = { 'X-CSRF-Token': session.csrfToken, Origin: 'http://127.0.0.1:13001' };
  response = await page.request.post('/api/v1/intelligence/objects', {
    headers,
    data: {
      kind: 'port',
      name: '闭环测试港口 ' + key,
      aliases: ['闭环港'],
      geometry: { type: 'Point', coordinates: [122, 31] },
      metadata: { testRun: key },
    },
  });
  expect(response.ok()).toBeTruthy();
  const object = await response.json();
  const now = new Date().toISOString();
  response = await page.request.post('/api/v1/intelligence/events', {
    headers: { ...headers, 'Idempotency-Key': key },
    data: {
      sourceId: key,
      externalId: key,
      version: 1,
      status: 'active',
      category: 'notice',
      reviewStatus: 'confirmed',
      title: '真实闭环公告 ' + key,
      summary: '通过原文与港口目录验证关系标绘',
      publishedAt: now,
      effectiveFrom: now,
      effectiveTo: null,
      paragraphs: [{ id: 'p1', text: '测试港口临时调整通航。' }],
      raw: { testRun: key, manualTimeConfirmed: true },
    },
  });
  expect(response.ok()).toBeTruthy();
  const event = await response.json();
  response = await page.request.post('/api/v1/intelligence/events/' + event.id + '/relations', {
    headers,
    data: {
      kind: 'occurs-at',
      objectId: object.id,
      basis: '原文 p1 明确港口地点',
      paragraphIds: ['p1'],
      reviewStatus: 'confirmed',
      origin: 'manual',
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto('/?eventId=' + event.id);
  await expect(page.getByRole('heading', { name: event.title, exact: true })).toBeVisible();
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  await expect(page.getByText('当前标绘集合')).toBeVisible();
  await expect
    .poll(async () =>
      (
        (await (await page.request.get('/api/v1/intelligence/plot-set')).json())
          .eventIds as string[]
      ).includes(event.id),
    )
    .toBe(true);
  const map = page.getByTestId('sea-map');
  await expect(map).toHaveAttribute('data-map-initializations', '1');
  const instance = await map.getAttribute('data-map-instance');
  await page.getByRole('button', { name: '绘制点', exact: true }).click();
  const bounds = (await map.boundingBox())!;
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(page.getByRole('textbox', { name: 'GeoJSON 几何' })).toHaveValue(/Point/);
  await page
    .getByRole('textbox', { name: '认定依据' })
    .fill('操作员在海图绘制位置，待核实原文关联');
  await page.getByRole('button', { name: '保存关联', exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          (await (await page.request.get('/api/v1/intelligence/events/' + event.id)).json())
            .relations as unknown[]
        ).length,
    )
    .toBe(2);
  await expect(map).toHaveAttribute('data-map-instance', instance!);
  await page.reload();
  await openLeftPanel(page);
  await selectLeftTab(page, '情报标绘');
  await expect(page.getByText(event.title, { exact: true }).first()).toBeVisible();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-map-initializations', '1');
  await page.screenshot({ path: 'test-results/intelligence-real-map.png', fullPage: true });
  expect(errors).toEqual([]);
  if (process.env.E2E_VIEWER_USERNAME && process.env.E2E_VIEWER_PASSWORD) {
    await page.request.post('/api/v1/auth/logout', { headers });
    await login(page, process.env.E2E_VIEWER_USERNAME, process.env.E2E_VIEWER_PASSWORD);
    const viewer = await (await page.request.get('/api/v1/auth/me')).json();
    response = await page.request.post('/api/v1/intelligence/events/' + event.id + '/review', {
      headers: { 'X-CSRF-Token': viewer.csrfToken, Origin: 'http://127.0.0.1:13001' },
      data: { reviewStatus: 'confirmed' },
    });
    expect(response.status()).toBe(403);
  }
});
