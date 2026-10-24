import { test, expect, type Page } from '@playwright/test';
import { chartFixture } from './fixtures/chart-fixture';
import { openLeftPanel } from './chart-helpers';
import { UiCommandSchema, type UiCommand, type UiState, type UiReceipt } from '@ais/contracts';

const names = [
  '船舶搜索',
  '航行预测',
  '情报标绘',
  '图层控制',
  '时间回放',
  '历史航线',
  'AIS 热力图',
];

async function agentPanelFixture(page: Page) {
  await chartFixture(page);
  const binding = { clientId: '00000000-0000-4000-8000-000000000001', pageGeneration: 1 };
  let state: UiState | undefined;
  let command: UiCommand | undefined;
  const receipts: UiReceipt[] = [];
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = { items: [] };
    if (path.endsWith('/config'))
      json = {
        enabled: true,
        uiEnabled: true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/ui/clients')) json = binding;
    else if (path.endsWith('/state')) {
      state = route.request().postDataJSON().state;
      json = binding;
    } else if (path.endsWith('/commands')) json = { items: command ? [command] : [] };
    else if (path.endsWith('/claim')) json = { ...command, claimToken: crypto.randomUUID() };
    else if (path.endsWith('/receipts')) {
      const receipt = route.request().postDataJSON() as UiReceipt;
      receipts.push(receipt);
      state = receipt.state;
      if (receipt.status !== 'executing') command = undefined;
      json = {};
    }
    await route.fulfill({ json });
  });
  return {
    ready: () => !!state,
    receipts,
    issue: (action: 'tab' | 'close') => {
      if (!state) throw new Error('UI 尚未上报状态');
      command = UiCommandSchema.parse({
        id: crypto.randomUUID(),
        taskId: '00000000-0000-4000-8000-000000000002',
        ...binding,
        operation: {
          componentId: 'workspace.left',
          action,
          ...(action === 'tab' ? { tab: 'heatmap' } : {}),
        },
        expectedVersion: state.components.find((component) => component.id === 'workspace.left')!
          .version,
        status: 'queued',
      });
    },
  };
}

async function openPanel(page: Page, width = 1920) {
  await page.setViewportSize({ width, height: 1000 });
  await chartFixture(page);
  await page.goto('/');
  await openLeftPanel(page);
  await expect(page.getByTestId('chart-function-tabs')).toHaveAttribute('data-ready', 'true');
}

test('300px功能栏保留自然宽度，更多菜单向下显示且选中项回到可见栏', async ({ page }) => {
  await openPanel(page);
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  await expect(more).toBeVisible();
  await expect(page.getByTestId('chart-function-tabs')).toHaveAttribute('data-ready', 'true');
  const tabs = page.getByRole('tablist', { name: '操作面板功能' });
  const initialNames = await tabs.getByRole('tab').allTextContents();
  expect(initialNames.map((name) => name.trim())).toEqual(names.slice(0, 3));
  const initialWidths = await tabs
    .getByRole('tab')
    .evaluateAll((elements) =>
      elements.map((element) => ({ width: element.clientWidth, scroll: element.scrollWidth })),
    );
  expect(initialWidths.every((item) => item.width >= item.scroll)).toBe(true);
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAttribute('data-side', 'bottom');
  expect(
    await menu.evaluate((element) => !!element.closest('[data-testid="chart-left-panel"]')),
  ).toBe(false);
  expect(await menu.getByRole('menuitem').allTextContents()).toEqual(names.slice(3));
  await menu.getByRole('menuitem', { name: 'AIS 热力图', exact: true }).click();
  const selected = tabs.getByRole('tab', { name: 'AIS 热力图', exact: true });
  await expect(selected).toHaveAttribute('aria-selected', 'true');
  await expect(selected).toBeFocused();
  await expect(menu).toBeHidden();
  expect((await tabs.getByRole('tab').allTextContents()).map((name) => name.trim())).toEqual([
    '船舶搜索',
    '航行预测',
    'AIS 热力图',
  ]);
});

test('Portal菜单常态、悬停与键盘焦点沿用深色青色主题', async ({ page }) => {
  for (const width of [1091, 782]) {
    await openPanel(page);
    await page.setViewportSize({ width, height: 780 });
    const tabs = page.getByRole('tablist', { name: '操作面板功能' });
    await expect(tabs).toHaveAttribute('data-ready', 'true');
    const more = page.getByRole('button', { name: '更多功能', exact: true });
    await expect(more).toBeInViewport();
    expect(
      await tabs
        .getByRole('tab')
        .evaluateAll((elements) =>
          elements.every((element) => element.clientWidth >= element.scrollWidth),
        ),
    ).toBe(true);
    await more.click();
    const menu = page.getByRole('menu');
    await expect(menu).toHaveCSS('background-color', 'rgb(8, 36, 56)');
    const firstOverflow = menu.getByRole('menuitem').first();
    const heatmap = menu.getByRole('menuitem', { name: 'AIS 热力图', exact: true });
    await expect(heatmap).toHaveCSS('background-color', 'rgb(8, 36, 56)');
    await expect(heatmap).toHaveCSS('color', 'rgb(220, 238, 247)');
    await heatmap.hover();
    await expect(heatmap).toHaveCSS('background-color', 'rgb(18, 91, 134)');
    await expect(heatmap).toHaveCSS('color', 'rgb(230, 248, 255)');
    await expect(heatmap).toHaveCSS('border-color', 'rgb(40, 198, 242)');
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    await more.press('ArrowDown');
    await expect(firstOverflow).toBeFocused();
    await expect(firstOverflow).toHaveCSS('background-color', 'rgb(18, 91, 134)');
    await expect(firstOverflow).toHaveCSS('color', 'rgb(230, 248, 255)');
    await expect(firstOverflow).toHaveCSS('outline-color', 'rgb(40, 198, 242)');
    await expect(firstOverflow).toHaveCSS('outline-style', 'solid');
    await expect(firstOverflow).toHaveCSS('outline-width', '2px');
    await page.screenshot({ path: `.data/panel-menu-dark-${width}.png` });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    const selected = tabs.getByRole('tab', { name: 'AIS 热力图', exact: true });
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect(selected).toBeInViewport();
    await expect(selected).toBeFocused();
    await page.getByRole('button', { name: '设置热图统计条件', exact: true }).click();
    await page.getByLabel('热图统计时段', { exact: true }).selectOption('72');
    await page
      .getByRole('dialog', { name: '热图统计条件设置', exact: true })
      .getByRole('button', { name: '应用', exact: true })
      .click();
    await tabs.getByRole('tab', { name: '船舶搜索', exact: true }).click();
    await more.click();
    await page.getByRole('menuitem', { name: 'AIS 热力图', exact: true }).click();
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '设置热图统计条件', exact: true }).click();
    await expect(page.getByLabel('热图统计时段', { exact: true })).toHaveValue('72');
    await page
      .getByRole('dialog', { name: '热图统计条件设置', exact: true })
      .getByRole('button', { name: '取消', exact: true })
      .click();
  }
});

test('七项功能栏拖动、全容纳与字体宽度变化重新计算', async ({ page }) => {
  await openPanel(page);
  const tabs = page.getByRole('tablist', { name: '操作面板功能' });
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  const handle = page.getByRole('separator', { name: '调整操作面板宽度' });
  await more.click();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 140, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', '440');
  await expect(more).toBeVisible();
  const compactFont = await page.addStyleTag({
    content: '.chart-function-tab { font-size: 9px !important; }',
  });
  await expect(more).toHaveCount(0);
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(tabs.getByRole('tab')).toHaveCount(names.length);
  expect((await tabs.getByRole('tab').allTextContents()).map((name) => name.trim())).toEqual(names);
  await compactFont.evaluate((element) => element.parentNode?.removeChild(element));
  await expect(more).toBeVisible();
  await handle.press('Home');
  await expect(more).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(3);
  const largerFont = await page.addStyleTag({
    content: '.chart-function-tab { font-size: 20px !important; }',
  });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await largerFont.evaluate((element) => element.parentNode?.removeChild(element));
  await expect(tabs.getByRole('tab')).toHaveCount(3);
});

test('键盘、Escape、外部点击和抽屉切换关闭菜单并保留选择', async ({ page }) => {
  await openPanel(page);
  const tabs = page.getByRole('tablist', { name: '操作面板功能' });
  const more = page.getByRole('button', { name: '更多功能', exact: true });
  const search = tabs.getByRole('tab', { name: '船舶搜索', exact: true });
  await search.focus();
  await search.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: '航行预测', exact: true })).toBeFocused();
  await more.focus();
  await more.press('ArrowDown');
  await expect(page.getByRole('menu')).toBeVisible();
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  const heatmap = tabs.getByRole('tab', { name: 'AIS 热力图', exact: true });
  await expect(heatmap).toBeFocused();
  await expect(heatmap).toHaveAttribute('aria-selected', 'true');
  await more.click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(more).toBeFocused();
  await more.click();
  await page.getByRole('heading', { name: '人工操控面板', exact: true }).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await more.click();
  await page.setViewportSize({ width: 768, height: 800 });
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(heatmap).toHaveAttribute('aria-selected', 'true');
  await more.click();
  await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
  await expect(page.getByRole('menu')).toBeHidden();
  await openLeftPanel(page);
  await expect(heatmap).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('menu')).toBeHidden();
});

test('Agent UI命令打开隐藏功能时当前项进入可见栏并关闭更多菜单', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1000 });
  const fixture = await agentPanelFixture(page);
  await page.goto('/');
  await openLeftPanel(page);
  await expect(page.getByTestId('chart-function-tabs')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);
  await expect(page.getByRole('tab', { name: 'AIS 热力图', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  fixture.issue('tab');
  await expect(page.getByRole('tab', { name: 'AIS 热力图', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('menu')).toBeHidden();
  await expect
    .poll(() => fixture.receipts.some((receipt) => receipt.status === 'succeeded'))
    .toBe(true);
  await page.getByRole('button', { name: '更多功能', exact: true }).click();
  fixture.issue('close');
  await expect(page.getByTestId('chart-left-panel')).toBeHidden();
  await expect(page.getByRole('menu')).toBeHidden();
});

test('低高度抽屉中的更多菜单按可用高度滚动', async ({ page }) => {
  await openPanel(page, 768);
  for (const height of [320, 280]) {
    await page.getByRole('tab', { name: '船舶搜索', exact: true }).click();
    await page.setViewportSize({ width: 768, height });
    const more = page.getByRole('button', { name: '更多功能', exact: true });
    if (height === 320) await more.click();
    else {
      await more.focus();
      await more.press('ArrowDown');
    }
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('data-side', 'bottom');
    const viewport = menu.locator('[data-slot="viewport"]');
    expect(await viewport.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    const menuBox = (await menu.boundingBox())!;
    const triggerBox = (await more.boundingBox())!;
    expect(menuBox.y).toBeGreaterThanOrEqual(triggerBox.y + triggerBox.height);
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(height);
    const firstItem = menu.getByRole('menuitem').first();
    const rowHeight = (await firstItem.boundingBox())!.height;
    const visibleHeight = await viewport.evaluate((element) => element.clientHeight);
    if (height === 320) {
      expect(visibleHeight).toBeGreaterThanOrEqual(rowHeight);
      await viewport.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      await menu.getByRole('menuitem', { name: 'AIS 热力图', exact: true }).click();
    } else {
      expect(visibleHeight).toBeGreaterThan(0);
      expect(visibleHeight).toBeLessThan(rowHeight);
      await expect(firstItem).toBeFocused();
      await page.keyboard.press('End');
      await expect(menu.getByRole('menuitem', { name: 'AIS 热力图', exact: true })).toBeFocused();
      await page.keyboard.press('Enter');
    }
    const selected = page.getByRole('tab', { name: 'AIS 热力图', exact: true });
    await expect(selected).toHaveAttribute('aria-selected', 'true');
    await expect(selected).toBeFocused();
  }
});
