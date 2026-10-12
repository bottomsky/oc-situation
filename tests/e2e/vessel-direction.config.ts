import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
export default defineConfig({
  testDir: '.',
  testMatch: 'vessel-direction.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  use: {
    baseURL: 'http://127.0.0.1:13001',
    viewport: { width: 1500, height: 1000 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13001',
    url: 'http://127.0.0.1:13001',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: resolve(import.meta.dirname, '../..'),
    env: { NUXT_PUBLIC_MAP_STYLE_URL: '', NUXT_PUBLIC_MAP_TILER_KEY: '' },
  },
});
