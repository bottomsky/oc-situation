import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const root = import.meta.dirname;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.data/playwright');

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['agent-memory.spec.ts'],
  outputDir: '.data/memory-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: 'http://127.0.0.1:13008',
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node apps/web/.output/server/index.mjs',
    url: 'http://127.0.0.1:13008',
    reuseExistingServer: false,
    timeout: 60000,
    cwd: root,
    env: { NITRO_HOST: '127.0.0.1', NITRO_PORT: '13008' },
  },
});
