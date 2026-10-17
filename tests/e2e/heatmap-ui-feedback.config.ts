import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';

process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(import.meta.dirname, '../../.data/playwright');
export default defineConfig({
  testDir: '.',
  testMatch: [
    'heatmap-ui-feedback.spec.ts',
    'heatmap-workbench.spec.ts',
    'skills-workbench.spec.ts',
  ],
  grep: /热图恢复回执|等待智能体期间手动生成并关闭|真实UI消费者连续展示两个步骤产物/,
  outputDir: '../../.data/heatmap-ui-feedback-browser-results',
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.CHART_TEST_BASE_URL ?? 'http://127.0.0.1:13001',
    viewport: { width: 1920, height: 1000 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
