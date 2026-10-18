import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '.data/playwright');
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'events-workbench.spec.ts',
  timeout: 90000,
  expect: { timeout: 20000 },
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:13005',
    ...devices['Desktop Chrome'],
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13005',
    url: 'http://127.0.0.1:13005',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
