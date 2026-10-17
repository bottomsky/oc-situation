import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
const groups: Record<string, string> = {
  数据来源: 'AIS监控',
  分析专题: '智能研判',
  情报公告: '智能研判',
  采集任务: '任务管理',
  运行记录: '任务管理',
  清洗质量: '数据分析',
  归档重放: '数据分析',
  账号权限: '系统设置',
};
export async function openConsolePage(page: Page, label: string) {
  const group = groups[label];
  if (group) await page.getByRole('button', { name: `展开${group}导航`, exact: true }).click();
  const link = page.getByRole('link', { name: label, exact: true });
  const href = await link.getAttribute('href');
  expect(href).toBeTruthy();
  const destination = new URL(href!, page.url()).href;
  await link.click();
  await expect(page).toHaveURL(destination);
  await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
}
export async function openLeftPanel(page: Page) {
  const panel = page.getByTestId('chart-left-panel');
  if (await panel.isVisible()) return;
  await expect(page.getByTestId('chart-workspace')).toBeVisible();
  const toolbarButton = page.getByRole('button', { name: '操作面板', exact: true });
  if (await toolbarButton.isVisible()) {
    const closeRight = page
      .locator('#chart-right-slot')
      .getByRole('button', { name: /^(关闭协同面板|折叠情报详情)$/ });
    if (
      (await page.locator('.chart-drawer-scrim').isVisible()) &&
      !(await panel.isVisible()) &&
      (await closeRight.isVisible())
    )
      await closeRight.click();
    await toolbarButton.click();
  } else await page.getByRole('button', { name: '打开人工操控面板', exact: true }).click();
  await expect(panel).toBeVisible();
}

export async function selectLeftTab(page: Page, name: string) {
  await openLeftPanel(page);
  const panel = page.getByTestId('chart-left-panel');
  const bar = panel.getByTestId('chart-function-tabs');
  await expect(bar).toHaveAttribute('data-ready', 'true');
  const tab = panel.getByRole('tab', { name, exact: true });
  if (await tab.isVisible()) await tab.click();
  else {
    await panel.getByRole('button', { name: '更多功能', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  }
  await expect(tab).toBeVisible();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}
