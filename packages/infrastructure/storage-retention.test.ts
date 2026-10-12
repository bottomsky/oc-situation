import { describe, it, expect } from 'vitest';
import { saveLatestBatch, saveHistoryBatch } from './storage';
import type { Infrastructure } from './clients';
import type { PositionObservation } from '@ais/contracts';
const stale: PositionObservation = {
  schemaVersion: 1, cleaningVersion: 1, kind: 'position', eventId: 'stale', captureId: 'c',
  sourceId: 'fixture', sourceKind: 'fixture-http', sourcePriority: 100, runId: null,
  observedAt: new Date(Date.now() - 31 * 86400000).toISOString(),
  receivedAt: new Date(Date.now() - 31 * 86400000).toISOString(), mmsi: '413793000',
  lat: 33, lon: 124, sogKnots: null, cogDegrees: null, headingDegrees: null,
  rotDegPerMinute: null, navigationStatus: null, receptionType: 'UNKNOWN', quality: [],
};
describe('write-time online retention', () => {
  it('omits replay positions already outside current 30-day boundary in both stores', async () => {
    const tables: string[] = [];
    const infra = { pool: { connect: () => { throw new Error('PG should not write'); } },
      clickhouse: { insert: async ({ table }: { table: string }) => { tables.push(table); } },
    } as unknown as Infrastructure;
    await saveLatestBatch(infra, [stale]);
    await saveHistoryBatch(infra, [stale]);
    expect(tables).not.toContain('positions');
  });
});
