import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const compiledWeb = process.env.E2E_COMPILED_WEB === '1';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.data/playwright');
export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: '**/vessel-direction.spec.ts',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './scripts/e2e-setup.ts',
  use: {
    baseURL: 'http://127.0.0.1:13001',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node --import tsx scripts/demo.ts --backend-only',
      url: 'http://127.0.0.1:13100/ready',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        TSX_TSCONFIG_PATH: resolve(root, 'tsconfig.base.json'),
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
      },
    },
    ...(compiledWeb
      ? [
          {
            command: 'node apps/web/.output/server/index.mjs',
            url: 'http://127.0.0.1:13003',
            reuseExistingServer: false,
            timeout: 120_000,
            env: { NITRO_HOST: '127.0.0.1', NITRO_PORT: '13003' },
          },
          {
            command: 'node --import tsx scripts/e2e-web-gateway.ts',
            url: 'http://127.0.0.1:13001',
            reuseExistingServer: false,
            timeout: 120_000,
          },
        ]
      : [
          {
            command:
              'node node_modules/nuxt/bin/nuxt.mjs dev apps/web --host 127.0.0.1 --port 13001',
            url: 'http://127.0.0.1:13001',
            reuseExistingServer: !process.env.CI,
            timeout: 120_000,
          },
        ]),
  ],
});
