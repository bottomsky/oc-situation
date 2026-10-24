import { describe, expect, it } from 'vitest';
import { buildPlan, extraBuildEntries } from './build-plan';
describe('production build plan', () => {
  it('bundles the isolated prediction thread beside the topics process', () => {
    expect(extraBuildEntries('topics')).toEqual([
      { entry: 'prediction-worker.ts', output: 'dist/prediction-worker.mjs' },
    ]);
    expect(extraBuildEntries('api')).toEqual([]);
  });
  it('selects concrete Node entry points instead of noEmit checks', () => {
    expect(buildPlan('api')).toEqual({
      entry: 'src/main.ts',
      output: 'dist/main.mjs',
      migrations: true,
    });
    expect(buildPlan('writer')).toEqual({
      entry: 'main.ts',
      output: 'dist/main.mjs',
      migrations: true,
    });
    expect(buildPlan('contracts')).toEqual({
      entry: 'index.ts',
      output: 'dist/index.mjs',
      migrations: false,
    });
  });
  it('rejects unknown workspaces explicitly', () => {
    expect(() => buildPlan('unknown')).toThrow('Unknown');
  });
  it('builds intelligence acquisition and independent topic workers as runnable processes', () => {
    for (const name of ['intelligence', 'topics', 'agent']) {
      expect(buildPlan(name)).toEqual({
        entry: 'main.ts',
        output: 'dist/main.mjs',
        migrations: true,
      });
    }
  });
});
