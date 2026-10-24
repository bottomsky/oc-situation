import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createInfrastructure, type Infrastructure } from './clients';
import { createApi } from '../../apps/api/src/app';
import { csrfToken, hashToken } from '../../apps/api/src/auth/security';
import { processNextTopicRun } from '../../apps/topics';
import { executePredictionTopic } from '../../apps/topics/prediction-execution';
import { cancelPrediction, requestPrediction, setPredictionWatch } from './predictions';
import { checkPredictionPaths } from './predictions-land';
import { claimTopicRun, completeTopicRun, saveTopicInput } from './topics';
import { saveHistoryBatch, saveLatestBatch } from './storage';
import type { PositionObservation } from '../contracts';

describe('owned prediction tasks on isolated PostgreSQL, PostGIS and ClickHouse', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  const owner = randomUUID(),
    other = randomUUID(),
    viewer = randomUUID();
  const source = `prediction-${randomUUID()}`;
  const mmsi = String(960000000 + randomInt(100000));
  const landVersion = `prediction-island-${randomUUID()}`;
  const origin = 'http://127.0.0.1:13001';
  const tokens = new Map<string, string>();
  const instanceIds: string[] = [];
  const headers = (id = owner) => ({
    Cookie: `ais_session=${tokens.get(id)!}`,
    Origin: origin,
    'X-CSRF-Token': csrfToken(tokens.get(id)!),
  });
  beforeAll(async () => {
    if (
      new URL(process.env.DATABASE_URL ?? '').port !== '15433' ||
      new URL(process.env.CLICKHOUSE_URL ?? '').port !== '18124'
    )
      throw new Error('Prediction fixtures require isolated integration ports');
    infra = await createInfrastructure();
    for (const [id, role] of [
      [owner, 'operator'],
      [other, 'operator'],
      [viewer, 'viewer'],
    ]) {
      const token = randomBytes(32).toString('base64url');
      tokens.set(id!, token);
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',
        [id, `prediction-${id}`, 'unused', role],
      );
      await infra.pool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [hashToken(token), id],
      );
    }
    await infra.pool.query(
      "INSERT INTO route_datasets(version,manifest,navigation_status) VALUES($1,'{\"fixture\":true}','ready')",
      [landVersion],
    );
    await infra.pool.query(
      'INSERT INTO route_land(dataset_version,geom,geog) VALUES($1,ST_MakeEnvelope(10,10,10.1,10.1,4326),ST_MakeEnvelope(10,10,10.1,10.1,4326)::geography)',
      [landVersion],
    );
    api = await createApi(infra, { scheduler: false, origins: [origin] });
  });
  afterAll(async () => {
    if (api) await api.stop();
    if (!infra) return;
    const ids = (
      await infra.pool.query(
        'SELECT instance_id FROM prediction_topics WHERE owner_id=ANY($1::text[])',
        [[owner, other, viewer]],
      )
    ).rows.map((row) => row.instance_id);
    await infra.pool.query(
      'DELETE FROM analysis_prediction_artifacts WHERE result_id IN (SELECT id FROM analysis_results WHERE instance_id=ANY($1::uuid[]))',
      [ids],
    );
    await infra.pool.query('DELETE FROM analysis_feed WHERE instance_id=ANY($1::uuid[])', [ids]);
    await infra.pool.query(
      'DELETE FROM analysis_revisions WHERE result_id IN (SELECT id FROM analysis_results WHERE instance_id=ANY($1::uuid[]))',
      [ids],
    );
    await infra.pool.query('DELETE FROM analysis_results WHERE instance_id=ANY($1::uuid[])', [ids]);
    await infra.pool.query('DELETE FROM prediction_requests WHERE owner_id=ANY($1::text[])', [
      [owner, other, viewer],
    ]);
    await infra.pool.query('DELETE FROM topic_runs WHERE instance_id=ANY($1::uuid[])', [ids]);
    await infra.pool.query('DELETE FROM prediction_topics WHERE owner_id=ANY($1::text[])', [
      [owner, other, viewer],
    ]);
    await infra.pool.query('DELETE FROM topic_instances WHERE id=ANY($1::uuid[])', [ids]);
    await infra.pool.query('DELETE FROM route_land WHERE dataset_version=$1', [landVersion]);
    await infra.pool.query('DELETE FROM route_datasets WHERE version=$1', [landVersion]);
    await infra.pool.query('DELETE FROM intelligence_events WHERE source_id=$1', [source]);
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=$1', [source]);
    const vessels = (
      await infra.pool.query(
        'SELECT id FROM vessel_objects WHERE id IN (SELECT vessel_id FROM vessel_identifiers WHERE identifier=$1)',
        [mmsi],
      )
    ).rows.map((row) => row.id);
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessel_identifiers WHERE identifier=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessel_objects WHERE id=ANY($1::uuid[])', [vessels]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [
      [owner, other, viewer],
    ]);
    await infra.pool.query('DELETE FROM audit WHERE user_id=ANY($1::uuid[])', [
      [owner, other, viewer],
    ]);
    await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, other, viewer]]);
    await infra.clickhouse.command({
      query: 'ALTER TABLE positions DELETE WHERE sourceId={source:String}',
      query_params: { source },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.close();
  });
  it('queues an idempotent API task, executes the real worker and freezes each artifact revision', async () => {
    const feedCursor = String(
      (await infra.pool.query('SELECT coalesce(max(sequence),0) cursor FROM analysis_feed')).rows[0]
        .cursor,
    );
    const key = randomUUID();
    const first = await request(api.app.getHttpServer())
      .post('/api/v1/topics/predictions')
      .set(headers())
      .set('Idempotency-Key', key)
      .send({ mmsi })
      .expect(202);
    instanceIds.push(first.body.instanceId);
    const replay = await request(api.app.getHttpServer())
      .post('/api/v1/topics/predictions')
      .set(headers())
      .set('Idempotency-Key', key)
      .send({ mmsi })
      .expect(202);
    expect(replay.body).toEqual(first.body);
    await request(api.app.getHttpServer())
      .post('/api/v1/topics/predictions')
      .set(headers())
      .set('Idempotency-Key', key)
      .send({ mmsi, watch: true })
      .expect(409);
    expect(await processNextTopicRun(infra, 'vessel-reachability', first.body.instanceId)).toBe(
      true,
    );
    const read = await request(api.app.getHttpServer())
      .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
      .set(headers())
      .expect(200);
    const item = read.body.items[0];
    const ownerFeed = await request(api.app.getHttpServer())
      .get(`/api/v1/analysis/feed?cursor=${feedCursor}`)
      .set(headers())
      .expect(200);
    const foreignFeed = await request(api.app.getHttpServer())
      .get(`/api/v1/analysis/feed?cursor=${feedCursor}`)
      .set(headers(other))
      .expect(200);
    expect(
      ownerFeed.body.items.some((value: { resultId: string }) => value.resultId === item.id),
    ).toBe(true);
    expect(
      foreignFeed.body.items.some((value: { resultId: string }) => value.resultId === item.id),
    ).toBe(false);
    expect(BigInt(foreignFeed.body.nextCursor)).toBeGreaterThan(BigInt(feedCursor));
    expect(
      Number(
        (
          await infra.pool.query(
            'SELECT count(*) count FROM event_sync_outbox WHERE source_key=$1',
            [JSON.stringify(['analysis', item.id])],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(item).toMatchObject({
      runId: first.body.runId,
      status: 'insufficient_data',
      prediction: { status: 'insufficient_data' },
      impacts: [],
    });
    const original = await request(api.app.getHttpServer())
      .get(`/api/v1/analysis/results/${item.id}/artifact?revision=1`)
      .set(headers())
      .expect(200);
    expect(original.body).not.toHaveProperty('paths');
    await request(api.app.getHttpServer())
      .get(`/api/v1/analysis/results/${item.id}/artifact?revision=1`)
      .set(headers(other))
      .expect(404);
    const second = await requestPrediction(infra, owner, { mmsi }, randomUUID());
    await processNextTopicRun(infra, 'vessel-reachability', second.instanceId);
    const current = await request(api.app.getHttpServer())
      .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
      .set(headers())
      .expect(200);
    expect(current.body.items[0].revision).toBe(2);
    const currentInstance = (
      await infra.pool.query('SELECT generation FROM topic_instances WHERE id=$1', [
        first.body.instanceId,
      ])
    ).rows[0];
    const scheduledId = randomUUID();
    await infra.pool.query(
      "INSERT INTO topic_runs(id,instance_id,generation,trigger,request_key,from_time,to_time) VALUES($1,$2,$3,'scheduled',$4,now()-interval '60 minutes',now())",
      [scheduledId, first.body.instanceId, currentInstance.generation, randomUUID()],
    );
    const scheduledLease = await claimTopicRun(infra, 'vessel-reachability', first.body.instanceId);
    expect(scheduledLease!.run.id).toBe(scheduledId);
    const coalesced = await requestPrediction(infra, owner, { mmsi }, randomUUID());
    expect(coalesced.runId).toBe(scheduledId);
    const reused = await executePredictionTopic(
      infra,
      scheduledLease!,
      new AbortController().signal,
    );
    expect(reused.artifacts).toEqual({});
    expect(await completeTopicRun(infra, scheduledLease!, reused.results, reused.artifacts)).toBe(
      true,
    );
    const completedReuse = await request(api.app.getHttpServer())
      .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
      .set(headers())
      .expect(200);
    expect(completedReuse.body.items[0]).toMatchObject({
      runId: scheduledId,
      reused: true,
      sourceRunId: current.body.items[0].runId,
      revision: 2,
      prediction: { asOf: current.body.items[0].prediction.asOf },
    });
    expect(
      (
        await request(api.app.getHttpServer())
          .get(`/api/v1/analysis/results/${item.id}/artifact?revision=1`)
          .set(headers())
          .expect(200)
      ).body,
    ).toEqual(original.body);
    const all = await request(api.app.getHttpServer())
      .get('/api/v1/topics/predictions')
      .set(headers())
      .expect(200);
    expect(all.body.items[0]).not.toHaveProperty('prediction');
    expect(
      (
        await request(api.app.getHttpServer())
          .get('/api/v1/topics/predictions')
          .set(headers(other))
          .expect(200)
      ).body.items,
    ).toEqual([]);
  });
  it('requires operator and CSRF, keeps ownership private and caps twenty watches transactionally', async () => {
    await request(api.app.getHttpServer())
      .post('/api/v1/topics/predictions')
      .set(headers(viewer))
      .set('Idempotency-Key', randomUUID())
      .send({ mmsi })
      .expect(403);
    await request(api.app.getHttpServer())
      .post('/api/v1/topics/predictions')
      .set('Cookie', headers().Cookie)
      .set('Idempotency-Key', randomUUID())
      .send({ mmsi })
      .expect(403);
    const target = instanceIds[0]!;
    await request(api.app.getHttpServer())
      .put(`/api/v1/topics/predictions/${target}/watch`)
      .set(headers(other))
      .send({ watch: true })
      .expect(404);
    for (let index = 0; index < 20; index++) {
      const result = await requestPrediction(
        infra,
        owner,
        { mmsi: String(950000000 + index), watch: true },
        randomUUID(),
      );
      instanceIds.push(result.instanceId);
    }
    await expect(setPredictionWatch(infra, owner, target, true)).rejects.toMatchObject({
      category: 'capacity',
    });
    await cancelPrediction(infra, owner, instanceIds[1]!);
    await expect(setPredictionWatch(infra, owner, target, true)).resolves.toMatchObject({
      watch: true,
    });
    for (const id of instanceIds) await cancelPrediction(infra, owner, id);
  });
  it('fences cancellation before a result can be committed', async () => {
    const queued = await requestPrediction(infra, owner, { mmsi }, randomUUID());
    const lease = await claimTopicRun(infra, 'vessel-reachability', queued.instanceId);
    expect(lease).not.toBeNull();
    const at = new Date().toISOString();
    await saveTopicInput(infra, lease!, {
      from: at,
      to: at,
      queriedAt: at,
      ais: [],
      intelligence: [],
    });
    await cancelPrediction(infra, owner, queued.instanceId);
    expect(await completeTopicRun(infra, lease!, [])).toBe(false);
  });
  it('checks the full line against a real PostGIS island even when both endpoints are at sea', async () => {
    const at = new Date().toISOString();
    const paths = Array.from({ length: 2048 }, (_, id) => ({
      id,
      points: [
        { at, coordinate: [9.9, id % 2 ? 9 : 10.05] as [number, number] },
        { at, coordinate: [10.2, id % 2 ? 9 : 10.05] as [number, number] },
      ],
    }));
    const navigable = await checkPredictionPaths(infra, landVersion, paths);
    expect(navigable.filter(Boolean)).toHaveLength(1024);
    expect(navigable[0]).toBe(false);
    expect(navigable[1]).toBe(true);
  });
  it('reads recent ClickHouse AIS and persists a real ready model with its fixed land dataset', async () => {
    const previous = (
      await infra.pool.query('SELECT version FROM route_datasets WHERE active')
    ).rows.map((row) => row.version);
    try {
      await infra.pool.query('UPDATE route_datasets SET active=false WHERE active');
      await infra.pool.query('UPDATE route_datasets SET active=true WHERE version=$1', [
        landVersion,
      ]);
      const now = Date.now();
      const observations: PositionObservation[] = [5, 3, 1].map((minutes, index) => ({
        schemaVersion: 1,
        cleaningVersion: 1,
        kind: 'position',
        eventId: randomUUID(),
        captureId: randomUUID(),
        sourceId: source,
        sourceKind: 'fixture-http',
        sourcePriority: 10,
        runId: null,
        observedAt: new Date(now - minutes * 60000).toISOString(),
        receivedAt: new Date(now - minutes * 60000).toISOString(),
        mmsi,
        lat: 0,
        lon: 120 + index * 0.01,
        sogKnots: 18,
        cogDegrees: 90,
        headingDegrees: 90,
        rotDegPerMinute: null,
        navigationStatus: null,
        receptionType: 'UNKNOWN',
        quality: [],
      }));
      const training = [90, 88, 86].map((minutes, index) => ({
        ...observations[index]!,
        eventId: randomUUID(),
        captureId: randomUUID(),
        observedAt: new Date(now - minutes * 60000).toISOString(),
        receivedAt: new Date(now - minutes * 60000).toISOString(),
        lon: 119 + index * 0.01,
      }));
      const futureObservation = {
        ...observations[0]!,
        eventId: randomUUID(),
        captureId: randomUUID(),
        observedAt: new Date(now + 60000).toISOString(),
        receivedAt: new Date(now + 60000).toISOString(),
      };
      await saveHistoryBatch(infra, [...training, ...observations, futureObservation]);
      await saveLatestBatch(infra, observations);
      const queued = await requestPrediction(infra, owner, { mmsi }, randomUUID());
      await processNextTopicRun(infra, 'vessel-reachability', queued.instanceId);
      const result = await request(api.app.getHttpServer())
        .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
        .set(headers())
        .expect(200);
      expect(result.body.items[0]).toMatchObject({
        runId: queued.runId,
        status: 'ready',
        metadata: { landDatasetVersion: landVersion },
        prediction: {
          landConstraint: 'checked',
          status: 'ready',
          residuals: { source: 'historical' },
        },
      });
      expect(result.body.items[0].prediction.horizons).toHaveLength(4);
      expect(
        result.body.items[0].evidence.ais.some(
          (point: { recordId: string }) => point.recordId === futureObservation.eventId,
        ),
      ).toBe(false);
      expect(result.body.items[0].prediction.residuals.samples).toBeGreaterThan(0);
      const paths = (
        await infra.pool.query(
          'SELECT jsonb_array_length(paths) count FROM analysis_prediction_artifacts WHERE result_id=$1 ORDER BY revision DESC LIMIT 1',
          [result.body.items[0].id],
        )
      ).rows[0];
      expect(Number(paths.count)).toBeGreaterThan(0);
      expect(result.body.items[0]).not.toHaveProperty('paths');
    } finally {
      await infra.pool.query('UPDATE route_datasets SET active=false WHERE version=$1', [
        landVersion,
      ]);
      if (previous.length)
        await infra.pool.query(
          'UPDATE route_datasets SET active=true WHERE version=ANY($1::text[])',
          [previous],
        );
    }
  });
  it('invalidates a logical warning when a new revision moves outside the old prediction window or withdraws', async () => {
    const latest = (
      await request(api.app.getHttpServer())
        .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
        .set(headers())
        .expect(200)
    ).body.items[0];
    const asOf = Date.parse(latest.prediction.asOf);
    const before = new Date(Date.parse(latest.computedAt) - 1000).toISOString();
    await infra.pool.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb)', [
      source,
      JSON.stringify({ sourceId: source, name: source, kind: 'manual', enabled: true }),
    ]);
    const insert = async (version: number, status: string, offset: number, createdAt?: string) => {
      const event = {
        id: `${source}-warning-${version}`,
        sourceId: source,
        externalId: 'moving-warning',
        version,
        status,
        category: 'navigation-warning',
        reviewStatus: 'confirmed',
        effectiveFrom: new Date(asOf + offset * 60000).toISOString(),
        effectiveTo: new Date(asOf + (offset + 60) * 60000).toISOString(),
      };
      await infra.pool.query(
        'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,effective_to,event,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,coalesce($9::timestamptz,now()))',
        [
          event.id,
          source,
          event.externalId,
          version,
          before,
          event.effectiveFrom,
          event.effectiveTo,
          JSON.stringify(event),
          createdAt ?? null,
        ],
      );
    };
    const read = async () =>
      (
        await request(api.app.getHttpServer())
          .get(`/api/v1/topics/predictions?mmsi=${mmsi}`)
          .set(headers())
          .expect(200)
      ).body.items[0];
    await insert(1, 'active', 5, before);
    expect((await read()).stale).toBe(false);
    await insert(2, 'revised', 180);
    expect(await read()).toMatchObject({ stale: true, impacts: [] });
    await infra.pool.query('UPDATE intelligence_events SET created_at=$2 WHERE id=$1', [
      `${source}-warning-2`,
      before,
    ]);
    expect((await read()).stale).toBe(false);
    await insert(3, 'withdrawn', 180);
    expect(await read()).toMatchObject({ stale: true, impacts: [] });
  });
});
