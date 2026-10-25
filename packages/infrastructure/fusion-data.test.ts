import { describe, expect, it } from 'vitest';
import { IntelligenceInputSchema, IntelligenceSourceSchema } from '../contracts/intelligence';
import { boxesOverlap, readyEventId, intelligenceEventId, queryFusionDataset } from './fusion-data';
import type { Infrastructure } from './clients';

describe('fusion data boundaries', () => {
  it('narrows static FINAL reads by stable event keys before loading payloads, retaining post-final vessel and time filters', async () => {
    const to = new Date().toISOString();
    const position = {
      schemaVersion: 1,
      cleaningVersion: 1,
      eventId: 'position-1',
      captureId: 'capture-1',
      sourceId: 'fixture',
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      receivedAt: to,
      quality: [],
      kind: 'position',
      observedAt: to,
      mmsi: '366838990',
      lat: 30,
      lon: 122,
      sogKnots: 8,
      cogDegrees: 90,
      headingDegrees: 90,
      rotDegPerMinute: null,
      navigationStatus: 0,
      receptionType: 'UNKNOWN',
    };
    const queries: { query: string; clickhouse_settings: Record<string, unknown> }[] = [];
    const infra = {
      clickhouse: {
        query: async (input: (typeof queries)[number]) => {
          queries.push(input);
          return {
            json: async () =>
              input.query.includes('static_history_v2')
                ? []
                : [{ observation: JSON.stringify(position) }],
          };
        },
      },
      pool: {
        query: async (sql: string) => ({
          rows: sql.includes('vessel_identifiers')
            ? [
                {
                  identifier: position.mmsi,
                  vessel_id: 'vessel-1',
                  valid_from: new Date('1970-01-01T00:00:00Z'),
                  valid_to: null,
                },
              ]
            : [],
        }),
      },
    } as unknown as Infrastructure;
    const result = await queryFusionDataset(infra, {
      from: new Date(Date.parse(to) - 3600_000).toISOString(),
      to,
      mmsis: [position.mmsi],
      maxRecords: 1,
    });
    const statics = queries.find((query) => query.query.includes('static_history_v2'))!;
    expect(statics.query).toContain(
      'FINAL PREWHERE (sourceId,eventId) IN (SELECT sourceId,eventId FROM static_history_v2 WHERE mmsi IN {mmsis:Array(String)}) WHERE mmsi IN {mmsis:Array(String)}',
    );
    expect(statics.query).not.toContain('PREWHERE mmsi');
    expect(statics.clickhouse_settings).toMatchObject({
      max_threads: 1,
      max_final_threads: 1,
      max_execution_time: 15,
      max_memory_usage: '268435456',
      max_bytes_in_set: '16777216',
      set_overflow_mode: 'throw',
      result_overflow_mode: 'throw',
    });
    expect(result.ais).toHaveLength(1);
  });
  it.each([['413123456'], []])(
    'filters vessel intersection %j before the history limit',
    async (...args) => {
      const selected = args as string[];
      let sql = '';
      let params: Record<string, unknown> = {};
      const infra = {
        clickhouse: {
          query: async (input: { query: string; query_params: Record<string, unknown> }) => {
            sql = input.query;
            params = input.query_params;
            return { json: async () => [] };
          },
        },
        pool: { query: async () => ({ rows: [] }) },
      } as unknown as Infrastructure;
      const now = Date.now();
      const result = await queryFusionDataset(infra, {
        from: new Date(now - 3600_000).toISOString(),
        to: new Date(now).toISOString(),
        mmsis: selected,
        sourceId: 'chosen-source',
        maxRecords: 1,
      });
      expect(params.selectedMmsis).toEqual(selected);
      expect(params.sourceId).toBe('chosen-source');
      expect(sql).toContain('sourceId={sourceId:String}');
      expect(sql.indexOf('mmsi IN {selectedMmsis:Array(String)}')).toBeLessThan(
        sql.indexOf('LIMIT'),
      );
      expect(result.ais).toEqual([]);
    },
  );
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
