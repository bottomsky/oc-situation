import { describe, expect, it } from 'vitest';
import { mergeSequenceRanges } from './processing-stats';
describe('bounded processing receipt ledger', () => {
  it('compresses huge completed ranges without expanding historical sequences', () => {
    expect(mergeSequenceRanges([[1,2_592_000_000]], [2_592_000_001,2_592_000_001,2_592_000_003])).toEqual([[1,2_592_000_001],[2_592_000_003,2_592_000_003]]);
  });
  it('fills retry holes while preserving newly arrived disjoint ranges', () => {
    expect(mergeSequenceRanges([[1,3],[5,8],[10,20]],[4,9,22])).toEqual([[1,20],[22,22]]);
  });
});
