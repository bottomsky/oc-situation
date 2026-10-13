import { describe, expect, it } from 'vitest';
import { intelligencePublishedTimeLabel } from './app/utils/intelligenceLabels';

describe('情报来源时间标签', () => {
  it('来源更新和索引观测不能冒充原文发布时间', () => {
    expect(intelligencePublishedTimeLabel({ publishedTimeBasis: 'provider-updated' })).toBe(
      '来源更新',
    );
    expect(intelligencePublishedTimeLabel({ publishedTimeBasis: 'provider-index' })).toBe(
      '索引观测',
    );
    expect(intelligencePublishedTimeLabel({ publishedTimeBasis: 'unknown' })).toBe('来源观测');
    expect(intelligencePublishedTimeLabel({ publishedTimeBasis: 'publication' })).toBe('发布');
    expect(intelligencePublishedTimeLabel(null)).toBe('发布');
    expect(intelligencePublishedTimeLabel({ provider: 'GDACS' })).toBe('来源更新');
  });
});
