import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createInfrastructure,
  runMigrations,
  seedDemo,
  busHealth,
  invalidateBusHealth,
  assertCollectionReady,
  createRawEnvelope,
  loadRawPayload,
  saveLatestBatch,
  saveHistoryBatch,
  assessPositionQualityBatch,
  acquireLease,
  renewLease,
  releaseLease,
  archiveMessages,
  archivePorts,
  readArchive,
  toCamelRow,
  type Infrastructure,
  type ArchiveEntry,
} from './index';
import type { PositionObservation, RawEnvelope, StaticObservation } from '@ais/contracts';
import { S3Client } from '@aws-sdk/client-s3';
const integration = process.env.AIS_TEST_SCOPE === 'integration';
const suite = integration ? describe : describe.skip;
const sourceId = `integration-${randomUUID()}`;
const mmsi = String(990_000_000 + Math.floor(Math.random() * 9_000_000));
const timestamp = new Date().toISOString();
function position(eventId: string, minutes = 0, priority = 100): PositionObservation {
  return {
    schemaVersion: 1,
    cleaningVersion: 1,
    kind: 'position',
    eventId,
    captureId: `capture-${eventId}`,
    sourceId,
    sourceKind: 'fixture-http',
    sourcePriority: priority,
    runId: null,
    observedAt: new Date(Date.parse(timestamp) + minutes * 60_000).toISOString(),
    receivedAt: timestamp,
    mmsi,
    lat: 24.4,
    lon: 118.1,
    sogKnots: 12.5,
    cogDegrees: 42.2,
    headingDegrees: 359.5,
    rotDegPerMinute: null,
    navigationStatus: null,
    receptionType: 'TER',
    quality: ['synthetic'],
  };
}
suite('real persistence and recovery integration', () => {
  let infra: Infrastructure;
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await seedDemo(infra);
  });
  afterAll(async () => {
    if (!infra) return;
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM field_provenance WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM processor_position_state WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM position_quality_decisions WHERE event_id=$1', [
      `jump-${sourceId}`,
    ]);
    await infra.close();
  });
  it('reduces duplicate MMSI within a batch and preserves the newest conditional upsert', async () => {
    await saveLatestBatch(infra, [
      position('older', -2),
      position('newest', 0),
      position('tie-winner', 0, 300),
    ]);
    await saveLatestBatch(infra, [position('late-old', -1, 10000)]);
    const row = await infra.pool.query(
      'SELECT observation,heading FROM positions_latest WHERE mmsi=$1',
      [mmsi],
    );
    expect(row.rows[0]?.observation.eventId).toBe('tie-winner');
    expect(row.rows[0]?.heading).toBe(359.5);
  });
  it('merges static fields independently and retains each field provenance', async () => {
    const base = { ...position('static-new'), kind: 'static' as const };
    const incoming = (
      eventId: string,
      fields: StaticObservation['fields'],
      minutes: number,
    ): StaticObservation => ({
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'static',
      eventId,
      captureId: eventId,
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      observedAt: new Date(Date.parse(timestamp) + minutes * 60_000).toISOString(),
      receivedAt: timestamp,
      mmsi: base.mmsi,
      quality: [],
      fields,
    });
    await saveLatestBatch(infra, [
      incoming('static-new', { destination: '厦门' }, 0),
      incoming('static-old', { name: '测试船', destination: '旧目的地' }, -1),
    ]);
    const result = await infra.pool.query('SELECT static_data FROM vessels WHERE mmsi=$1', [mmsi]);
    expect(result.rows[0]?.static_data).toEqual({ name: '测试船', destination: '厦门' });
    const provenance = await infra.pool.query(
      'SELECT field,event_id FROM field_provenance WHERE mmsi=$1 ORDER BY field',
      [mmsi],
    );
    expect(provenance.rows).toEqual([
      { field: 'destination', event_id: 'static-new' },
      { field: 'name', event_id: 'static-old' },
    ]);
  });
  it('preserves processor-assessed jump quality without writer inference and rejects late stale updates', async () => {
    const baseline = position(`quality-start-${sourceId}`, 0, 300);
    await saveLatestBatch(infra, [baseline]);
    const writerOnly = { ...position(`writer-only-${sourceId}`, 1, 300), lat: -30, lon: -70 };
    await saveLatestBatch(infra, [writerOnly]);
    const direct = await infra.pool.query(
      'SELECT observation FROM positions_latest WHERE mmsi=$1',
      [mmsi],
    );
    expect(direct.rows[0]?.observation.quality).toEqual(writerOnly.quality);
    expect(direct.rows[0]?.observation.quality).not.toContain('implausible_jump');
    const unassessed = await infra.pool.query(
      'SELECT event_id FROM position_quality_decisions WHERE event_id=$1',
      [writerOnly.eventId],
    );
    expect(unassessed.rowCount).toBe(0);

    // The processor owns persisted quality state and enriches before either writer sees a point.
    await assessPositionQualityBatch(infra, [baseline]);
    const jump = { ...position(`jump-${sourceId}`, 2, 300), lat: -30, lon: -70 };
    const assessed = await assessPositionQualityBatch(infra, [jump]);
    expect(assessed[0]?.quality).toContain('implausible_jump');
    expect(jump.quality).toEqual(['synthetic']);
    await saveLatestBatch(infra, assessed);
    const marked = await infra.pool.query(
      'SELECT observation FROM positions_latest WHERE mmsi=$1',
      [mmsi],
    );
    expect(marked.rows[0]?.observation.quality).toContain('implausible_jump');
    await saveLatestBatch(infra, [position('late-after-jump', 0, 1000)]);
    const unchanged = await infra.pool.query(
      'SELECT observation FROM positions_latest WHERE mmsi=$1',
      [mmsi],
    );
    expect(unchanged.rows[0]?.observation.eventId).toBe(jump.eventId);
    expect(unchanged.rows[0]?.observation.quality).toContain('implausible_jump');
  });
  it('stores history once logically after repeated synchronous inserts', async () => {
    const observation = position(`history-${randomUUID()}`);
    await saveHistoryBatch(infra, [observation]);
    await saveHistoryBatch(infra, [observation]);
    const response = await infra.clickhouse.query({
      query: 'SELECT count() AS count FROM positions FINAL WHERE eventId={eventId:String}',
      query_params: { eventId: observation.eventId },
      format: 'JSONEachRow',
    });
    expect(Number((await response.json<{ count: string | number }>())[0]?.count)).toBe(1);
  });
  it('has all required durable consumers and halts collection on missing consumer without recreating it', async () => {
    expect((await busHealth(infra)).ready).toBe(true);
    await infra.jsm.consumers.delete('AIS_COMMANDS', 'replay');
    invalidateBusHealth(infra);
    try {
      await expect(assertCollectionReady(infra)).rejects.toThrow('Collection paused');
      expect((await busHealth(infra)).reasons).toContain('missing:consumer:replay');
    } finally {
      const { bootstrapJetstream } = await import('./bus');
      await bootstrapJetstream(infra);
      invalidateBusHealth(infra);
    }
  });
  it('uploads a bounded large response as an S3 artifact and resolves identical data', async () => {
    const payload = { rows: 'x'.repeat(300 * 1024) };
    const raw = await createRawEnvelope(infra, {
      sourceId,
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      sourcePriority: 100,
      runId: null,
      payload,
    });
    expect(raw.payload.kind).toBe('object');
    expect(await loadRawPayload(infra, raw)).toEqual(payload);
  });
  it('persists prepared raw, recovers stable S3 archive, clears PG payload and handles sequence holes', async () => {
    const time = new Date().toISOString();
    const sequence = 900_000_000 + Math.floor(Math.random() * 100_000);
    const raw = (id: string): RawEnvelope => ({
      schemaVersion: 1,
      captureId: id,
      sourceId,
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      sourcePriority: 100,
      runId: null,
      receivedAt: time,
      payload: { kind: 'inline', value: { id } },
    });
    const acked: number[] = [];
    const entry = (seq: number): ArchiveEntry => ({
      raw: raw(`archive-${seq}`),
      sequence: seq,
      ack() {
        acked.push(seq);
      },
    });
    const entries = [entry(sequence), entry(sequence + 2)];
    const ports = archivePorts(infra);
    const prepared = await ports.prepare(entries);
    expect(prepared.status).toBe('prepared');
    await archiveMessages(infra, entries);
    const manifest = await infra.pool.query('SELECT * FROM archive_batches WHERE id=$1', [
      prepared.id,
    ]);
    expect(manifest.rows[0]?.status).toBe('committed');
    expect(manifest.rows[0]?.raw_records).toEqual([]);
    expect(manifest.rows[0]?.capture_ids).toEqual([]);
    const raws = await readArchive(infra, toCamelRow(manifest.rows[0]));
    expect(raws.map((value) => value.captureId)).toEqual(
      entries.map((value) => value.raw.captureId),
    );
    await archiveMessages(infra, entries);
    expect(acked).toHaveLength(4);
    await archiveMessages(infra, [entry(sequence + 1)]);
    const count = await infra.pool.query(
      'SELECT count(*) FROM archive_batches WHERE source_id=$1',
      [sourceId],
    );
    expect(Number(count.rows[0]?.count)).toBe(2);
  });
  it('fences a stale lease owner when another acquisition takes the expired lease', async () => {
    const name = `test-lease-${randomUUID()}`;
    const first = await acquireLease(infra, name, 'first', 30);
    expect(first).not.toBeNull();
    expect(await acquireLease(infra, name, 'second', 30)).toBeNull();
    await releaseLease(infra, first!);
    const second = await acquireLease(infra, name, 'second', 30);
    expect(second).not.toBeNull();
    expect(await renewLease(infra, first!)).toBe(false);
    await releaseLease(infra, second!);
  });
  it('keeps a prepared manifest and no acknowledgments during S3 outage then recovers the same object key', async () => {
    const failureSource = `s3-failure-${randomUUID()}`;
    const sequence = 910_000_000 + Math.floor(Math.random() * 100_000);
    let acked = 0;
    const raw: RawEnvelope = {
      schemaVersion: 1,
      captureId: randomUUID(),
      sourceId: failureSource,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      adapterVersion: '1',
      runId: null,
      receivedAt: timestamp,
      payload: { kind: 'inline', value: { test: 'upload-recovery' } },
    };
    const entry: ArchiveEntry = {
      raw,
      sequence,
      ack() {
        acked++;
      },
    };
    const failedS3 = new S3Client({
      endpoint: 'http://127.0.0.1:1',
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 1,
      credentials: { accessKeyId: 'local', secretAccessKey: 'local-test' },
    });
    try {
      await expect(archiveMessages({ ...infra, s3: failedS3 }, [entry])).rejects.toThrow();
    } finally {
      failedS3.destroy();
    }
    expect(acked).toBe(0);
    const prepared = await infra.pool.query('SELECT * FROM archive_batches WHERE source_id=$1', [
      failureSource,
    ]);
    expect(prepared.rows[0]?.status).toBe('prepared');
    await archiveMessages(infra, [entry]);
    expect(acked).toBe(1);
    const recovered = await infra.pool.query('SELECT * FROM archive_batches WHERE source_id=$1', [
      failureSource,
    ]);
    expect(recovered.rowCount).toBe(1);
    expect(recovered.rows[0]?.object_key).toBe(prepared.rows[0]?.object_key);
    expect(recovered.rows[0]?.status).toBe('committed');
  });
});
