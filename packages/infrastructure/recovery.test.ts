import { describe, it, expect } from 'vitest';
import { archiveIdentity, busPressure, toCamelRow } from './recovery';

describe('persistent recovery boundaries', () => {
  it('maps redelivery to exactly the same minute and sequence shard', () => {
    const a = archiveIdentity('2026-10-01T10:42:59.000Z', 10001);
    expect(a).toEqual(archiveIdentity('2026-10-01T10:42:59.000Z', 10001));
    expect(a.objectKey).toBe('raw/2026/10/01/10/42/000001.jsonl.gz');
    expect(archiveIdentity('2026-10-01T10:42:00.000Z', 19999).batchId).toBe(a.batchId);
    expect(archiveIdentity('2026-10-01T10:43:00.000Z', 10001).batchId).not.toBe(a.batchId);
  });
  it('warns at 70 percent or one hour and pauses at 85 percent or 24 hours', () => {
    expect(busPressure(69, 100, 0)).toBe('ready');
    expect(busPressure(70, 100, 0)).toBe('warning');
    expect(busPressure(1, 100, 3_600_000)).toBe('warning');
    expect(busPressure(85, 100, 0)).toBe('paused');
    expect(busPressure(1, 100, 86_400_000)).toBe('paused');
  });
  it('maps database timestamps and snake case keys to API camel case', () => {
    expect(toCamelRow({ source_id: 's', updated_at: new Date('2026-10-01T00:00:00Z') })).toEqual({
      sourceId: 's',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  });
});
