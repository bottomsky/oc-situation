import { chartFixture } from './fixtures/chart-fixture';
import { captureChartMap } from './fixtures/chart-map';
import { openLeftPanel } from './chart-helpers';
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

test('真实地图渲染四向三角、COG回退与未知圆环，并保持单船选择', async ({ page }) => {
  page.on('pageerror', (error) => console.error(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') console.error(message.text());
  });
  const observedAt = new Date().toISOString();
  const positions = [0, 90, 180, 270, null].map((headingDegrees, i) => ({
    kind: 'point',
    mmsi: String(413000001 + i),
    lon: 122 + i * 0.003,
    lat: 32,
    headingDegrees: i === 3 ? 511 : headingDegrees,
    cogDegrees: i === 3 ? 270 : null,
    observedAt,
    sourceId: 'direction-fixture',
    sogKnots: 5,
    quality: [],
  }));
  await chartFixture(page, { role: 'viewer' });
  await page.route(/\/api\/v1\/map\/points(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: {
        snapshotId: 'b235db30-6d42-4d56-8d29-013006aa3d80',
        sequence: 1,
        items: positions,
        total: positions.length,
        sampled: false,
        truncated: false,
        generatedAt: observedAt,
        nextCursor: null,
        complete: true,
        expiresAt: '2099-01-01T00:00:00Z',
      },
    }),
  );
  await page.route('**/api/v1/vessels/413000001', (route) => {
    return route.fulfill({
      json: {
        mmsi: '413000001',
        latestPosition: {
          ...positions[0],
          kind: 'position',
          receivedAt: positions[0]!.observedAt,
        },
        staticFields: {},
        provenance: {},
      },
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.map-warning')).toHaveCount(0);
  // Keep the viewport stable when selection opens the existing operation panel.
  await openLeftPanel(page);
  await captureChartMap(page, '__vesselDirectionMap');
  await page.getByRole('button', { name: '暂停更新' }).click();
  await page.evaluate(async () => {
    const map = (
      globalThis as typeof globalThis & { __vesselDirectionMap: import('maplibre-gl').Map }
    ).__vesselDirectionMap;
    // Direction symbols appear at zoom >= 7; use a close view to inspect
    // their raster geometry rather than distant point markers.
    await new Promise<void>((resolve) => {
      map.once('idle', () => resolve());
      map.jumpTo({ center: [122.006, 32], zoom: 14 });
    });
  });
  const canvas = page.locator('.maplibregl-canvas');
  // Project only to locate each vessel's sample window. The assertions below
  // still measure the shapes in a real WebGL screenshot, independently of bearings.
  let shapes: {
    x: number;
    y: number;
    dx: number;
    dy: number;
    top: number;
    bottom: number;
    left: number;
    right: number;
    filledCenter: boolean;
  }[] = [];
  await expect
    .poll(async () => {
      const projected = await page.evaluate((positions) => {
        const map = (
          globalThis as typeof globalThis & {
            __vesselDirectionMap: import('maplibre-gl').Map;
          }
        ).__vesselDirectionMap;
        return positions.map(({ lon, lat }) => {
          const point = map.project([lon, lat]);
          return { x: point.x, y: point.y };
        });
      }, positions);
      const png = (await canvas.screenshot({ scale: 'css' })).toString('base64');
      shapes = await page.evaluate(
        async ({ png, projected }) => {
          const image = new Image();
          image.src = 'data:image/png;base64,' + png;
          await image.decode();
          const c = document.createElement('canvas');
          c.width = image.width;
          c.height = image.height;
          const ctx = c.getContext('2d')!;
          ctx.drawImage(image, 0, 0);
          const pixels = ctx.getImageData(0, 0, c.width, c.height).data;
          return projected.flatMap((point) => {
            const pending = new Set<number>();
            for (
              let y = Math.max(0, Math.floor(point.y) - 18);
              y <= Math.min(c.height - 1, Math.ceil(point.y) + 18);
              y++
            )
              for (
                let x = Math.max(0, Math.floor(point.x) - 18);
                x <= Math.min(c.width - 1, Math.ceil(point.x) + 18);
                x++
              ) {
                const i = y * c.width + x;
                const red = pixels[i * 4]!;
                const green = pixels[i * 4 + 1]!;
                const blue = pixels[i * 4 + 2]!;
                // Live icons use #21dfc8: G > B. Coastlines use #357b89: G < B.
                // Measure the colored body independently of its white outline.
                if (green - blue > 8 && green - red > 90 && blue - red > 75) pending.add(i);
              }
            const candidates = [];
            while (pending.size) {
              const queue = [pending.values().next().value!];
              const xs: number[] = [];
              const ys: number[] = [];
              pending.delete(queue[0]!);
              while (queue.length) {
                const i = queue.pop()!;
                xs.push(i % c.width);
                ys.push(Math.floor(i / c.width));
                for (const neighbor of [i - 1, i + 1, i - c.width, i + c.width])
                  if (pending.delete(neighbor)) queue.push(neighbor);
              }
              if (xs.length > 12) {
                const minX = Math.min(...xs),
                  maxX = Math.max(...xs);
                const minY = Math.min(...ys),
                  maxY = Math.max(...ys);
                const x = (minX + maxX) / 2;
                const y = (minY + maxY) / 2;
                const thirdWidth = (maxX - minX + 1) / 3;
                const thirdHeight = (maxY - minY + 1) / 3;
                candidates.push({
                  x,
                  y,
                  dx: xs.reduce((a, b) => a + b, 0) / xs.length - x,
                  dy: ys.reduce((a, b) => a + b, 0) / ys.length - y,
                  top: ys.filter((y) => y < minY + thirdHeight).length,
                  bottom: ys.filter((y) => y > maxY - thirdHeight).length,
                  left: xs.filter((x) => x < minX + thirdWidth).length,
                  right: xs.filter((x) => x > maxX - thirdWidth).length,
                  filledCenter: xs.some(
                    (x, index) => Math.abs(x - point.x) <= 1 && Math.abs(ys[index]! - point.y) <= 1,
                  ),
                });
              }
            }
            candidates.sort(
              (a, b) =>
                Math.hypot(a.x - point.x, a.y - point.y) - Math.hypot(b.x - point.x, b.y - point.y),
            );
            return candidates[0] ? [candidates[0]] : [];
          });
        },
        { png, projected },
      );
      return shapes;
    })
    .toHaveLength(5);
  await test.info().attach('vessel-pixel-shapes', {
    body: JSON.stringify(shapes, null, 2),
    contentType: 'application/json',
  });
  // The pointed third contains less colored area than the broad opposite third.
  // This tests the actual four directions without a subpixel centroid threshold.
  expect(shapes[0]!.top).toBeLessThan(shapes[0]!.bottom);
  expect(shapes[1]!.right).toBeLessThan(shapes[1]!.left);
  expect(shapes[2]!.bottom).toBeLessThan(shapes[2]!.top);
  expect(shapes[3]!.left).toBeLessThan(shapes[3]!.right);
  expect(shapes[0]!.dy).toBeGreaterThan(0);
  expect(shapes[1]!.dx).toBeLessThan(0);
  expect(shapes[2]!.dy).toBeLessThan(0);
  expect(shapes[3]!.dx).toBeGreaterThan(0);
  expect(shapes.slice(0, 4).every((shape) => shape.filledCenter)).toBe(true);
  expect(shapes[4]!.filledCenter).toBe(false);
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
