import { describe, expect, it } from 'vitest';
import { thinkingPolicy } from './thinking-policy';

describe('thinking request policy', () => {
  it('allocates thinking and answer room within the task deadline', () => {
    expect(thinkingPolicy({}, 500)).toEqual({
      thinkingLevel: 'high',
      maxTokens: 8192,
      timeoutMs: 120_000,
    });
    for (const budget of [1000, 1500, 2500]) {
      expect(thinkingPolicy({}, budget).maxTokens).toBe(16384);
      expect(thinkingPolicy({ thinkingLevel: 'off' }, budget)).toEqual({
        thinkingLevel: 'off',
        maxTokens: budget,
        timeoutMs: 60_000,
      });
    }
    expect(thinkingPolicy({ runtimeTimeoutMs: 250 }, 500).timeoutMs).toBe(250);
  });
});
