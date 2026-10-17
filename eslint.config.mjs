import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import vue from 'eslint-plugin-vue';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.nuxt/**',
      '**/.output/**',
      '**/coverage/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'ingest/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...vue.configs['flat/essential'],
  {
    files: ['**/*.ts', '**/*.mjs', '**/*.vue'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        AbortController: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.vue'],
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['apps/web/**/*.{ts,vue}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@ais/domain',
            '@ais/infrastructure',
            '@ais/source-adapters',
            '**/packages/infrastructure/**',
            '**/apps/api/**',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '@ais/infrastructure',
            '@ais/source-adapters',
            'pg',
            'crawlee',
            '@nats-io/*',
            '@aws-sdk/*',
          ],
        },
      ],
    },
  },
  {
    files: ['packages/source-adapters/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['@ais/infrastructure', 'pg', '@nats-io/*', '@aws-sdk/*'] },
      ],
    },
  },
  {
    files: ['apps/web/app/pages/**/*.vue'],
    rules: { 'vue/multi-word-component-names': 'off' },
  },
  {
    files: ['**/*.vue'],
    languageOptions: { parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] } },
  },
);
