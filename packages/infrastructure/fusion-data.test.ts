import { describe, expect, it } from 'vitest';
import { IntelligenceInputSchema, IntelligenceSourceSchema } from '../contracts/intelligence';
import { boxesOverlap, readyEventId, intelligenceEventId } from './fusion-data';

describe('fusion data boundaries', () => {
  const event = {
    sourceId: 'port',
    externalId: 'notice-1',
    version: 1,
    title: 'Restriction',
    summary: 'Test',
    category: 'port-restriction',
    publishedAt: '2026-10-01T00:00:00Z',
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveTo: null,
    paragraphs: [{ id: 'p1', text: 'Applies to cargo ships.' }],
    raw: { original: true },
  };
  it('requires temporal order and explicit revision identity', () => {
    expect(IntelligenceInputSchema.safeParse(event).success).toBe(true);
    expect(
      IntelligenceInputSchema.safeParse({ ...event, effectiveTo: '2026-09-01T00:00:00Z' }).success,
    ).toBe(false);
    expect(IntelligenceInputSchema.safeParse({ ...event, version: 2 }).success).toBe(false);
  });
  it('handles date line overlap', () => {
    expect(boxesOverlap([170, -10, -170, 10], [175, -2, 179, 2])).toBe(true);
    expect(boxesOverlap([170, -10, -170, 10], [-10, -2, 10, 2])).toBe(false);
  });
  it('requires original JSON and bounds UTF-8 bytes', () => {
    expect(IntelligenceInputSchema.safeParse({ ...event, raw: undefined }).success).toBe(false);
    expect(IntelligenceInputSchema.safeParse({ ...event, raw: '海'.repeat(400000) }).success).toBe(
      false,
    );
  });
  it('makes outbox identities deterministic and version specific', () => {
    expect(readyEventId('e', 1)).toBe(readyEventId('e', 1));
    expect(readyEventId('e', 1)).not.toBe(readyEventId('e', 2));
  });
  it('keeps delimiter-bearing compound document identities distinct', () => {
    expect(intelligenceEventId('a:b', 'c', 1)).not.toBe(intelligenceEventId('a', 'b:c', 1));
  });
  it('requires explicit host authorization for network sources', () => {
    expect(
      IntelligenceSourceSchema.safeParse({
        sourceId: 's',
        name: 'Source',
        kind: 'json',
        endpoint: 'https://example.org/feed',
      }).success,
    ).toBe(false);
  });
});
