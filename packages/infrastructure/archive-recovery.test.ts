import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { parseRawEnvelope } from '@ais/contracts';
import type { Infrastructure } from './clients';
import { archivePorts } from './archive';
import { subjectToken, verifyRawIntegrity } from './bus';
import type { ArchiveEntry, ArchiveManifest } from './archive-engine';

function fixture() {
  const payload = { z: 1, a: { longer: 2, b: 3 } };
  const original = parseRawEnvelope({
    schemaVersion: 1,
    captureId: 'legacy-capture',
    sourceId: 'fixture',
    sourceKind: 'fixture-http',
    adapterVersion: '1',
    runId: null,
    receivedAt: '2026-10-01T00:00:00.000Z',
    sourcePriority: 100,
    checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
    payload: { kind: 'inline', value: payload },
  });
  const indexed = {
    ...original,
    payload: { kind: 'inline' as const, value: { a: { b: 3, longer: 2 }, z: 1 } },
  };
  const row = {
    id: 'legacy-prepared',
    bucket: 'raw',
    object_key: 'stable.jsonl.gz',
    source_id: original.sourceId,
    time_bucket: original.receivedAt,
    status: 'prepared',
    count: 1,
    first_sequence: 101,
    last_sequence: 101,
    sequence_ranges: [[101, 101]],
    raw_records: [{ raw: indexed, sequence: 101 }] as ArchiveManifest['rawRecords'],
  };
  const events: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      events.push(sql);
      if (sql.startsWith('SELECT *')) return { rowCount: 1, rows: [structuredClone(row)] };
      if (sql.startsWith('UPDATE archive_batches')) {
        row.raw_records = JSON.parse(values![1] as string);
        return {
          rowCount: 1,
          rows: [structuredClone(row)],
        };
      }
      return { rowCount: 0, rows: [] };
    }),
    release: vi.fn(),
  };
  const message = {
    seq: 101,
    subject: `ais.raw.${subjectToken(original.sourceId)}`,
    data: Buffer.from(JSON.stringify(original)),
    string: () => message.data.toString(),
  };
  const getMessage = vi.fn(async () => {
    events.push('getMessage');
    return message as typeof message | null;
  });
  const infra = {
    pool: { connect: async () => client },
    jsm: { streams: { getMessage } },
  } as unknown as Infrastructure;
  const entry: ArchiveEntry = { raw: original, sequence: 101, ack: vi.fn() };
  return { row, original, indexed, client, message, getMessage, events, entry, infra };
}

describe('prepared legacy archive serialization recovery', () => {
  it('recovers the exact retained message under the prepared row lock and preserves the index', async () => {
    const f = fixture();
    expect(() => verifyRawIntegrity(f.indexed)).toThrow('Raw payload checksum mismatch');
    const manifest = await archivePorts(f.infra).prepare([f.entry]);

    expect(f.getMessage).toHaveBeenCalledWith('AIS_RAW', { seq: 101 });
    expect(manifest.rawRecords).toEqual([
      { raw: f.indexed, sequence: 101, rawJson: f.message.string() },
    ]);
    expect(manifest.id).toBe(f.row.id);
    expect(manifest.objectKey).toBe(f.row.object_key);
    expect(f.events[0]).toBe('BEGIN');
    expect(f.events[1]).toContain('pg_advisory_xact_lock');
    expect(f.events[2]).toContain('FOR UPDATE');
    expect(f.events[3]).toBe('getMessage');
    expect(f.events[4]).toContain("status='prepared'");
    expect(f.events[5]).toBe('COMMIT');
    expect(f.client.release).toHaveBeenCalledOnce();
  });

  it('rolls back the complete batch when a later retained message is missing', async () => {
    const f = fixture();
    f.row.raw_records.push({ raw: f.indexed, sequence: 102 });
    f.row.last_sequence = 102;
    f.row.count = 2;
    f.row.sequence_ranges = [[101, 102]];
    f.getMessage.mockResolvedValueOnce(f.message).mockResolvedValueOnce(null);

    await expect(archivePorts(f.infra).prepare([f.entry])).rejects.toThrow(
      'Legacy archive raw message unavailable',
    );
    expect(f.events.at(-1)).toBe('ROLLBACK');
    expect(f.events.some((event) => event.startsWith('UPDATE'))).toBe(false);
  });

  it('accepts PostgreSQL bigint sequence bounds without weakening sequence equality', async () => {
    const f = fixture();
    Object.assign(f.row, { first_sequence: '101', last_sequence: '101' });
    const manifest = await archivePorts(f.infra).prepare([f.entry]);
    expect(manifest.rawRecords[0]?.rawJson).toBe(f.message.string());
  });

  it('reuses recovered serialization on retry without another RAW read or write', async () => {
    const f = fixture();
    await archivePorts(f.infra).prepare([f.entry]);
    const manifest = await archivePorts(f.infra).prepare([f.entry]);
    expect(manifest.rawRecords[0]?.rawJson).toBe(f.message.string());
    expect(f.getMessage).toHaveBeenCalledOnce();
    expect(f.events.filter((event) => event.startsWith('UPDATE'))).toHaveLength(1);
  });

  it('validates already retained serialization before adding another missing original', async () => {
    const f = fixture();
    f.row.last_sequence = 102;
    f.row.count = 2;
    f.row.sequence_ranges = [[101, 102]];
    f.row.raw_records.push({
      raw: f.indexed,
      sequence: 102,
      rawJson: JSON.stringify({ ...f.original, captureId: 'wrong' }),
    });
    await expect(archivePorts(f.infra).prepare([f.entry])).rejects.toThrow(
      'Legacy archive raw message disagrees with indexed envelope',
    );
    expect(f.events.at(-1)).toBe('ROLLBACK');
    expect(f.events.some((event) => event.startsWith('UPDATE'))).toBe(false);
  });

  it.each(['sequence', 'subject', 'checksum', 'captureId', 'sourceId', 'payload', 'metadata'])(
    'rejects a retained message with mismatching %s before persisting serialization',
    async (field) => {
      const f = fixture();
      if (field === 'sequence') f.message.seq = 102;
      else if (field === 'subject') f.message.subject = 'ais.raw.wrong-source';
      else {
        const changed = structuredClone(f.original);
        if (field === 'checksum') changed.checksum = '0'.repeat(64);
        if (field === 'captureId') changed.captureId = 'different-capture';
        if (field === 'sourceId') changed.sourceId = 'different-source';
        if (field === 'payload' && changed.payload.kind === 'inline') {
          changed.payload.value = { z: 9 };
          changed.checksum = createHash('sha256')
            .update(JSON.stringify(changed.payload.value))
            .digest('hex');
        }
        if (field === 'metadata') changed.sourcePriority = 1;
        f.message.data = Buffer.from(JSON.stringify(changed));
      }

      await expect(archivePorts(f.infra).prepare([f.entry])).rejects.toThrow();
      expect(f.events.at(-1)).toBe('ROLLBACK');
      expect(f.events.some((event) => event.startsWith('UPDATE'))).toBe(false);
    },
  );

  it.each(['range-hole', 'extra-range', 'duplicate-sequence', 'bounds'])(
    'fails closed for an inconsistent manifest %s',
    async (field) => {
      const f = fixture();
      if (field === 'range-hole') f.row.sequence_ranges = [[102, 102]];
      if (field === 'extra-range') f.row.sequence_ranges = [[101, 102]];
      if (field === 'duplicate-sequence') f.row.raw_records.push({ raw: f.indexed, sequence: 101 });
      if (field === 'bounds') f.row.last_sequence = 102;

      await expect(archivePorts(f.infra).prepare([f.entry])).rejects.toThrow(
        'Legacy archive manifest sequences disagree',
      );
      expect(f.getMessage).not.toHaveBeenCalled();
      expect(f.events.at(-1)).toBe('ROLLBACK');
    },
  );

  it('rejects a recovery update without the prepared status fence', async () => {
    const f = fixture();
    const originalQuery = f.client.query.getMockImplementation()!;
    f.client.query.mockImplementation(async (sql, values) => {
      if (sql.startsWith('UPDATE archive_batches')) {
        f.events.push(sql);
        return { rowCount: 0, rows: [] };
      }
      return originalQuery(sql, values);
    });

    await expect(archivePorts(f.infra).prepare([f.entry])).rejects.toThrow(
      'Legacy archive prepared status changed',
    );
    expect(f.events.at(-1)).toBe('ROLLBACK');
  });

  it('leaves committed redelivery on the normal acknowledgment path without reading RAW', async () => {
    const f = fixture();
    f.row.status = 'committed';
    f.row.raw_records = [];
    await archivePorts(f.infra).prepare([f.entry]);
    expect(f.getMessage).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe('COMMIT');
  });
});
