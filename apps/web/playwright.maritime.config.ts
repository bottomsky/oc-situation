import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
const renderArgs =
  process.env.MARITIME_RENDERER === 'hardware'
    ? ['--use-angle=d3d11']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
export default defineConfig({
  testDir: '../../tests/e2e',
  testMatch: 'maritime-workbench.spec.ts',
  workers: 1,
  timeout: 180000,
  outputDir: '../../.data/maritime-validation/browser-results',
  use: {
    baseURL: 'http://127.0.0.1:13001',
    viewport: { width: 1920, height: 1080 },
    launchOptions: { args: renderArgs },
    screenshot: 'only-on-failure',
  },
  expect: { timeout: 30000 },
  webServer: {
    command:
      process.env.MARITIME_COMPILED === '1'
        ? 'bun run --filter @ais/web start'
        : 'bun run --filter @ais/web dev',
    url: 'http://127.0.0.1:13001',
    reuseExistingServer: false,
    timeout: 120000,
    cwd: resolve(import.meta.dirname, '../..'),
    env: {
      NITRO_HOST: '127.0.0.1',
      NITRO_PORT: '13001',
      NUXT_PUBLIC_CHART_ONLINE_ENABLED: 'false',
      NUXT_PUBLIC_CHART_SEAMARKS_ENABLED: 'false',
    },
  },
});
