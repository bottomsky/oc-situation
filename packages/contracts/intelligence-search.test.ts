import { describe, expect, it } from 'vitest';
import { AgentInputResponseSchema, AgentSelectionSchema } from './agent';
import { IntelligenceSourceSchema } from './intelligence';
import {
  IntelligenceSearchQuerySchema,
  IntelligenceSearchSpecSchema,
  MARINE_SAMPLE_POINTS,
  MarineForecastHourSchema,
} from './intelligence-search';

describe('intelligence retrieval contract boundaries', () => {
  it('accepts retained historical windows independently from AIS limits', () => {
    const range = { from: '2025-01-01T00:00:00Z', to: '2026-01-01T00:00:00Z' };
    expect(
      AgentSelectionSchema.parse({ purpose: 'intelligence_search', intelligenceTimeRange: range })
        .intelligenceTimeRange,
    ).toEqual(range);
    expect(
      AgentSelectionSchema.safeParse({ purpose: 'port-restriction', timeRange: range }).success,
    ).toBe(false);
    expect(
      IntelligenceSearchQuerySchema.parse({ ...range, keyword: '航警', bbox: '179,0,-179,20' })
        .bbox,
    ).toEqual([179, 0, -179, 20]);
  });
  it('rejects reversed windows and arbitrary tool side effects', () => {
    expect(
      IntelligenceSearchQuerySchema.safeParse({
        from: '2026-10-13T00:00:00Z',
        to: '2026-10-12T00:00:00Z',
      }).success,
    ).toBe(false);
    expect(
      IntelligenceSearchSpecSchema.safeParse({ keyword: '航警', url: 'https://example.com' })
        .success,
    ).toBe(false);
    expect(
      IntelligenceSearchSpecSchema.safeParse({ keyword: '航警', sql: 'SELECT * FROM users' })
        .success,
    ).toBe(false);
  });
  it('supports future forecast windows and explicit topic answers', () => {
    expect(
      IntelligenceSearchSpecSchema.safeParse({
        kind: 'marine',
        samplePointId: 'east-china-sea',
        forecastFrom: '2026-10-14T00:00:00Z',
        forecastTo: '2026-10-15T00:00:00Z',
      }).success,
    ).toBe(true);
    expect(
      AgentInputResponseSchema.parse({
        action: 'accept',
        inputRevision: 0,
        values: { purpose: 'intelligence_search', intelligenceQuery: { keyword: '台风' } },
      }).action,
    ).toBe('accept');
    expect(MARINE_SAMPLE_POINTS).toHaveLength(6);
  });
  it('defaults previous and manual sources to internal disclosure', () => {
    expect(
      IntelligenceSourceSchema.parse({ sourceId: 'internal', name: '人工记录', kind: 'manual' })
        .visibility,
    ).toBe('internal');
  });
  it('rejects invalid physical marine values while accepting unknown data', () => {
    const hour = {
      validAt: '2026-10-13T00:00:00Z',
      waveHeight: null,
      waveDirection: null,
      wavePeriod: null,
    };
    expect(MarineForecastHourSchema.safeParse(hour).success).toBe(true);
    expect(MarineForecastHourSchema.safeParse({ ...hour, waveHeight: -2 }).success).toBe(false);
    expect(MarineForecastHourSchema.safeParse({ ...hour, waveDirection: 500 }).success).toBe(false);
  });
});
