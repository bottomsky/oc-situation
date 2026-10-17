import { expect, test } from '@playwright/test';
import { dynamicSkillUiFixture } from './fixtures/dynamic-skill-ui-fixture';

test('热图恢复回执：无快照属于数据不可用，页面绑定和版本保持正常', async ({ page }) => {
  const fixture = await dynamicSkillUiFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);

  const command = fixture.issue('ais_heatmap', 'legacy', false, true);
  await expect
    .poll(() => fixture.receipts.find((item) => item.commandId === command.id && item.error)?.error)
    .toBe('UNAVAILABLE');
  const receipts = fixture.receipts.filter((item) => item.commandId === command.id);
  expect(receipts.map((item) => item.status)).toEqual(['executing', 'failed']);
  expect(receipts[1]).toMatchObject({
    clientId: receipts[0]!.clientId,
    pageGeneration: receipts[0]!.pageGeneration,
  });
  const component = (index: number) =>
    receipts[index]!.state.components.find((item) => item.id === 'chart.heatmap');
  expect(component(1)).toMatchObject({
    version: component(0)!.version,
    mounted: true,
    dirty: false,
    interacting: false,
    loading: false,
    visible: false,
  });
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
});

test('热图恢复回执：新投影等待地图真实绘制，刷新后恢复不误报成功', async ({ page }) => {
  const fixture = await dynamicSkillUiFixture(page);
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(fixture.ready).toBe(true);

  const fresh = fixture.issue('ais_heatmap', 'fresh_query');
  await expect
    .poll(() =>
      fixture.receipts.find((item) => item.commandId === fresh.id && item.status === 'succeeded'),
    )
    .toBeTruthy();
  const receipt = fixture.receipts.find(
    (item) => item.commandId === fresh.id && item.status === 'succeeded',
  )!;
  expect(receipt).toMatchObject({ stepId: fresh.stepId, artifactRef: fresh.artifactRef });
  expect(receipt.state.components.find((item) => item.id === 'chart.heatmap')).toMatchObject({
    visible: true,
    open: true,
    loading: false,
  });
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示 · 全区 3 艘');

  await page.reload();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await expect.poll(fixture.ready).toBe(true);
  const restore = fixture.issue('ais_heatmap', 'legacy', false, true);
  await expect
    .poll(() => fixture.receipts.find((item) => item.commandId === restore.id && item.error)?.error)
    .toBe('UNAVAILABLE');
  expect(
    fixture.receipts.some((item) => item.commandId === restore.id && item.status === 'succeeded'),
  ).toBe(false);
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
});
