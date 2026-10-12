import { defineConfig } from 'vitest/config';

const integration = process.env.AIS_TEST_SCOPE === 'integration';

export default defineConfig({
  test: {
    environment: 'node',
    include: integration
      ? [
          'tests/integration/**/*.test.ts',
          'tests/integration/**/*.spec.ts',
          'apps/**/*.integration.test.ts',
          'packages/**/*.integration.test.ts',
        ]
      : [
          'apps/**/*.test.ts',
          'apps/**/*.spec.ts',
          'packages/**/*.test.ts',
          'packages/**/*.spec.ts',
          'scripts/**/*.test.ts',
          'tests/unit/**/*.test.ts',
          'tests/unit/**/*.spec.ts',
        ],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      ...(integration ? [] : ['**/*.integration.test.ts', 'tests/integration/**']),
    ],
    testTimeout: integration ? 60_000 : 10_000,
    hookTimeout: integration ? 60_000 : 10_000,
    passWithNoTests: false,
    fileParallelism: !integration,
    reporters: ['default'],
  },
});
