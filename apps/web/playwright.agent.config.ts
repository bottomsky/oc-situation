import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
export default defineConfig({
  testDir: '../../tests/e2e',
  testMatch: 'agent-workbench.spec.ts',
  outputDir: '../../.data/agent-browser-results',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:13001',
    viewport: { width: 1920, height: 1080 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'bun node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13001',
    url: 'http://127.0.0.1:13001',
    reuseExistingServer: true,
    timeout: 120000,
    cwd: resolve(import.meta.dirname, '../..'),
    env: { NUXT_PUBLIC_MAP_STYLE_URL: '', NUXT_PUBLIC_MAP_TILER_KEY: '' },
  },
});
