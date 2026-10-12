import { describe, expect, it } from 'vitest';
import { analysisFingerprint, retryDelaySeconds } from './topics';
import type { AnalysisResult } from '../contracts/topics';

describe('topic durable processing helpers', () => {
  it('bounds retry delay and treats only evidence changes as new revisions', () => {
    expect(retryDelaySeconds(99)).toBe(300);
    const value = {
      id: 'a',
      revision: 1,
      updatedAt: 'a',
      createdAt: 'a',
      evidence: { queriedAt: 'a', ais: [{ recordId: '1' }] },
      summary: 'observation',
    } as unknown as AnalysisResult;
    const again = {
      ...value,
      revision: 2,
      updatedAt: 'b',
      evidence: { ...value.evidence, queriedAt: 'b' },
    };
    expect(analysisFingerprint(value)).toBe(analysisFingerprint(again));
    expect(analysisFingerprint(value)).not.toBe(
      analysisFingerprint({ ...again, summary: 'changed' }),
    );
  });
});
