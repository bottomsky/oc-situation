import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFixtureServer } from '../../../tests/fixture-server/server';
import { crawlSource } from './worker';
import { SourceSettingsSchema, type SourceConfig } from '@ais/contracts';
const server = createFixtureServer('2026-09-29T06:42:13Z', { robotsRateLimitOnce: true });
beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(13002, '127.0.0.1', resolve));
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const source: SourceConfig = {
  sourceId: 'fixture',
  sourceKind: 'fixture-http',
  name: 'fixture',
  status: 'enabled',
  priority: 100,
  secretRef: null,
  endpoint: 'http://127.0.0.1:13002/ais.json',
  settings: SourceSettingsSchema.parse({ allowedHosts: ['127.0.0.1'], requestsPerMinute: 300 }),
};
it('runs real Crawlee durable HTTP queue and publishes both pages before progress', async () => {
  const values: unknown[] = [];
  const order: string[] = [];
  await crawlSource({
    source,
    runId: randomUUID(),
    production: false,
    signal: new AbortController().signal,
    publish: async (value) => {
      values.push(value);
      order.push('publish');
    },
    checkpoint: async () => {
      order.push('checkpoint');
    },
  });
  expect(values).toHaveLength(2);
  expect(values[0]).toMatchObject({ synthetic: true });
  expect(order).toEqual(['publish', 'checkpoint', 'publish', 'checkpoint']);
});
it('blocks authorization, oversized response and redirect to unregistered private service', async () => {
  for (const path of ['/blocked401', '/oversize', '/redirect-private']) {
    await expect(
      crawlSource({
        source: { ...source, endpoint: `http://127.0.0.1:13002${path}` },
        runId: randomUUID(),
        production: false,
        signal: new AbortController().signal,
        publish: async () => {},
        checkpoint: async () => {},
      }),
    ).rejects.toThrow();
  }
});
it('runs actual Playwright render and captures dynamic script snapshot', async () => {
  const values: unknown[] = [];
  await crawlSource({
    source: {
      ...source,
      sourceKind: 'fixture-browser',
      endpoint: 'http://127.0.0.1:13002/ais-dynamic.html',
    },
    runId: randomUUID(),
    production: false,
    signal: new AbortController().signal,
    publish: async (value) => {
      values.push(value);
    },
    checkpoint: async () => {},
  });
  expect(String(values[0])).toContain('id="ais-data"');
  expect(String(values[0])).toContain('SYNTHETIC DEMO');
});
it('budgets every actual browser resource including robots and retries', async () => {
  let requests = 0;
  const values: unknown[] = [];
  await crawlSource({
    source: { ...source, sourceKind: 'fixture-browser', endpoint: 'http://127.0.0.1:13002/browser-resources.html' },
    runId: randomUUID(), production: false, signal: new AbortController().signal,
    onRequest: () => { requests++; }, publish: async (value) => { values.push(value); }, checkpoint: async () => {},
  });
  expect(requests).toBeGreaterThanOrEqual(5);
  expect(String(values[0])).toContain('id="ais-data"');
});
