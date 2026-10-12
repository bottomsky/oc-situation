import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
export default defineConfig({
  testDir: '.',
  testMatch: ['agent-workbench.spec.ts', 'chart-workbench.spec.ts'],
  outputDir: '../../.data/chart-composer-browser-results',
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.CHART_TEST_BASE_URL ?? 'http://127.0.0.1:13001',
    viewport: { width: 1920, height: 1080 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
