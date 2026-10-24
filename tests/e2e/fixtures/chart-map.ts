import type { Page } from '@playwright/test';

/** Locate the already loaded MapLibre namespace in both dev and hashed production chunks. */
export async function captureChartMap(page: Page, name: string) {
  await page.evaluate(async (key) => {
    const urls = performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((url) => /\.js(?:\?|$)/.test(url) && !url.includes('worker'));
    let target = urls.find((url) => /\/maplibre[-_]gl/.test(url));
    if (!target) {
      for (const url of urls) {
        const source = await fetch(url).then((response) => response.text());
        if (source.includes('maplibregl-map')) {
          target = url;
          break;
        }
      }
    }
    if (!target) throw new Error('Loaded MapLibre module was not found');
    const module = await import(target);
    const namespace = Object.values(module).find(
      (value) =>
        value &&
        typeof value === 'object' &&
        'Map' in value &&
        typeof (value as { Map?: { prototype?: { getLayer?: unknown } } }).Map?.prototype
          ?.getLayer === 'function',
    ) as { Map: { prototype: import('maplibre-gl').Map } } | undefined;
    const MapClass = namespace?.Map ?? (module.Map ? module.Map : undefined);
    if (!MapClass) throw new Error('MapLibre Map export was not found');
    const original = MapClass.prototype.getLayer;
    MapClass.prototype.getLayer = function (id: string) {
      Object.assign(globalThis, { [key]: this });
      MapClass.prototype.getLayer = original;
      return original.call(this, id);
    };
  }, name);
  await page.getByRole('button', { name: '浅色海图', exact: true }).click();
  await page.getByRole('button', { name: '深色海图', exact: true }).click();
}
