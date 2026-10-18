import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '../..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.data/playwright');
export default defineConfig({
  testDir: '.',
  testMatch: 'routes-workbench.spec.ts',
  outputDir: resolve(root, '.data/routes-focused-results'),
  workers: 1,
  timeout: 90000,
  expect: { timeout: 30000 },
  use: {
    baseURL: 'http://127.0.0.1:13006',
    viewport: { width: 1720, height: 1080 },
    screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13006',
    url: 'http://127.0.0.1:13006',
    reuseExistingServer: false,
    timeout: 120000,
    cwd: root,
  },
});
