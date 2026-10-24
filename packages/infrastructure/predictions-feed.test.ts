import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import { readAnalysisFeed, readLiveAnalysisFeed, analysisFingerprint } from './topics';
import type { AnalysisResult } from '../contracts/topics';
const row = (sequence: string, owner: string | null) => ({
  sequence,
  prediction_owner: owner,
  result_id: `result-${sequence}`,
  instance_id: 'instance',
  revision: 1,
  status: 'active',
  created_at: new Date(),
  enabled: true,
  generation: 1,
  current_generation: 1,
});
describe('private prediction notification cursors', () => {
  it('preserves semantic fingerprints after PostgreSQL jsonb reorders nested object keys', () => {
    const first = {
      id: 'test',
      status: 'active',
      prediction: { runId: 'original', asOf: '2026-10-24T00:00:00.000Z' },
      evidence: {
        queriedAt: '2026-10-24T00:00:00.000Z',
        parameters: { mmsi: '413000001', hours: 1 },
      },
    } as unknown as AnalysisResult;
    const stored = {
      evidence: {
        parameters: { hours: 1, mmsi: '413000001' },
        queriedAt: '2026-10-24T00:00:00.000Z',
      },
      prediction: { asOf: '2026-10-24T00:00:00.000Z', runId: 'original' },
      status: 'active',
      id: 'test',
    } as unknown as AnalysisResult;
    expect(analysisFingerprint(first)).toBe(analysisFingerprint(stored));
  });
  it('filters ownership while advancing past invisible rows for both feeds', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [row('1', null), row('2', 'bob'), row('3', 'alice'), row('4', 'bob')],
    });
    const infra = { pool: { query } } as unknown as Infrastructure;
    for (const read of [readAnalysisFeed, readLiveAnalysisFeed]) {
      const page = await read(infra, '0', 100, 'alice');
      expect(page.items.map((item) => item.resultId)).toEqual(['result-1', 'result-3']);
      expect(page.nextCursor).toBe('4');
      expect((await read(infra, '0', 100)).items.map((item) => item.resultId)).toEqual([
        'result-1',
      ]);
    }
  });
});
