import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Uses the running local demo, real API/database/worker and a separate authenticated browser.
// Credentials never enter output; only reversible UI operations and test conversations are created.
const origin = 'http://127.0.0.1:13001';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.data/playwright');
const { chromium } = await import('playwright');
const { expect } = await import('@playwright/test');
const credentials = JSON.parse(await readFile('.data/demo-admin.json', 'utf8')) as {
  username: string;
  password: string;
};
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
const output = '.data/agent-ui-verification';
await mkdir(output, { recursive: true });
const checks: { goal: string; taskId: string; status: string; summary: string }[] = [];
const adjustments: { taskId: string; reason: string; historyHours: number }[] = [];
try {
  await page.goto(`${origin}/login`);
  await page.getByLabel('用户名', { exact: true }).fill(credentials.username);
  await page.getByLabel('密码', { exact: true }).fill(credentials.password);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 60000,
  });
  const config = await (await context.request.get(`${origin}/api/v1/agent/config`)).json();
  assert.ok(config.enabled && config.uiEnabled);
  async function send(goal: string) {
    const pending = page.waitForResponse(
      (r) => r.url().endsWith('/messages') && r.request().method() === 'POST',
    );
    await page.getByLabel('分析问题或继续追问', { exact: true }).fill(goal);
    await page.getByRole('button', { name: '发送分析问题', exact: true }).click();
    const response = await pending;
    assert.equal(response.status(), 202, await response.text());
    const submitted = await response.json();
    let result: {
      task: { id: string; status: string; summary: string; error: string };
      pendingInputRequests: { reason: string }[];
    };
    const terminal = () =>
      expect
        .poll(
          async () => {
            result = await (
              await context.request.get(`${origin}/api/v1/agent/tasks/${submitted.task.id}`)
            ).json();
            return result.task.status;
          },
          { timeout: 45000, intervals: [500, 1000, 2000] },
        )
        .toMatch(/completed|failed|awaiting_input/);
    await terminal();
    if (
      goal.startsWith('生成') &&
      result!.task.status === 'awaiting_input' &&
      result!.pendingInputRequests.some((request) => request.reason === 'data_limit')
    ) {
      const dialog = page.getByRole('dialog', { name: '补充任务条件', exact: true });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('分析时间范围', { exact: true }).selectOption('1');
      const answered = page.waitForResponse(
        (response) =>
          response.url().includes('/responses') && response.request().method() === 'POST',
      );
      await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
      assert.ok((await answered).ok());
      adjustments.push({ taskId: submitted.task.id, reason: 'data_limit', historyHours: 1 });
      console.log('24 小时查询超限，通过条件弹窗缩短为 1 小时并续作原任务');
      await terminal();
    }
    assert.equal(result!.task.status, 'completed', result!.task.summary ?? result!.task.error);
    checks.push({
      goal,
      taskId: submitted.task.id,
      status: result!.task.status,
      summary: result!.task.summary,
    });
    console.log(`${goal}: ${result!.task.status}`);
  }
  await send('当前界面打开了哪些窗口');
  await send('打开人工操控面板');
  await expect(page.locator('.chart-left-slot, #chart-left-slot').first()).toBeVisible();
  await page.getByRole('tab', { name: 'AIS 热力图' }).click();
  // Keep the manual fixture bounded as the real AIS store grows between runs.
  // The agent query below still exercises the 24-hour request and structured limit recovery.
  await page.getByLabel('热图统计时段', { exact: true }).selectOption('custom');
  const beijingInput = (time: number) => new Date(time + 8 * 3600000).toISOString().slice(0, 16);
  await page.getByLabel('热图开始时间', { exact: true }).fill(beijingInput(Date.now() - 3600000));
  await page.getByLabel('热图结束时间', { exact: true }).fill(beijingInput(Date.now()));
  await page.getByRole('button', { name: '生成热力图', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示', { timeout: 30000 });
  await send('关闭热力图');
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await send('关闭热力图');
  await send('恢复上次热力图');
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示', { timeout: 15000 });
  await send('关闭人工操控面板');
  await expect(page.getByRole('button', { name: '打开人工操控面板', exact: true })).toBeVisible();
  await send('生成当前视野最近24小时热力图');
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示', { timeout: 15000 });
  await send('关闭热力图');
  const second = await context.newPage();
  await second.goto(origin);
  await expect(second.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await second.getByRole('button', { name: '打开人工操控面板', exact: true }).click();
  await send('关闭人工操控面板');
  await expect(second.locator('.chart-left-slot, #chart-left-slot').first()).toBeVisible();
  await second.close();
  await send('打开人工操控面板');
  await page.getByRole('tab', { name: '情报标绘', exact: true }).click();
  await page.getByLabel('情报关键词', { exact: true }).fill('未提交的人工检索草稿');
  await send('关闭人工操控面板');
  await send('打开人工操控面板');
  await expect(page.getByLabel('情报关键词', { exact: true })).toHaveValue('未提交的人工检索草稿');
  console.log('收起和重新打开保留人工草稿: passed');
  for (const route of [
    '/sources',
    '/jobs',
    '/users',
    '/topics',
    '/intelligence',
    '/runs',
    '/quality',
    '/replays',
  ]) {
    const published = page.waitForRequest(
      (req) =>
        req.url().endsWith('/state') &&
        req.method() === 'PUT' &&
        req.postDataJSON()?.state?.route === route,
    );
    await page.goto(origin + route);
    const request = await published;
    assert.ok(
      request.postDataJSON().state.components.some((c: { id: string }) => c.id === 'page.list'),
    );
    console.log(`页面状态 ${route}: passed`);
  }
  await page.goto(origin);
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45000,
  });
  await page.screenshot({ path: resolve(output, 'completed.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(output, 'results.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        realApi: true,
        realWorker: true,
        mocked: false,
        checks,
        adjustments,
        errors,
      },
      null,
      2,
    ),
  );
} catch (e) {
  await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(
    resolve(output, 'failure.json'),
    JSON.stringify({ checks, errors, message: String(e), url: page.url() }, null, 2),
  );
  throw e;
} finally {
  await browser.close();
}
