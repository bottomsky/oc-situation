import { test, expect } from '@playwright/test';
import type { AnalysisResult } from '@ais/contracts';

test('真实融合流水线：两个专题产出可追溯结论并定位海图证据', async ({ page }) => {
  test.setTimeout(150000);
  const username = process.env.E2E_USERNAME;
  const password = process.env.E2E_PASSWORD;
  test.skip(!username || !password, '设置 E2E_USERNAME/E2E_PASSWORD 并运行融合 demo');
  await page.goto('/login');
  await page.getByLabel('用户名', { exact: true }).fill(username!);
  await page.getByLabel('密码', { exact: true }).fill(password!);
  await page.getByRole('button', { name: '进入工作空间' }).click();
  await expect(page.getByRole('heading', { name: '全球船位观测' })).toBeVisible();
  let results: AnalysisResult[] = [];
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/v1/analysis/results?limit=100');
        expect(response.ok()).toBeTruthy();
        results = ((await response.json()) as { items: AnalysisResult[] }).items.filter(
          (item) => item.status !== 'withdrawn',
        );
        return [...new Set(results.map((item) => item.definitionId))].sort();
      },
      { timeout: 90000, intervals: [1000, 2000, 5000] },
    )
    .toEqual(['area-low-speed-notice', 'port-restriction']);
  await page.reload();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 20000,
  });
  await expect(page.locator('.map-status')).toContainText(/[1-9][\d,]* 艘船/);
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  for (const definition of ['port-restriction', 'area-low-speed-notice']) {
    const result = results.find((item) => item.definitionId === definition)!;
    await page
      .getByTestId('fusion-events')
      .getByRole('button', { name: result.title, exact: true })
      .first()
      .click();
    const panel = page.getByRole('region', { name: '结论证据' });
    await expect(panel.getByRole('heading', { name: '结论证据', exact: true })).toBeVisible();
    await expect(panel.getByText('样例数据 · 合成观测')).toBeVisible();
    await expect(
      panel.getByText('演示港区通行限制公告（合成数据）', { exact: true }).first(),
    ).toBeVisible();
    await expect(panel.locator('.rule-steps li').first()).toBeVisible();
    await expect(panel.locator('tbody tr').first()).toBeVisible();
    await panel.getByRole('button', { name: '定位海图' }).click();
    await expect(page.getByTestId('evidence-map-legend')).toBeVisible();
    await expect(page.locator('.maplibregl-canvas')).toBeVisible();
    await expect
      .poll(
        async () => {
          const png = (await page.locator('.maplibregl-canvas').screenshot()).toString('base64');
          return page.evaluate(async (encoded) => {
            const image = new Image();
            image.src = 'data:image/png;base64,' + encoded;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d')!;
            context.drawImage(image, 0, 0);
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let evidencePixels = 0;
            let regionPixels = 0;
            for (let i = 0; i < pixels.length; i += 4) {
              const red = pixels[i]!,
                green = pixels[i + 1]!,
                blue = pixels[i + 2]!;
              if (red > 150 && green < 100 && blue < 100) evidencePixels++;
              if (red >= 170 && red <= 185 && green >= 100 && green <= 115 && blue < 55)
                regionPixels++;
            }
            return { evidence: evidencePixels > 20, region: regionPixels > 80 };
          }, png);
        },
        { timeout: 20000, intervals: [500, 1000] },
      )
      .toEqual({ evidence: true, region: true });
    await page.screenshot({ path: `test-results/fusion-live-${definition}.png`, fullPage: true });
    await panel.getByRole('button', { name: '关闭证据' }).click();
  }
});
