import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';

const activeId = '11111111-1111-4111-8111-111111111111';
const candidateId = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-18T00:00:00Z';
async function memoryFixture(page: Page, options: { conflict?: boolean; disabled?: boolean } = {}) {
  await chartFixture(page, { role: 'viewer' });
  let revision = 2;
  let readEnabled = true;
  let proposalsEnabled = true;
  let settingsRevision = 0;
  let conflict = !!options.conflict;
  let entries = [
    {
      id: activeId,
      category: '偏好',
      key: '报告语言',
      value: '使用中文并保留船舶标识',
      status: 'active',
      source: { description: '账号手动维护' },
      revision: 1,
      createdAt: at,
      updatedAt: at,
      expiresAt: null,
    },
    {
      id: candidateId,
      category: '偏好',
      key: '重点海域',
      value: '优先查看渤海',
      status: 'proposed',
      source: { description: '区域研判候选', taskId: activeId },
      revision: 2,
      createdAt: at,
      updatedAt: at,
      expiresAt: null,
    },
  ];
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  await page.route('**/api/v1/agent/memories**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const settings = () => ({
      revision: settingsRevision,
      generation: 0,
      readEnabled,
      proposalsEnabled,
      features: { session: true, account: !options.disabled, proposals: true },
    });
    if (method === 'GET') {
      await route.fulfill({
        json: path.endsWith('/settings') ? settings() : { revision, entries },
      });
      return;
    }
    const body = route.request().postDataJSON() as Record<string, unknown>;
    writes.push({ path, body });
    if (conflict) {
      conflict = false;
      revision++;
      await route.fulfill({ status: 409, json: { error: { message: '记忆已改变' } } });
      return;
    }
    if (path.endsWith('/settings')) {
      readEnabled = body.readEnabled as boolean;
      proposalsEnabled = body.proposalsEnabled as boolean;
      settingsRevision++;
      await route.fulfill({ json: settings() });
      return;
    }
    if (path.endsWith('/confirm'))
      entries = entries.map((entry) =>
        entry.id === candidateId ? { ...entry, status: 'active' } : entry,
      );
    else if (path.endsWith('/dismiss'))
      entries = entries.filter((entry) => entry.id !== candidateId);
    else if (method === 'DELETE')
      entries = path.endsWith('/memories')
        ? []
        : entries.filter((entry) => !path.endsWith(entry.id));
    else if (method === 'PUT')
      entries = entries.map((entry) =>
        path.endsWith(entry.id)
          ? {
              ...entry,
              key: String(body.key),
              value: String(body.value),
              category: String(body.category),
            }
          : entry,
      );
    else
      entries.push({
        ...entries[0]!,
        id: '33333333-3333-4333-8333-333333333333',
        category: String(body.category),
        key: String(body.key),
        value: String(body.value),
        status: 'active',
      });
    revision++;
    await route.fulfill({ json: { revision, entries } });
  });
  return { writes };
}

test('个人记忆页面支持viewer创建编辑、检索、确认候选、暂停与清空', async ({ page }) => {
  const fixture = await memoryFixture(page);
  await page.goto('/memories');
  await expect(page.getByRole('heading', { name: '我的记忆', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '新建记忆', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('常用船型');
  await page.getByLabel('内容', { exact: true }).fill('优先关注货船');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(page.getByRole('heading', { name: '常用船型', exact: true })).toBeVisible();
  const card = page
    .locator('article')
    .filter({ has: page.getByRole('heading', { name: '常用船型' }) });
  await card.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByLabel('内容', { exact: true }).fill('优先关注货船与油轮');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(page.getByText('优先关注货船与油轮', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /待确认候选/ }).click();
  await expect(page.getByText('区域研判候选', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '确认记住', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重点海域', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /正式记忆/ }).click();
  await page.getByLabel('检索我的记忆').fill('渤海');
  await expect(page.getByRole('heading', { name: '重点海域', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '报告语言', exact: true })).toHaveCount(0);
  await page.getByLabel('检索我的记忆').fill('');
  await page.getByLabel('自动提取候选', { exact: true }).uncheck();
  await expect(page.getByLabel('自动提取候选', { exact: true })).not.toBeChecked();
  expect(fixture.writes.at(-1)?.body).toMatchObject({ proposalsEnabled: false, readEnabled: true });
  await page.screenshot({ path: '.data/agent-memory-browser/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.data/agent-memory-browser/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: '清空全部', exact: true }).click();
  await page.getByRole('button', { name: '确认遗忘', exact: true }).click();
  await expect(page.locator('article')).toHaveCount(0);
});

test('并发冲突保留草稿，刷新后带新revision保存', async ({ page }) => {
  const fixture = await memoryFixture(page, { conflict: true });
  await page.goto('/memories');
  await page.getByRole('button', { name: '新建记忆', exact: true }).click();
  await page.getByLabel('名称', { exact: true }).fill('关注对象');
  await page.getByLabel('内容', { exact: true }).fill('货船');
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(page.getByText(/记忆已在其他窗口更新/)).toBeVisible();
  await expect(page.getByLabel('内容', { exact: true })).toHaveValue('货船');
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('button', { name: '保存记忆', exact: true }).click();
  await expect(page.getByRole('heading', { name: '关注对象', exact: true })).toBeVisible();
  expect(fixture.writes.map((write) => write.body.expectedRevision)).toEqual([2, 3]);
});

test('系统暂停时保留读取与遗忘，候选可拒绝', async ({ page }) => {
  await memoryFixture(page, { disabled: true });
  await page.goto('/memories');
  await expect(page.getByRole('button', { name: '新建记忆', exact: true })).toBeDisabled();
  await expect(
    page.getByText('系统已暂停账号记忆使用，现有记录可继续查看、删除和清空。'),
  ).toBeVisible();
  await page.getByRole('tab', { name: /待确认候选/ }).click();
  await expect(page.getByRole('button', { name: '确认记住', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '拒绝候选', exact: true }).click();
  await expect(page.getByRole('heading', { name: '重点海域', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: /正式记忆/ }).click();
  await page.getByRole('button', { name: '遗忘', exact: true }).click();
  await page.getByRole('button', { name: '确认遗忘', exact: true }).click();
  await expect(page.getByRole('heading', { name: '报告语言', exact: true })).toHaveCount(0);
});
