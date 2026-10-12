import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { archiveIntelligenceRaw, intelligenceEventId, saveIntelligenceEvent } from './fusion-data';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import {
  writeGeoObject,
  writeRelation,
  intelligenceDetail,
  plotIntelligence,
  queryIntelligenceEvents,
  reviewIntelligenceEvent,
  importGeoObjects,
} from './intelligence-store';
import {
  GeoObjectInputSchema,
  RelationInputSchema,
  IntelligenceEventQuerySchema,
} from '../contracts/intelligence-spatial';
describe('intelligence PostGIS persistence', () => {
  let infra: Infrastructure;
  const sourceId = `spatial-${randomUUID()}`;
  const at = new Date().toISOString();
  let eventId: string;
  let objectId: string;
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await infra.pool.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2)', [
      sourceId,
      JSON.stringify({ sourceId, kind: 'manual' }),
    ]);
  });
  afterAll(async () => {
    await infra.close();
  });
  it('preserves immutable event while review overlay and append-only relations evolve', async () => {
    const input = {
      sourceId,
      externalId: 'a',
      version: 1,
      status: 'active' as const,
      category: 'notice' as const,
      reviewStatus: 'candidate' as const,
      title: '验证公告',
      summary: '范围',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '原文' }],
      raw: { text: '原文' },
    };
    const event = await saveIntelligenceEvent(infra, input);
    eventId = event.id;
    expect((await saveIntelligenceEvent(infra, input)).recordedAt).toBe(event.recordedAt);
    const object = await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({
        kind: 'port',
        name: sourceId,
        geometry: { type: 'Point', coordinates: [120, 30] },
      }),
    );
    objectId = object.id;
    const r = await writeRelation(
      infra,
      eventId,
      RelationInputSchema.parse({
        kind: 'occurs-at',
        objectId,
        basis: 'p原文',
        paragraphIds: ['p'],
      }),
      'actor',
    );
    expect((await plotIntelligence(infra, [eventId], false)).features).toHaveLength(0);
    const {
      id,
      eventId: _,
      revision: _revision,
      recordedAt: _recordedAt,
      createdBy: _createdBy,
      reviewedBy: _reviewedBy,
      objectSnapshot: _objectSnapshot,
      ...relationInput
    } = r;
    await writeRelation(
      infra,
      eventId,
      { ...relationInput, reviewStatus: 'confirmed' },
      'reviewer',
      id,
    );
    await infra.pool.query(
      'INSERT INTO intelligence_reviews(event_id,review_status,actor) VALUES($1,$2,$3)',
      [eventId, 'confirmed', 'reviewer'],
    );
    const detail = await intelligenceDetail(infra, eventId);
    expect(detail?.relations[0]?.revision).toBe(2);
    expect(detail?.history).toHaveLength(3);
    expect(detail?.event.reviewStatus).toBe('confirmed');
    expect(
      (await infra.pool.query('SELECT event FROM intelligence_events WHERE id=$1', [eventId]))
        .rows[0].event.reviewStatus,
    ).toBe('candidate');
    await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({
        id: object.id,
        kind: 'port',
        name: sourceId,
        geometry: { type: 'Point', coordinates: [125, 35] },
      }),
    );
    expect((await plotIntelligence(infra, [eventId], false)).features[0]?.geometry).toEqual({
      type: 'Point',
      coordinates: [120, 30],
    });
    const page = await queryIntelligenceEvents(
      infra,
      IntelligenceEventQuerySchema.parse({
        objectId,
        bbox: '119,29,121,31',
        reviewStatus: 'confirmed',
        latest: 'true',
      }),
    );
    expect(page.items.map((e) => e.id)).toContain(eventId);
  });
  it('rejects invalid topology and never leaves half a geometry stored', async () => {
    await expect(
      writeGeoObject(
        infra,
        GeoObjectInputSchema.parse({
          kind: 'area',
          name: sourceId + 'invalid',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [2, 2],
                [0, 2],
                [2, 0],
                [0, 0],
              ],
            ],
          },
        }),
      ),
    ).rejects.toThrow();
  });
  it('atomically rolls back import and blocks publication-only time approval', async () => {
    const first = GeoObjectInputSchema.parse({
      id: sourceId + 'atomic',
      kind: 'port',
      name: '正常港口',
      geometry: { type: 'Point', coordinates: [120, 30] },
    });
    const second = GeoObjectInputSchema.parse({
      kind: 'area',
      name: '自交区域',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0, 0],
            [2, 2],
            [0, 2],
            [2, 0],
            [0, 0],
          ],
        ],
      },
    });
    await expect(importGeoObjects(infra, [first, second])).rejects.toThrow();
    expect(
      (
        await infra.pool.query(
          'SELECT id FROM intelligence_objects WHERE id=' + String.fromCharCode(36) + '1',
          [first.id],
        )
      ).rowCount,
    ).toBe(0);
    const event = await saveIntelligenceEvent(infra, {
      sourceId,
      externalId: 'pending-time',
      status: 'active',
      version: 1,
      category: 'notice',
      reviewStatus: 'candidate',
      title: '缺有效时间',
      summary: '原文仅发布时间',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '原文' }],
      raw: { requiresEffectiveTimeReview: true },
    });
    await expect(reviewIntelligenceEvent(infra, event.id, 'confirmed', 'reviewer')).rejects.toThrow(
      '请先修订并确认实际有效时间',
    );
  });
  it('migrates legacy spatial evidence in a fresh schema without fabricating reviewer identity', async () => {
    const c = await infra.pool.connect();
    const schema = 'migration_' + randomUUID().replaceAll('-', '');
    try {
      await c.query('BEGIN');
      await c.query(`CREATE SCHEMA ${schema}`);
      await c.query(`SET LOCAL search_path TO ${schema},public`);
      for (const v of ['001', '002', '003', '004', '005', '006', '007'])
        await c.query(
          await readFile(new URL(`./migrations/${v}_postgres.sql`, import.meta.url), 'utf8'),
        );
      await c.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2)', [sourceId, '{}']);
      const payload = {
        sourceId,
        externalId: 'legacy',
        version: 1,
        status: 'active',
        category: 'notice',
        title: '旧公告',
        summary: '旧',
        publishedAt: at,
        effectiveFrom: at,
        effectiveTo: null,
        bbox: [120, 29, 121, 30],
        mmsis: ['913456789'],
        vesselTypes: [],
        paragraphs: [{ id: 'p', text: '旧原文' }],
        raw: {},
      };
      await c.query(
        'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event) VALUES($1,$2,$3,1,$4,$4,$5)',
        [sourceId + 'legacy', sourceId, 'legacy', at, JSON.stringify(payload)],
      );
      await c.query(
        await readFile(new URL('./migrations/008_postgres.sql', import.meta.url), 'utf8'),
      );
      const statsMigration = await readFile(
        new URL('./migrations/009_postgres.sql', import.meta.url),
        'utf8',
      );
      await c.query(statsMigration);
      await c.query(statsMigration);
      const compatibilityMigration = await readFile(
        new URL('./migrations/010_postgres.sql', import.meta.url),
        'utf8',
      );
      await c.query(compatibilityMigration);
      await c.query('ALTER TABLE intelligence_archives DROP COLUMN source_urls');
      await c.query(
        'ALTER TABLE intelligence_objects DROP CONSTRAINT intelligence_objects_geom_check',
      );
      await c.query(
        'ALTER TABLE intelligence_relations DROP CONSTRAINT intelligence_relations_geom_check',
      );
      await c.query(compatibilityMigration);
      await c.query(compatibilityMigration);
      expect((await c.query('SELECT source_urls FROM intelligence_archives')).rowCount).toBe(0);
      const geometryChecks = await c.query(
        "SELECT conname FROM pg_constraint WHERE conrelid IN ('intelligence_objects'::regclass,'intelligence_relations'::regclass) AND conname IN ('intelligence_objects_geom_check','intelligence_relations_geom_check')",
      );
      expect(geometryChecks.rows).toHaveLength(2);
      await c.query(
        'UPDATE intelligence_sources SET last_polled_at=$2,last_error=NULL WHERE id=$1',
        [sourceId, at],
      );
      const failedSource = sourceId + 'failed';
      await c.query(
        "INSERT INTO intelligence_sources(id,config,last_polled_at,last_error,last_ingestion) VALUES($1,'{}',$2,'fetch failed','{\"failed\":true}')",
        [failedSource, at],
      );
      const successMigration = await readFile(
        new URL('./migrations/011_postgres.sql', import.meta.url),
        'utf8',
      );
      await c.query(successMigration);
      expect(
        (
          await c.query('SELECT last_successful_at FROM intelligence_sources WHERE id=$1', [
            sourceId,
          ])
        ).rows[0].last_successful_at.toISOString(),
      ).toBe(at);
      expect(
        (
          await c.query('SELECT last_successful_at FROM intelligence_sources WHERE id=$1', [
            failedSource,
          ])
        ).rows[0].last_successful_at,
      ).toBeNull();
      await c.query(
        "UPDATE intelligence_sources SET last_polled_at=now(),last_error='later failure',last_ingestion='{\"failed\":true}' WHERE id=$1",
        [sourceId],
      );
      await c.query(successMigration);
      expect(
        (
          await c.query('SELECT last_successful_at FROM intelligence_sources WHERE id=$1', [
            sourceId,
          ])
        ).rows[0].last_successful_at.toISOString(),
      ).toBe(at);
      expect(
        (await c.query('SELECT last_ingestion FROM intelligence_sources WHERE id=$1', [sourceId]))
          .rows[0].last_ingestion,
      ).toEqual({ failed: true });
      const rows = (await c.query('SELECT data FROM intelligence_relations')).rows;
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.data.origin === 'legacy' && !r.data.reviewedBy)).toBe(true);
      expect(
        (
          await c.query('SELECT valid_from FROM vessel_identifiers')
        ).rows[0].valid_from.toISOString(),
      ).toBe(at);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
  it('keeps explicit historical geometry distinct from live AIS vessel observations', async () => {
    const mmsi = String(980000000 + Math.floor(Math.random() * 999999));
    const vessel = await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({ kind: 'vessel', name: '验证船', mmsi }),
    );
    await infra.pool.query('INSERT INTO vessels(mmsi) VALUES($1)', [mmsi]);
    await infra.pool.query(
      "INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,observation) VALUES($1,$2,$2,$3,'fixture',1,$4,$4,1,31,122,ST_SetSRID(ST_MakePoint(122,31),4326)::geography,'{}')",
      [mmsi, 'position-' + randomUUID(), sourceId, at],
    );
    await writeRelation(
      infra,
      eventId,
      RelationInputSchema.parse({
        kind: 'involves',
        objectId: vessel.id,
        geometry: { type: 'Point', coordinates: [121, 30] },
        basis: '历史事件位置',
        reviewStatus: 'confirmed',
        origin: 'manual',
      }),
      'reviewer',
    );
    const plot = await plotIntelligence(infra, [eventId], false);
    const features = plot.features.filter((f) => f.properties.objectId === vessel.id);
    expect(features).toHaveLength(2);
    expect(features.map((f) => f.properties.positionSource)).toEqual(['relation', 'ais-latest']);
    expect(features[1]?.properties.observedAt).toBe(at);
    expect(features[1]?.properties.synthetic).toBe(false);
    await infra.pool.query('UPDATE positions_latest SET observation=$2::jsonb WHERE mmsi=$1', [
      mmsi,
      JSON.stringify({ quality: ['synthetic'] }),
    ]);
    await writeRelation(
      infra,
      eventId,
      RelationInputSchema.parse({
        kind: 'mentions',
        objectId: vessel.id,
        basis: '仅船舶标识关联',
        reviewStatus: 'confirmed',
        origin: 'manual',
      }),
      'reviewer',
    );
    const sampleFeatures = (await plotIntelligence(infra, [eventId], false)).features.filter(
      (f) => f.properties.objectId === vessel.id && f.properties.positionSource === 'ais-latest',
    );
    expect(sampleFeatures).toHaveLength(2);
    expect(sampleFeatures.every((f) => f.properties.synthetic === true)).toBe(true);
  });
  it('creates spatial intersection suggestions only as candidate relations', async () => {
    const object = await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({
        kind: 'area',
        name: sourceId + 'intersection',
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [110, 10],
              [112, 10],
              [112, 12],
              [110, 12],
              [110, 10],
            ],
          ],
        },
      }),
    );
    const event = await saveIntelligenceEvent(infra, {
      sourceId,
      externalId: 'spatial-suggestion',
      status: 'active',
      version: 1,
      category: 'notice',
      reviewStatus: 'candidate',
      title: '原文位置',
      summary: '候选',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '110E 10N' }],
      raw: {},
      relations: [
        RelationInputSchema.parse({
          kind: 'occurs-at',
          geometry: { type: 'Point', coordinates: [110, 10] },
          basis: '来源坐标',
          paragraphIds: ['p'],
          reviewStatus: 'confirmed',
          origin: 'source',
        }),
      ],
    });
    const detail = await intelligenceDetail(infra, event.id);
    const suggestion = detail?.relations.find((r) => r.objectId === object.id);
    expect(suggestion?.origin).toBe('rule');
    expect(suggestion?.reviewStatus).toBe('candidate');
    expect(suggestion?.kind).toBe('applies-to');
    expect(
      (await plotIntelligence(infra, [event.id], false)).features.every(
        (f) => f.properties.objectId !== object.id,
      ),
    ).toBe(true);
  });
  it('keeps future review windows ordered and supports dateline spatial filtering', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const event = await saveIntelligenceEvent(infra, {
      sourceId,
      externalId: 'future-dateline',
      status: 'active',
      version: 1,
      category: 'notice',
      reviewStatus: 'candidate',
      title: '跨日期线未来公告',
      summary: '原文坐标',
      publishedAt: at,
      effectiveFrom: future,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '公告真实未来生效日期' }],
      raw: {},
      relations: [
        RelationInputSchema.parse({
          kind: 'applies-to',
          geometry: {
            type: 'MultiPoint',
            coordinates: [
              [179, 10],
              [-179, 10],
            ],
          },
          basis: '原文坐标',
          origin: 'source',
          reviewStatus: 'confirmed',
        }),
      ],
    });
    await reviewIntelligenceEvent(infra, event.id, 'confirmed', 'reviewer');
    const ready = (
      await infra.pool.query(
        "SELECT event FROM fusion_ready_outbox WHERE event->'recordIds' @> $1::jsonb ORDER BY created_at DESC LIMIT 1",
        [JSON.stringify([event.id])],
      )
    ).rows[0].event;
    expect(Date.parse(ready.from)).toBeLessThanOrEqual(Date.parse(ready.to));
    const page = await queryIntelligenceEvents(
      infra,
      IntelligenceEventQuerySchema.parse({ sourceId, bbox: '170,0,-170,20', latest: 'true' }),
    );
    expect(page.items.map((e) => e.id)).toContain(event.id);
    expect((await plotIntelligence(infra, [event.id], false)).features[0]?.properties.status).toBe(
      'future',
    );
  });
  it('preserves maintained vessel directory data when projecting legacy MMSI evidence', async () => {
    const mmsi = String(960000000 + Math.floor(Math.random() * 999999));
    const object = await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({
        kind: 'vessel',
        name: '人工维护船名',
        mmsi,
        aliases: ['旧船名'],
        geometry: { type: 'Point', coordinates: [118, 24] },
        metadata: { operatorNote: '人工核验', originalUrl: 'https://example.com/vessel' },
      }),
    );
    const input = {
      sourceId,
      externalId: 'legacy-vessel-preserve',
      status: 'active' as const,
      version: 1,
      category: 'notice' as const,
      title: '船舶公告',
      summary: '原文',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [mmsi],
      paragraphs: [{ id: 'p', text: '原文MMSI' }],
      raw: {},
    };
    const first = await saveIntelligenceEvent(infra, input);
    const second = await saveIntelligenceEvent(infra, {
      ...input,
      version: 2,
      supersedesId: first.id,
      status: 'revised',
      summary: '修订原文',
    });
    const persisted = (
      await infra.pool.query('SELECT data FROM intelligence_objects WHERE id=$1', [object.id])
    ).rows[0].data;
    expect(persisted).toEqual(object);
    for (const event of [first, second]) {
      const plot = await plotIntelligence(infra, [event.id], false);
      expect(plot.features[0]?.properties.objectId).toBe(object.id);
      expect(plot.features[0]?.properties.objectName).toBe('人工维护船名');
      expect(plot.features[0]?.geometry).toEqual(object.geometry);
    }
  });
  it('finds keywords appearing only in original paragraphs beyond the summary', async () => {
    const keyword = '正文独有-' + randomUUID();
    const event = await saveIntelligenceEvent(infra, {
      sourceId,
      externalId: 'paragraph-keyword',
      version: 1,
      status: 'active',
      category: 'notice',
      title: '公告标题',
      summary: '摘要没有检索词',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '前文'.repeat(6000) + keyword }],
      raw: {},
    });
    const result = await queryIntelligenceEvents(
      infra,
      IntelligenceEventQuerySchema.parse({ sourceId, keyword, latest: 'true' }),
    );
    expect(result.items.map((e) => e.id)).toEqual([event.id]);
  });
  it('filters visible vessel relations by live AIS while retaining independent historical geometry', async () => {
    const mmsi = String(950000000 + Math.floor(Math.random() * 999999));
    const vessel = await writeGeoObject(
      infra,
      GeoObjectInputSchema.parse({ kind: 'vessel', name: '视野关联船', mmsi }),
    );
    await infra.pool.query('INSERT INTO vessels(mmsi) VALUES($1)', [mmsi]);
    await infra.pool.query(
      "INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,observation) VALUES($1,$2,$2,$3,'fixture',1,$4,$4,1,30,120,ST_SetSRID(ST_MakePoint(120,30),4326)::geography,'{}')",
      [mmsi, 'view-' + randomUUID(), sourceId, at],
    );
    const input = {
      sourceId,
      externalId: 'view-live-vessel',
      version: 1,
      status: 'active' as const,
      category: 'notice' as const,
      title: '关联船情报',
      summary: '仅标识关联',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '船舶名称' }],
      raw: {},
    };
    const event = await saveIntelligenceEvent(infra, input);
    const relation = await writeRelation(
      infra,
      event.id,
      RelationInputSchema.parse({
        kind: 'mentions',
        objectId: vessel.id,
        basis: '原文关联船名',
        reviewStatus: 'confirmed',
      }),
      'reviewer',
    );
    const query = () =>
      queryIntelligenceEvents(
        infra,
        IntelligenceEventQuerySchema.parse({
          sourceId,
          objectId: vessel.id,
          bbox: '119,29,121,31',
          latest: 'true',
        }),
      );
    expect((await query()).items.map((e) => e.id)).toContain(event.id);
    await infra.pool.query(
      'UPDATE positions_latest SET longitude=130,latitude=40,location=ST_SetSRID(ST_MakePoint(130,40),4326)::geography WHERE mmsi=$1',
      [mmsi],
    );
    expect((await query()).items).toEqual([]);
    await writeRelation(
      infra,
      event.id,
      RelationInputSchema.parse({
        kind: 'mentions',
        objectId: vessel.id,
        geometry: { type: 'Point', coordinates: [120, 30] },
        basis: '原文明示历史坐标',
        reviewStatus: 'confirmed',
      }),
      'reviewer',
      relation.id,
    );
    expect((await query()).items.map((e) => e.id)).toContain(event.id);
  });
  it('replays pre-upgrade immutable evidence without adding defaults to archives or accepting altered facts', async () => {
    const input = {
      sourceId,
      externalId: 'pre-upgrade-replay',
      version: 1,
      status: 'active' as const,
      category: 'notice' as const,
      title: '升级前公告',
      summary: '原摘要',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      vesselTypes: [],
      mmsis: [],
      paragraphs: [{ id: 'p', text: '升级前原文' }],
      raw: { text: '升级前原文' },
    };
    const bytes = Buffer.from(JSON.stringify(input));
    const archive = await archiveIntelligenceRaw(infra, sourceId, bytes, 'application/json');
    const legacy = {
      ...input,
      id: intelligenceEventId(sourceId, input.externalId, 1),
      archiveKey: archive.archiveKey,
      checksum: archive.checksum,
      recordedAt: at,
    };
    await infra.pool.query(
      'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event) VALUES($1,$2,$3,1,$4,$4,$5::jsonb)',
      [legacy.id, sourceId, input.externalId, at, JSON.stringify(legacy)],
    );
    const archiveCount = (
      await infra.pool.query(
        'SELECT count(*)::int count FROM intelligence_archives WHERE source_id=$1',
        [sourceId],
      )
    ).rows[0].count;
    expect(await saveIntelligenceEvent(infra, input)).toEqual(legacy);
    await expect(saveIntelligenceEvent(infra, { ...input, title: '改变标题' })).rejects.toThrow(
      'immutable',
    );
    await expect(
      saveIntelligenceEvent(infra, { ...input, raw: { text: '改变原文' } }),
    ).rejects.toThrow('immutable');
    const persisted = (
      await infra.pool.query('SELECT event FROM intelligence_events WHERE id=$1', [legacy.id])
    ).rows[0].event;
    expect(persisted).toEqual(legacy);
    const object = await infra.s3.send(
      new GetObjectCommand({ Bucket: infra.config.s3Bucket, Key: archive.archiveKey }),
    );
    expect(Buffer.from(await object.Body!.transformToByteArray())).toEqual(bytes);
    expect(
      (
        await infra.pool.query(
          'SELECT count(*)::int count FROM intelligence_archives WHERE source_id=$1',
          [sourceId],
        )
      ).rows[0].count,
    ).toBe(archiveCount);
    const modernInput = {
      ...input,
      externalId: 'modern-checksum-replay',
      reviewStatus: 'confirmed' as const,
      relations: [],
    };
    const [modern, replayed] = await Promise.all([
      saveIntelligenceEvent(infra, modernInput),
      saveIntelligenceEvent(infra, modernInput),
    ]);
    expect(replayed).toEqual(modern);
    await expect(
      saveIntelligenceEvent(infra, {
        ...modernInput,
        relations: [
          RelationInputSchema.parse({
            kind: 'occurs-at',
            geometry: { type: 'Point', coordinates: [120, 30] },
            basis: '改变新版空间证据',
          }),
        ],
      }),
    ).rejects.toThrow('immutable');
  });
});
