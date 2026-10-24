import { describe, expect, it, vi } from 'vitest';
import type { AnalysisResult } from '../contracts/topics';
import { enqueueAnalysisOperationalEvent } from './operational-event-sync';

describe('private prediction events', () => {
  const result = {
    id: 'a'.repeat(64),
    instanceId: 'instance',
    revision: 1,
    status: 'active',
    title: '测试',
    summary: '测试',
    mmsi: '413000001',
    bbox: [120, 20, 121, 21],
    from: '2026-10-24T00:00:00.000Z',
  } as AnalysisResult;
  it.each(['vessel-reachability', 'navigation-warning-impact'] as const)(
    'keeps %s out of the public outbox including backfills',
    async (definitionId) => {
      const query = vi.fn().mockResolvedValue({ rows: [] });
      await enqueueAnalysisOperationalEvent({ query }, { ...result, definitionId });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it('retains public legacy rule conversion', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await enqueueAnalysisOperationalEvent(
      { query },
      { ...result, definitionId: 'port-restriction', kind: 'rule' },
    );
    expect(
      query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO event_sync_outbox')),
    ).toBe(true);
  });
});
