import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { saveLatestBatch, saveHistoryBatch } from './storage';
import {
  ensureFusionBus,
  flushReadyOutbox,
  markFusionWriterReady,
  queryFusionDataset,
  readyEventId,
  saveIntelligenceEvent,
} from './fusion-data';
import type { PositionObservation, StaticObservation } from '@ais/contracts';
import type { IntelligenceEvent, IntelligenceInput } from '../contracts/intelligence';

const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;
suite('durable fusion dataset', () => {
  let infra: Infrastructure;
  const sourceId = `fusion-${randomUUID()}`;
  const now = new Date().toISOString();
  const earlier = new Date(Date.parse(now) - 60000).toISOString();
  const mmsi = String(980000000 + Math.floor(Math.random() * 999999));
  const a: PositionObservation = {
    schemaVersion: 1,
    cleaningVersion: 1,
    kind: 'position',
    eventId: randomUUID(),
    captureId: randomUUID(),
    sourceId,
    sourceKind: 'fixture-http',
    sourcePriority: 100,
    runId: null,
    receivedAt: now,
    observedAt: earlier,
    mmsi,
    lat: 31,
    lon: 122,
    sogKnots: 5,
    cogDegrees: null,
    headingDegrees: null,
    rotDegPerMinute: null,
    navigationStatus: null,
    receptionType: 'UNKNOWN',
    quality: [],
  };
  const b = { ...a, eventId: randomUUID(), observedAt: now, lat: 31.1 };
  const staticRecord: StaticObservation = {
    schemaVersion: 1,
    cleaningVersion: 1,
    kind: 'static',
    eventId: randomUUID(),
    captureId: randomUUID(),
    sourceId,
    sourceKind: 'fixture-http',
    sourcePriority: 100,
    runId: null,
    receivedAt: earlier,
    observedAt: earlier,
    mmsi,
    quality: [],
    fields: { shipType: 70 },
  };
  let event: IntelligenceEvent;
  const input: IntelligenceInput = {
    sourceId,
    externalId: 'restriction',
    version: 1,
    status: 'active',
    category: 'port-restriction',
    title: 'Test restriction',
    summary: 'Fixture',
    publishedAt: earlier,
    effectiveFrom: earlier,
    effectiveTo: null,
    bbox: [121, 30, 123, 32],
    vesselTypes: [],
    mmsis: [mmsi],
    paragraphs: [{ id: 'p1', text: 'This test vessel is restricted.' }],
    raw: { fixture: true },
  };
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await infra.pool.query(
      await readFile(new URL('./migrations/005_postgres.sql', import.meta.url), 'utf8'),
    );
    await ensureFusionBus(infra);
    await infra.pool.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb)', [
      sourceId,
      JSON.stringify({ sourceId, name: 'Test', kind: 'file' }),
    ]);
    await infra.pool.query("INSERT INTO sources(id,name,kind) VALUES($1,'test','fixture-http')", [
      sourceId,
    ]);
  });
  afterAll(async () => {
    if (!infra) return;
    const archives = await infra.pool.query(
      'SELECT object_key FROM intelligence_archives WHERE source_id=$1',
      [sourceId],
    );
    for (const r of archives.rows)
      await infra.s3.send(
        new DeleteObjectCommand({ Bucket: infra.config.s3Bucket, Key: r.object_key }),
      );
    await infra.pool.query(
      'DELETE FROM fusion_ready_outbox WHERE id IN (SELECT id FROM intelligence_events WHERE source_id=$1) OR id=ANY($2::text[])',
      [
        sourceId,
        [
          readyEventId(a.eventId, 1),
          readyEventId(b.eventId, 1),
          readyEventId(staticRecord.eventId, 1),
        ],
      ],
    );
    await infra.pool.query('DELETE FROM fusion_writer_receipts WHERE id=ANY($1::text[])', [
      [
        readyEventId(a.eventId, 1),
        readyEventId(b.eventId, 1),
        readyEventId(staticRecord.eventId, 1),
      ],
    ]);
    await infra.pool.query(
      'DELETE FROM intelligence_relations WHERE event_id IN (SELECT id FROM intelligence_events WHERE source_id=$1)',
      [sourceId],
    );
    await infra.pool.query(
      'DELETE FROM intelligence_reviews WHERE event_id IN (SELECT id FROM intelligence_events WHERE source_id=$1)',
      [sourceId],
    );
    await infra.pool.query('DELETE FROM intelligence_events WHERE source_id=$1', [sourceId]);
    await infra.pool.query('DELETE FROM intelligence_archives WHERE source_id=$1', [sourceId]);
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=$1', [sourceId]);
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
    const identities = await infra.pool.query(
      'DELETE FROM vessel_identifiers WHERE identifier=$1 RETURNING vessel_id',
      [mmsi],
    );
    for (const r of identities.rows)
      await infra.pool.query('DELETE FROM vessel_objects WHERE id=$1', [r.vessel_id]);
    await infra.pool.query('DELETE FROM sources WHERE id=$1', [sourceId]);
    await infra.clickhouse.command({
      query: 'ALTER TABLE positions DELETE WHERE sourceId={source:String}',
      query_params: { source: sourceId },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.clickhouse.command({
      query: 'ALTER TABLE static_history_v2 DELETE WHERE sourceId={source:String}',
      query_params: { source: sourceId },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.close();
  });
  it('archives the original event, deduplicates retries, rejects changed same version', async () => {
    event = await saveIntelligenceEvent(infra, input);
    expect((await saveIntelligenceEvent(infra, input)).id).toBe(event.id);
    await expect(saveIntelligenceEvent(infra, { ...input, title: 'Mutation' })).rejects.toThrow(
      'immutable',
    );
    const object = await infra.s3.send(
      new GetObjectCommand({ Bucket: infra.config.s3Bucket, Key: event.archiveKey }),
    );
    expect(JSON.parse(await object.Body!.transformToString()).raw).toEqual({ fixture: true });
  });
  it('holds data-ready until both independently batched writer targets persist', async () => {
    await saveLatestBatch(infra, [a, b]);
    await markFusionWriterReady(infra, 'postgres', [a, b]);
    expect(
      (
        await infra.pool.query('SELECT id FROM fusion_ready_outbox WHERE id=$1', [
          readyEventId(a.eventId, 1),
        ])
      ).rowCount,
    ).toBe(0);
    await saveHistoryBatch(infra, [a]);
    await markFusionWriterReady(infra, 'clickhouse', [a]);
    expect(
      (
        await infra.pool.query('SELECT id FROM fusion_ready_outbox WHERE id=$1', [
          readyEventId(a.eventId, 1),
        ])
      ).rowCount,
    ).toBe(1);
    await saveHistoryBatch(infra, [b]);
    await markFusionWriterReady(infra, 'clickhouse', [b, a]);
    await flushReadyOutbox(infra);
    expect(
      (
        await infra.pool.query('SELECT published_at FROM fusion_ready_outbox WHERE id=$1', [
          readyEventId(a.eventId, 1),
        ])
      ).rows[0].published_at,
    ).not.toBeNull();
  });
  it('expands a late static observation through current time for historical classification', async () => {
    const started = Date.now();
    await markFusionWriterReady(infra, 'postgres', [staticRecord]);
    await markFusionWriterReady(infra, 'clickhouse', [staticRecord]);
    const ready = (
      await infra.pool.query('SELECT event FROM fusion_ready_outbox WHERE id=$1', [
        readyEventId(staticRecord.eventId, 1),
      ])
    ).rows[0].event;
    expect(ready.from).toBe(staticRecord.observedAt);
    expect(Date.parse(ready.to)).toBeGreaterThanOrEqual(started);
  });
  it('returns every historical point, stable object and withdrawn revision; fails closed on limit', async () => {
    await saveHistoryBatch(infra, [staticRecord]);
    const withdrawn = await saveIntelligenceEvent(infra, {
      ...input,
      version: 2,
      status: 'withdrawn',
      supersedesId: event.id,
    });
    const dataset = await queryFusionDataset(infra, {
      from: earlier,
      to: now,
      bbox: [121.9, 30.9, 122.1, 31.2],
    });
    const points = dataset.ais.filter((o) => o.mmsi === mmsi);
    expect(points.map((o) => o.recordId).sort()).toEqual([a.eventId, b.eventId].sort());
    expect(new Set(points.map((o) => o.vesselId)).size).toBe(1);
    expect(dataset.intelligence.map((e) => e.id)).toEqual(
      expect.arrayContaining([event.id, withdrawn.id]),
    );
    expect(points[0]?.raw.captureId).toBe(a.captureId);
    expect(points[0]?.shipType).toBe(70);
    expect(points[0]?.staticEvidence?.raw.eventId).toBe(staticRecord.eventId);
    const outside = await queryFusionDataset(infra, {
      from: earlier,
      to: now,
      bbox: [-110, -20, -100, -10],
    });
    expect(outside.intelligence.some((e) => e.sourceId === sourceId)).toBe(false);
    await expect(
      queryFusionDataset(infra, {
        from: earlier,
        to: now,
        bbox: [121.9, 30.9, 122.1, 31.2],
        maxRecords: 1,
      }),
    ).rejects.toThrow('explicit maximum');
  });
});
