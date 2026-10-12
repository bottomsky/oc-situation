import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseRawEnvelope } from '@ais/contracts';
import { archivePorts } from './archive';
import { archiveBatch, compressSequences, type ArchiveEntry } from './archive-engine';
import { bootstrapJetstream, STREAMS, subjectToken, verifyRawIntegrity } from './bus';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';

const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;

suite('legacy prepared recovery from retained JetStream originals', () => {
  let infra: Infrastructure;
  const ids: string[] = [];
  const retained = new Set<number>();

  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await bootstrapJetstream(infra);
  });

  afterAll(async () => {
    if (!infra) return;
    for (const sequence of retained)
      await infra.jsm.streams.deleteMessage(STREAMS.raw.name, sequence);
    await infra.pool.query('DELETE FROM archive_batches WHERE id=ANY($1::text[])', [ids]);
    await infra.close();
  });

  async function legacyPrepared(count = 1) {
    const id = `legacy-recovery-${randomUUID()}`;
    ids.push(id);
    const receivedAt = new Date().toISOString();
    const minute = receivedAt.slice(0, 16) + ':00.000Z';
    const entries: ArchiveEntry[] = [];
    for (let index = 0; index < count; index++) {
      const payload = { z: index, a: { longer: 2, b: [3, 4] } };
      const raw = parseRawEnvelope({
        schemaVersion: 1,
        captureId: randomUUID(),
        sourceId: id,
        sourceKind: 'fixture-http',
        adapterVersion: '1',
        runId: null,
        receivedAt,
        sourcePriority: 100,
        payload: { kind: 'inline', value: payload },
        checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      });
      const published = await infra.js.publish(
        `ais.raw.${subjectToken(raw.sourceId)}`,
        JSON.stringify(raw),
        { msgID: raw.captureId },
      );
      retained.add(published.seq);
      entries.push({ raw, sequence: published.seq, ack: vi.fn() });
    }
    const sequences = entries.map((entry) => entry.sequence);
    await infra.pool.query(
      `INSERT INTO archive_batches(id,bucket,object_key,source_id,time_bucket,first_sequence,last_sequence,status,raw_records,count,min_received_at,max_received_at,expire_at,sequence_ranges)
       VALUES($1,$2,$3,$1,$4,$5,$6,'prepared',$7::jsonb,$8,$9,$9,$10,$11::jsonb)`,
      [
        id,
        infra.config.s3Bucket,
        `tests/${id}.jsonl.gz`,
        minute,
        sequences[0],
        sequences.at(-1),
        JSON.stringify(entries.map(({ raw, sequence }) => ({ raw, sequence }))),
        count,
        receivedAt,
        new Date(Date.parse(receivedAt) + 86_400_000).toISOString(),
        JSON.stringify(compressSequences(sequences)),
      ],
    );
    return { id, entries };
  }

  it('persists authenticated original text across JSONB reordering, then commits before acknowledging', async () => {
    const { id, entries } = await legacyPrepared(2);
    const before = (await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [id]))
      .rows[0];
    expect(() => verifyRawIntegrity(before.raw_records[0].raw)).toThrow('checksum');
    const ports = archivePorts(infra);
    const prepared = await ports.prepare(entries);
    const persisted = (await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [id]))
      .rows[0];
    expect(prepared.id).toBe(id);
    expect(persisted.raw_records.map(({ raw }: { raw: unknown }) => raw)).toEqual(
      before.raw_records.map(({ raw }: { raw: unknown }) => raw),
    );
    for (let index = 0; index < entries.length; index++)
      expect(persisted.raw_records[index].rawJson).toBe(JSON.stringify(entries[index]!.raw));
    expect(persisted.status).toBe('prepared');
    expect(persisted.object_key).toBe(before.object_key);

    let uploaded: Uint8Array | undefined;
    const consumed = await archiveBatch(
      {
        ...ports,
        async upload(_manifest, bytes) {
          uploaded = bytes;
          expect(entries.every((entry) => vi.mocked(entry.ack).mock.calls.length === 0)).toBe(true);
        },
      },
      entries,
    );
    expect(consumed).toBe(entries.length);
    expect(gunzipSync(uploaded!).toString()).toBe(
      entries.map((entry) => JSON.stringify(entry.raw)).join('\n') + '\n',
    );
    const committed = (await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [id]))
      .rows[0];
    expect(committed.status).toBe('committed');
    expect(committed.raw_records).toEqual([]);
    for (const entry of entries) expect(entry.ack).toHaveBeenCalledOnce();
  });

  it('rolls back every serialization addition if one retained original is unavailable', async () => {
    const { id, entries } = await legacyPrepared(2);
    const missing = entries[1]!.sequence;
    await infra.jsm.streams.deleteMessage(STREAMS.raw.name, missing);
    retained.delete(missing);
    const before = (
      await infra.pool.query('SELECT raw_records FROM archive_batches WHERE id=$1', [id])
    ).rows[0].raw_records;
    await expect(archivePorts(infra).prepare(entries)).rejects.toThrow();
    const after = (await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [id]))
      .rows[0];
    expect(after.raw_records).toEqual(before);
    expect(after.status).toBe('prepared');
    for (const entry of entries) expect(entry.ack).not.toHaveBeenCalled();
  });

  it('holds the PostgreSQL row lock while reading originals so another writer cannot commit mid-recovery', async () => {
    const { id, entries } = await legacyPrepared();
    let markRead!: () => void;
    let unblock!: () => void;
    const reading = new Promise<void>((resolve) => (markRead = resolve));
    const blocked = new Promise<void>((resolve) => (unblock = resolve));
    const getMessage = infra.jsm.streams.getMessage.bind(infra.jsm.streams);
    const instrumented = {
      ...infra,
      jsm: {
        streams: {
          async getMessage(stream: string, query: { seq: number }) {
            markRead();
            await blocked;
            return getMessage(stream, query);
          },
        },
      },
    } as unknown as Infrastructure;
    const recovering = archivePorts(instrumented).prepare(entries);
    const contender = await infra.pool.connect();
    try {
      await reading;
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout='100ms'");
      await expect(
        contender.query("UPDATE archive_batches SET status='committed' WHERE id=$1", [id]),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await contender.query('ROLLBACK');
      contender.release();
      unblock();
      await recovering;
    }
    const row = (await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [id])).rows[0];
    expect(row.status).toBe('prepared');
    expect(row.raw_records[0].rawJson).toBe(JSON.stringify(entries[0]!.raw));
  });
});
