import { openConsolePage, openLeftPanel } from './chart-helpers';
import { test, expect } from '@playwright/test';
import type { Page as BrowserPage } from '@playwright/test';
const username = process.env.E2E_USERNAME;
const password = process.env.E2E_PASSWORD;
async function loginAs(page: BrowserPage, name: string, secret: string) {
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill(name);
  await page.getByLabel('密码', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '全球船位观测' })).toBeVisible();
}
test('登录、真实样例船位、轨迹和治理页面', async ({ page }) => {
  test.skip(!username || !password, '设置 E2E_USERNAME / E2E_PASSWORD 并先运行真实样例流水线');
  await page.goto('/');
  await page.getByLabel('用户名', { exact: true }).fill(username!);
  await page.getByLabel('密码', { exact: true }).fill(password!);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '全球船位观测' })).toBeVisible();
  await expect(page.getByTestId('sea-map')).toBeVisible();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 15000,
  });
  await expect(page.locator('.map-warning')).toHaveCount(0);
  await openLeftPanel(page);
  await page.getByLabel('船舶搜索', { exact: true }).fill(process.env.E2E_MMSI ?? '413793000');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const vessel = page.getByTestId('vessel-result').first();
  await expect(vessel).toBeVisible();
  await vessel.click();
  await expect(page.getByRole('heading', { name: '船舶详情' })).toBeVisible();
  await expect(page.getByText('样例数据', { exact: true }).first()).toBeVisible();
  await page.getByRole('tab', { name: '时间回放', exact: true }).click();
  await page.getByRole('button', { name: '查询轨迹', exact: true }).click();
  await expect(page.getByTestId('track-summary')).toContainText('点');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.locator('.chart-left .chart-panel-scroll').evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: 'test-results/platform-map.png', fullPage: true });
  for (const [nav, heading] of [
    ['数据来源', '数据来源'],
    ['采集任务', '采集任务'],
    ['运行记录', '运行记录'],
    ['清洗质量', '清洗质量'],
  ] as const) {
    await openConsolePage(page, nav);
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  }
  await page.screenshot({ path: 'test-results/platform-quality.png', fullPage: true });
});
test('只读角色隐藏管理操作并拒绝任务写入', async ({ page }) => {
  test.skip(
    !process.env.E2E_VIEWER_USERNAME || !process.env.E2E_VIEWER_PASSWORD,
    '需要demo只读账号',
  );
  await loginAs(page, process.env.E2E_VIEWER_USERNAME!, process.env.E2E_VIEWER_PASSWORD!);
  await expect(page.getByRole('link', { name: '账号权限' })).toHaveCount(0);
  await openConsolePage(page, '采集任务');
  await expect(page.getByRole('heading', { name: '采集任务', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新增任务' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '运行', exact: true })).toHaveCount(0);
  const status = await page.evaluate(async () => {
    const session = await fetch('/api/v1/auth/me').then((r) => r.json());
    const jobs = await fetch('/api/v1/jobs').then((r) => r.json());
    return (
      await fetch('/api/v1/jobs/' + jobs[0].jobId + '/pause', {
        method: 'POST',
        headers: { 'X-CSRF-Token': session.csrfToken },
      })
    ).status;
  });
  expect(status).toBe(403);
});
test('操作员可控制任务，管理入口按角色隐藏', async ({ page }) => {
  test.skip(
    !process.env.E2E_OPERATOR_USERNAME || !process.env.E2E_OPERATOR_PASSWORD,
    '需要demo操作员账号',
  );
  await loginAs(page, process.env.E2E_OPERATOR_USERNAME!, process.env.E2E_OPERATOR_PASSWORD!);
  await openConsolePage(page, '采集任务');
  await expect(page.getByRole('button', { name: '新增任务' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '运行', exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
  await openConsolePage(page, '数据来源');
  await expect(page.getByRole('button', { name: '新增来源' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '编辑', exact: true })).toHaveCount(0);
});
test('未登录进入治理页跳转登录', async ({ page }) => {
  await page.goto('/jobs');
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: '登录海图' })).toBeVisible();
});
test('网络中断保留已加载地图并提供重试', async ({ page, context }) => {
  test.skip(!username || !password, '需要demo账号');
  await loginAs(page, username!, password!);
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await page.getByRole('button', { name: '暂停更新' }).click();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toBeEnabled();
  await context.setOffline(true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('网络');
  await expect(page.getByTestId('sea-map')).toBeVisible();
  await context.setOffline(false);
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
test('管理员创建样例任务，暂停恢复并由工作进程执行', async ({ page }) => {
  test.skip(!username || !password, '需要demo账号');
  await loginAs(page, username!, password!);
  const fixtureId = await page.evaluate(async () => {
    const sources = await fetch('/api/v1/sources').then((r) => r.json());
    return sources.find(
      (s: { sourceId: string; status: string }) =>
        s.sourceId === 'fixture-http' && s.status === 'enabled',
    )?.sourceId as string | undefined;
  });
  expect(fixtureId).toBeTruthy();
  await openConsolePage(page, '采集任务');
  await page.getByRole('button', { name: '新增任务' }).click();
  const name = 'E2E 样例任务 ' + Date.now();
  await page.getByLabel('任务名称', { exact: true }).fill(name);
  await page.getByLabel('数据来源', { exact: true }).selectOption(fixtureId!);
  await page.getByLabel('初始状态').selectOption('enabled');
  await page.getByLabel('周期运行').uncheck();
  await page.getByRole('button', { name: '保存任务' }).click();
  const row = page.getByRole('row').filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(row).toContainText('已暂停');
  await row.getByRole('button', { name: '恢复', exact: true }).click();
  await expect(row).toContainText('已启用');
  await row.getByRole('button', { name: '运行', exact: true }).click();
  await expect(page.getByRole('heading', { name: '运行详情' })).toBeVisible();
  await expect(
    page.locator('.panel').filter({ has: page.getByRole('heading', { name: '运行详情' }) }),
  ).toContainText('已完成', { timeout: 60000 });
  await openConsolePage(page, '采集任务');
  await page
    .getByRole('row')
    .filter({ hasText: name })
    .getByRole('button', { name: '暂停', exact: true })
    .click();
});
