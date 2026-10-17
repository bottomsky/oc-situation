import { expect, test, type Page } from '@playwright/test';
import { UiCommandSchema, UiReceiptSchema, UiStateSchema } from '@ais/contracts';
import type { UiCommand, UiReceipt, UiState } from '@ais/contracts';
import { chartFixture } from './fixtures/chart-fixture';
import { chartResult } from './fixtures/chart-data';

async function evidenceUiFixture(page: Page) {
  await chartFixture(page);
  const binding = { clientId: crypto.randomUUID(), pageGeneration: 1 };
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
      state = UiStateSchema.parse(route.request().postDataJSON().state);
      json = binding;
    } else if (path.endsWith('/commands')) json = { items: command ? [command] : [] };
    else if (path.endsWith('/claim')) json = { ...command, claimToken: crypto.randomUUID() };
    else if (path.endsWith('/receipts')) {
      const receipt = UiReceiptSchema.parse(route.request().postDataJSON());
      receipts.push(receipt);
      state = receipt.state;
      if (receipt.status !== 'executing') command = undefined;
    }
    await route.fulfill({ json });
  });
  return {
    component: () => state?.components.find((component) => component.id === 'chart.evidence'),
    receipts,
    close: () => {
      command = UiCommandSchema.parse({
        id: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        ...binding,
        operation: { componentId: 'chart.evidence', action: 'close' },
        expectedVersion: state?.components.find((component) => component.id === 'chart.evidence')
          ?.version,
        status: 'queued',
      });
    },
  };
}

for (const expanded of [false, true])
  test(`Agent close 关闭${expanded ? '放大模态及其' : ''}证据浮层并回执成功`, async ({ page }) => {
    const fixture = await evidenceUiFixture(page);
    await page.goto('/');
    const source = page.getByTestId('chart-right-panel');
    await source.getByRole('tab', { name: /^主动推送/ }).click();
    await source
      .getByTestId('fusion-events')
      .getByRole('button', { name: chartResult.title, exact: true })
      .click();
    const detail = page.getByTestId('chart-detail-float').filter({ visible: true });
    await expect(detail).toHaveAttribute('data-side', 'right');
    if (expanded) {
      await detail.getByRole('button', { name: '放大阅读证据', exact: true }).click();
      await expect(
        page.getByRole('dialog', { name: '结论证据放大阅读', exact: true }),
      ).toBeVisible();
    }
    await expect.poll(() => fixture.component()?.visible).toBe(true);
    fixture.close();
    await expect.poll(() => fixture.receipts.at(-1)?.status).toBe('succeeded');
    expect(fixture.receipts.map((receipt) => receipt.status)).toEqual(['executing', 'succeeded']);
    expect(
      fixture.receipts
        .at(-1)
        ?.state.components.find((component) => component.id === 'chart.evidence')?.visible,
    ).toBe(false);
    await expect(detail).toHaveCount(0);
    await expect(
      page.getByRole('dialog', { name: '结论证据放大阅读', exact: true }),
    ).not.toBeVisible();
    await expect(source.getByTestId('fusion-events')).toBeVisible();
  });
