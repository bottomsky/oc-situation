import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('真实地图渲染四向三角、COG回退与未知圆环，并保持单船选择', async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  const positions = [0, 90, 180, 270, null].map((headingDegrees, i) => ({
    kind: 'point',
    mmsi: String(413000001 + i),
    lon: 120 + i,
    lat: 32,
    headingDegrees: i === 3 ? 511 : headingDegrees,
    cogDegrees: i === 3 ? 270 : null,
    observedAt: '2026-10-01T00:00:00Z',
    sourceId: 'direction-fixture',
    sogKnots: 5,
    quality: [],
  }));
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/auth/me')
      ? {
          user: { id: 'fixture', username: 'fixture', role: 'viewer' },
          csrfToken: '',
          expiresAt: '2099-01-01',
        }
      : path.endsWith('/sources')
        ? []
        : path.endsWith('/map')
          ? {
              items: positions,
              total: 5,
              sampled: false,
              truncated: false,
              generatedAt: '2026-10-01T00:00:00Z',
            }
          : { mmsi: '413000001', latestPosition: positions[0], staticFields: {}, provenance: {} };
    await route.fulfill({ json });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.map-warning')).toHaveCount(0);
  await page.getByRole('button', { name: '暂停更新' }).click();
  const canvas = page.locator('.maplibregl-canvas');
  // Decode an actual WebGL canvas screenshot in the browser; no map test hook or
  // alternate renderer is involved. Each connected teal shape yields its centroid.
  let shapes: { x: number; y: number; dx: number; dy: number }[] = [];
  await expect
    .poll(async () => {
      const png = (await canvas.screenshot()).toString('base64');
      shapes = await page.evaluate(async (png) => {
        const image = new Image();
        image.src = 'data:image/png;base64,' + png;
        await image.decode();
        const c = document.createElement('canvas');
        c.width = image.width;
        c.height = image.height;
        const ctx = c.getContext('2d')!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
        const pending = new Set<number>();
        for (let i = 0; i < c.width * c.height; i++) {
          const red = pixels[i * 4];
          const green = pixels[i * 4 + 1];
          const blue = pixels[i * 4 + 2];
          if (red === undefined || green === undefined || blue === undefined) continue;
          if (red < 170 && green - red > 35 && blue - red > 35 && Math.abs(green - blue) < 15)
            pending.add(i);
        }
        const result = [];
        while (pending.size) {
          const queue = [pending.values().next().value!];
          const xs: number[] = [];
          const ys: number[] = [];
          pending.delete(queue[0]!);
          while (queue.length) {
            const i = queue.pop()!;
            const x = i % c.width;
            const y = Math.floor(i / c.width);
            xs.push(x);
            ys.push(y);
            for (const n of [i - 1, i + 1, i - c.width, i + c.width])
              if (pending.delete(n)) queue.push(n);
          }
          if (xs.length > 12) {
            const minX = Math.min(...xs),
              maxX = Math.max(...xs),
              minY = Math.min(...ys),
              maxY = Math.max(...ys);
            result.push({
              x: (minX + maxX) / 2,
              y: (minY + maxY) / 2,
              dx: xs.reduce((a, b) => a + b, 0) / xs.length - (minX + maxX) / 2,
              dy: ys.reduce((a, b) => a + b, 0) / ys.length - (minY + maxY) / 2,
            });
          }
        }
        return result.sort((a, b) => a.x - b.x);
      }, png);
      return shapes;
    })
    .toHaveLength(5);
  expect(shapes[0]!.dy).toBeGreaterThan(0.6);
  expect(shapes[1]!.dx).toBeLessThan(-0.6);
  expect(shapes[2]!.dy).toBeLessThan(-0.6);
  expect(shapes[3]!.dx).toBeGreaterThan(0.6);
  expect(Math.abs(shapes[4]!.dx)).toBeLessThan(0.5);
  expect(Math.abs(shapes[4]!.dy)).toBeLessThan(0.5);
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + shapes[0]!.x, box!.y + shapes[0]!.y);
  await expect(page.locator('.maplibregl-popup')).toContainText('艏向 0°');
  await page.mouse.move(box!.x + 15, box!.y + 100);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await page.mouse.click(box!.x + shapes[0]!.x, box!.y + shapes[0]!.y);
  await expect(page.locator('.maplibregl-popup')).toContainText('艏向 0°');
  await expect(page.locator('.vessel-detail')).toContainText('艏向 0°');
  await page.mouse.move(box!.x + 15, box!.y + 100);
  await expect(page.locator('.maplibregl-popup')).toHaveCount(0);
  await mkdir('.data/reports', { recursive: true });
  await page
    .getByTestId('sea-map')
    .screenshot({ path: '.data/reports/vessel-direction-markers.png' });
});
