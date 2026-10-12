import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
export default defineConfig({
  testDir: '.',
  outputDir: resolve(import.meta.dirname, '../../.data/intelligence-focused-results'),
  testMatch: 'intelligence-workbench.spec.ts',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 20000 },
  use: {
    baseURL: 'http://127.0.0.1:13001',
    viewport: { width: 1920, height: 1000 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13001',
    url: 'http://127.0.0.1:13001',
    reuseExistingServer: true,
    timeout: 120000,
    cwd: resolve(import.meta.dirname, '../..'),
  },
});
