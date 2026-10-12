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
  if (await page.getByTestId('chart-left-panel').isVisible()) return;
  const expand = page.getByRole('button', { name: '展开操作面板', exact: true });
  if (await expand.isVisible()) await expand.click();
  else await page.getByRole('button', { name: '操作面板', exact: true }).click();
  await expect(page.getByTestId('chart-left-panel')).toBeVisible();
}
