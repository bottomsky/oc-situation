import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

const root = import.meta.dirname;
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.data/playwright');

/** Validate the compiled application once, without competing Nuxt development caches. */
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: ['agent-workbench.spec.ts', 'routes-workbench.spec.ts', 'events-workbench.spec.ts'],
  outputDir: '.data/spatial-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: { timeout: 20000 },
  use: {
    baseURL: 'http://127.0.0.1:13007',
    viewport: { width: 1720, height: 1080 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: 'node apps/web/.output/server/index.mjs',
    url: 'http://127.0.0.1:13007',
    reuseExistingServer: false,
    timeout: 60000,
    cwd: root,
    env: { NITRO_HOST: '127.0.0.1', NITRO_PORT: '13007' },
  },
});
