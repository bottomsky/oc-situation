import { describe, expect, it } from 'vitest';
import { deriveAgentIntent, requiredAgentInputFields } from './agent-intents';
import { intelligenceSelection } from './intelligence-intent';
const now = new Date('2026-10-13T00:00:00Z');
describe('local intelligence intent and absolute windows', () => {
  it.each(['明天香港港海况', '明天海况', '未来三天浪高'])(
    'requires a supported representative point before searching: %s',
    (question) => {
      const selection = intelligenceSelection(question, now);
      expect(requiredAgentInputFields(selection, 'intelligence_search')).toEqual(['topic']);
      expect(
        requiredAgentInputFields(
          {
            ...selection,
            intelligenceQuery: { ...selection.intelligenceQuery, keyword: '香港港' },
          },
          'intelligence_search',
        ),
      ).toEqual(['topic']);
      expect(
        requiredAgentInputFields(
          {
            ...selection,
            intelligenceQuery: { ...selection.intelligenceQuery, samplePointId: 'east-china-sea' },
          },
          'intelligence_search',
        ),
      ).toEqual([]);
    },
  );
  it.each([
    ['近期有哪些洪水', 'environment', '洪水'],
    ['recent flood', 'environment', '洪水'],
    ['近期有哪些海啸', 'weather', '海啸'],
    ['recent tsunami', 'weather', '海啸'],
    ['近期有哪些气旋', 'weather', '台风'],
    ['recent cyclone', 'weather', '台风'],
  ])('routes disaster vocabulary locally: %s', (question, category, keyword) => {
    expect(deriveAgentIntent(question).intent).toBe('intelligence_search');
    expect(intelligenceSelection(question, now).intelligenceQuery).toMatchObject({
      kind: 'events',
      category,
      keyword,
    });
  });
  it('routes general disaster questions to local intelligence search', () => {
    expect(deriveAgentIntent('近期有哪些灾害').intent).toBe('intelligence_search');
  });
  it.each([
    '去年春节有哪些新闻',
    '国庆期间有哪些事故',
    '去年有哪些新闻',
    '查询2026-02-30至2026-03-01公告',
    '查询2026-10-20至2026-10-01公告',
    '查询2026-13-01至2026-13-02公告',
  ])('asks for time instead of silently searching seven days: %s', (q) => {
    const selection = intelligenceSelection(q, now);
    expect(selection.intelligenceTimeUnclear).toBe(true);
    expect(selection.intelligenceTimeRange).toBeUndefined();
    expect(selection.intelligenceQuery?.from).toBeUndefined();
    expect(requiredAgentInputFields(selection, 'intelligence_search')).toEqual(['time']);
  });
  it('tomorrow means the next Beijing calendar day even near UTC midnight', () => {
    const selection = intelligenceSelection('明天东海浪高', new Date('2026-10-13T23:30:00Z'));
    expect(selection.intelligenceTimeRange).toEqual({
      from: '2026-10-14T16:00:00.000Z',
      to: '2026-10-15T16:00:00.000Z',
    });
    expect(selection.intelligenceQuery).toMatchObject({
      forecastFrom: '2026-10-14T16:00:00.000Z',
      forecastTo: '2026-10-15T16:00:00.000Z',
    });
  });
  it('strips temporal wording from local keywords and retains the normal seven-day default', () => {
    expect(
      intelligenceSelection('去年春节有哪些新闻', now).intelligenceQuery?.keyword,
    ).toBeUndefined();
    expect(
      intelligenceSelection('最近三天有哪些新闻', now).intelligenceQuery?.keyword,
    ).toBeUndefined();
    expect(intelligenceSelection('最近有哪些新闻', now).intelligenceTimeUnclear).toBeUndefined();
  });
  it.each([
    '最近黄海有哪些新闻',
    '查询港口限制公告',
    '未来三天东海浪高',
    '再查一次情报',
    '解释上次新闻然后再查一次',
    '近期有什么船舶事故',
  ])('routes %s', (q) => expect(deriveAgentIntent(q).intent).toBe('intelligence_search'));
  it('keeps analysis and previous snapshot explanation distinct', () => {
    expect(deriveAgentIntent('分析区域低速活动与公告关联').intent).toBe('analysis');
    expect(deriveAgentIntent('解释上次新闻结果').intent).toBe('explain');
  });
  it('defaults to seven days and binds location aliases locally', () => {
    const result = intelligenceSelection('黄海有哪些新闻', now);
    expect(result.intelligenceQuery).toMatchObject({
      kind: 'events',
      locationKeyword: '黄海',
      from: '2026-10-06T00:00:00.000Z',
      to: now.toISOString(),
    });
  });
  it('accepts historical periods beyond AIS retention and 168 hours', () => {
    expect(
      intelligenceSelection('查询2024-01-01至2024-12-31港口公告', now).intelligenceTimeRange,
    ).toEqual({ from: '2023-12-31T16:00:00.000Z', to: '2024-12-30T16:00:00.000Z' });
  });
  it('binds future marine horizon instead of a past AIS window', () => {
    expect(intelligenceSelection('未来三天东海浪高', now).intelligenceQuery).toMatchObject({
      kind: 'marine',
      samplePointId: 'east-china-sea',
      forecastFrom: now.toISOString(),
      forecastTo: '2026-10-16T00:00:00.000Z',
    });
  });
});
