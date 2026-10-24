import type { Page } from '@playwright/test';

/** Set public runtime values after Nuxt's inline config and before deferred app modules run. */
export async function configureOnlineChart(page: Page, values: Record<string, unknown> = {}) {
  const config = { chartOnlineEnabled: false, chartSeamarksEnabled: false, ...values };
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.fallback();
    const response = await route.fetch();
    const script = `<script>Object.assign(window.__NUXT__.config.public,${JSON.stringify(config).replaceAll('<', '\\u003c')});</script>`;
    const body = (await response.text()).replace('</body>', `${script}</body>`);
    await route.fulfill({ response, body });
  });
}

// A tiny synthetic MVT, authored here rather than copied from any public tile service.
// Protobuf fields follow the public Mapbox Vector Tile 2.1 schema.
export function syntheticChartTile() {
  function varint(n: number): number[] {
    const bytes: number[] = [];
    do {
      const byte = n & 127;
      n = Math.floor(n / 128);
      bytes.push(byte | (n ? 128 : 0));
    } while (n);
    return bytes;
  }
  const uint = (field: number, n: number) => [...varint(field << 3), ...varint(n)];
  const bytes = (field: number, data: number[]) => [
    ...varint((field << 3) | 2),
    ...varint(data.length),
    ...data,
  ];
  const text = (field: number, value: string) => bytes(field, [...new TextEncoder().encode(value)]);
  const packed = (field: number, numbers: number[]) => bytes(field, numbers.flatMap(varint));
  function layer(name: string, type: number, geometry: number[], labels = false) {
    const feature = [
      ...uint(1, 1),
      ...(labels ? packed(2, [0, 0, 1, 1, 2, 2, 3, 3]) : []),
      ...uint(3, type),
      ...packed(4, geometry),
    ];
    const fields = labels
      ? [
          ...text(3, 'name:zh'),
          ...text(3, 'name'),
          ...text(3, 'kind'),
          ...text(3, 'rank'),
          ...bytes(4, text(1, '中国沿海测试城')),
          ...bytes(4, text(1, '中国沿海测试城')),
          ...bytes(4, text(1, 'city')),
          ...bytes(4, uint(5, 1)),
        ]
      : [];
    return bytes(3, [
      ...text(1, name),
      ...bytes(2, feature),
      ...fields,
      ...uint(5, 4096),
      ...uint(15, 2),
    ]);
  }
  return Buffer.from([
    ...layer('ocean', 3, [9, 0, 0, 26, 8192, 0, 0, 8192, 8191, 0, 15]),
    ...layer('place_labels', 1, [9, 4096, 4096], true),
  ]);
}

export const transparentSeamark = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=',
  'base64',
);
