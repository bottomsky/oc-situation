import { expect, it } from 'vitest';
import { intelligenceSearchTerms } from './intelligence-search';
it('normalizes Chinese and English maritime topics without unrestricted expansion', () => {
  expect(intelligenceSearchTerms('船舶事故')).toContain('collision');
  expect(intelligenceSearchTerms('typhoon')).toContain('台风');
  expect(intelligenceSearchTerms('航行警告')).toContain('notice to mariners');
  expect(intelligenceSearchTerms('')).toEqual([]);
  expect(intelligenceSearchTerms('明确的自定义词')).toEqual(['明确的自定义词']);
  expect(intelligenceSearchTerms('事故航警台风地震罢工航运')).toHaveLength(20);
});
