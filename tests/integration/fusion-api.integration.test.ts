import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import {
  createInfrastructure,
  runMigrations,
  saveHistoryBatch,
  saveLatestBatch,
  type Infrastructure,
} from '../../packages/infrastructure';
import { ensureFusionBus } from '../../packages/infrastructure/fusion-data';
import { ensureAnalysisBus, processNextTopicRun } from '../../apps/topics';
import { claimTopicRun, completeTopicRun } from '../../packages/infrastructure/topics';
import type {
  AnalysisResult,
  IntelligenceEvent,
  PositionObservation,
  TopicInstance,
  UserRole,
} from '../../packages/contracts';

describe('fusion API and persistent topic execution', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  const prefix = `fusion-api-${randomUUID()}`;
  const password = randomBytes(32).toString('hex');
  const sourceId = prefix;
  const users = new Map<UserRole, { id: string; cookie: string; csrf: string }>();
  const instances: TopicInstance[] = [];
  const mmsi = String(970000000 + Math.floor(Math.random() * 999999));
  const start = new Date(Date.now() - 20 * 60000).toISOString();
  const originalFileRoot = process.env.INTELLIGENCE_FILE_ROOT;
  let document: IntelligenceEvent;
  const event = {
    sourceId,
    externalId: 'port-restriction',
    version: 1,
    status: 'active',
    category: 'port-restriction',
    title: 'Integration port notice',
    summary: 'Deterministic restricted vessel',
    publishedAt: start,
    effectiveFrom: start,
    effectiveTo: null,
    bbox: [140, 20, 142, 22],
    mmsis: [mmsi],
    vesselTypes: [],
    paragraphs: [{ id: 'paragraph-1', text: 'This vessel falls within the port restriction.' }],
    commonSourceId: `authority-${prefix}`,
    raw: { fixture: true, text: 'Exact original notice' },
  };
  beforeAll(async () => {
    process.env.INTELLIGENCE_FILE_ROOT = resolve('apps/intelligence/fixtures');
    infra = await createInfrastructure();
    await runMigrations(infra);
    await ensureFusionBus(infra);
    await ensureAnalysisBus(infra);
    api = await createApi(infra, { scheduler: false, origins: ['http://127.0.0.1:13001'] });
    const hash = await hashPassword(password);
    for (const role of ['admin', 'viewer'] as const) {
      const id = randomUUID();
      const username = `${prefix}-${role}`;
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',
        [id, username, hash, role],
      );
      const login = await request(api.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', 'http://127.0.0.1:13001')
        .send({ username, password })
        .expect(200);
      users.set(role, {
        id,
        cookie: (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
        csrf: login.body.csrfToken,
      });
    }
    const base: PositionObservation = {
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: randomUUID(),
      captureId: randomUUID(),
      mmsi,
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      receivedAt: start,
      observedAt: start,
      lat: 21,
      lon: 141,
      sogKnots: 1,
      cogDegrees: 0,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'UNKNOWN',
      quality: [],
    };
    const positions = [0, 1, 2].map((index) => ({
      ...base,
      eventId: `${prefix}-${index}`,
      observedAt: new Date(Date.parse(start) + index * 60000).toISOString(),
    }));
    await saveLatestBatch(infra, positions);
    await saveHistoryBatch(infra, positions);
  });
  const get = (path: string) =>
    request(api.app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Cookie', users.get('viewer')!.cookie);
  const write = (method: 'post' | 'put', path: string, body: object, role: UserRole = 'admin') => {
    const http = request(api.app.getHttpServer());
    return http[method](`/api/v1${path}`)
      .set('Cookie', users.get(role)!.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', users.get(role)!.csrf)
      .send(body);
  };
  const run = async (instance: TopicInstance) => {
    const queued = await write('post', `/topics/instances/${instance.id}/run`, {})
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    await processNextTopicRun(infra, instance.definitionId, instance.id);
    const execution = await get(`/topics/runs/${queued.body.id}`).expect(200);
    expect(execution.body.status, execution.body.error ?? 'topic run status').toBe('succeeded');
    expect(execution.body.inputSnapshot.ais.length).toBeGreaterThanOrEqual(3);
    return execution.body;
  };
  afterAll(async () => {
    if (api) await api.stop();
    if (infra) {
      for (const instance of instances) {
        await infra.pool.query('DELETE FROM analysis_feed WHERE instance_id=$1', [instance.id]);
        await infra.pool.query(
          'DELETE FROM analysis_revisions WHERE result_id IN (SELECT id FROM analysis_results WHERE instance_id=$1)',
          [instance.id],
        );
        await infra.pool.query('DELETE FROM analysis_results WHERE instance_id=$1', [instance.id]);
        await infra.pool.query('DELETE FROM topic_runs WHERE instance_id=$1', [instance.id]);
        await infra.pool.query('DELETE FROM topic_event_receipts WHERE instance_id=$1', [
          instance.id,
        ]);
        await infra.pool.query('DELETE FROM topic_delivery_failures WHERE instance_id=$1', [
          instance.id,
        ]);
        await infra.pool.query('DELETE FROM topic_instances WHERE id=$1', [instance.id]);
      }
      const archives = await infra.pool.query(
        'SELECT object_key FROM intelligence_archives WHERE source_id=$1',
        [sourceId],
      );
      for (const row of archives.rows)
        await infra.s3.send(
          new DeleteObjectCommand({ Bucket: infra.config.s3Bucket, Key: row.object_key }),
        );
      await infra.pool.query(
        'DELETE FROM fusion_ready_outbox WHERE id IN (SELECT id FROM intelligence_events WHERE source_id=$1)',
        [sourceId],
      );
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
      for (const user of users.values()) {
        await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [user.id]);
        await infra.pool.query('DELETE FROM users WHERE id=$1', [user.id]);
      }
      await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
      await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
      const identifiers = await infra.pool.query(
        'DELETE FROM vessel_identifiers WHERE identifier=$1 RETURNING vessel_id',
        [mmsi],
      );
      for (const row of identifiers.rows)
        await infra.pool.query('DELETE FROM vessel_objects WHERE id=$1', [row.vessel_id]);
      await infra.clickhouse.command({
        query: 'ALTER TABLE positions DELETE WHERE sourceId={source:String}',
        query_params: { source: sourceId },
        clickhouse_settings: { mutations_sync: '1' },
      });
      await infra.close();
    }
    if (originalFileRoot === undefined) delete process.env.INTELLIGENCE_FILE_ROOT;
    else process.env.INTELLIGENCE_FILE_ROOT = originalFileRoot;
  });
  it('denies anonymous reads and viewer writes; creates source and archived evidence through API', async () => {
    await request(api.app.getHttpServer()).get('/api/v1/intelligence/events').expect(401);
    await request(api.app.getHttpServer()).get('/api/v1/topics').expect(401);
    await write('post', '/intelligence/events', event, 'viewer').expect(403);
    await write('post', '/topics/instances', {}, 'viewer').expect(403);
    await write('post', '/intelligence/sources', {
      sourceId,
      name: 'Integration notices',
      kind: 'manual',
      enabled: false,
    }).expect(201);
    document = (await write('post', '/intelligence/events', event).expect(201)).body;
    expect(document.archiveKey).toContain('intelligence/');
    const archived = await get('/intelligence/archives?limit=100').expect(200);
    const item = archived.body.items.find((a: { sourceId: string }) => a.sourceId === sourceId);
    expect(item).toBeTruthy();
    const original = await get(`/intelligence/archives/${item.id}`).expect(200);
    expect(JSON.parse(original.body.content).raw).toEqual(event.raw);
  });
  it('runs two topic definitions independently and exposes complete original evidence', async () => {
    for (const definitionId of ['port-restriction', 'area-low-speed-notice'] as const) {
      const created = await write('post', '/topics/instances', {
        definitionId,
        name: `${prefix}-${definitionId}`,
        enabled: true,
        config: {
          bbox: [140, 20, 142, 22],
          historyHours: 1,
          windowMinutes: 30,
          lowSpeedKnots: 3,
          minPositions: 3,
          scheduleSeconds: 60,
        },
      }).expect(201);
      const instance = created.body as TopicInstance;
      instances.push(instance);
      await run(instance);
      const listed = await get(`/analysis/results?instanceId=${instance.id}`).expect(200);
      const result = listed.body.items.find(
        (r: AnalysisResult) => r.mmsi === mmsi,
      ) as AnalysisResult;
      expect(result?.status).toBe('active');
      expect(result.evidence.ais).toHaveLength(3);
      expect(result.evidence.documents[0]?.paragraphs[0]?.text).toBe(event.paragraphs[0]!.text);
      expect(result.evidence.ais[0]?.raw).toMatchObject({ sourceId, mmsi });
      await get(`/analysis/results/${result.id}`).expect(200);
      expect(result.evidence.steps.length).toBeGreaterThan(0);
    }
  });
  it('withdraws previous results after source withdrawal while retaining immutable revisions', async () => {
    await write('post', '/intelligence/events', {
      ...event,
      version: 2,
      status: 'withdrawn',
      supersedesId: document.id,
    }).expect(201);
    for (const instance of instances) {
      await run(instance);
      const list = await get(`/analysis/results?instanceId=${instance.id}`).expect(200);
      const result = list.body.items.find((r: AnalysisResult) => r.mmsi === mmsi) as AnalysisResult;
      expect(result.status).toBe('withdrawn');
      expect(result.revision).toBe(2);
      const revisions = await get(`/analysis/results/${result.id}/revisions`).expect(200);
      expect(revisions.body.items.map((r: AnalysisResult) => r.status)).toEqual([
        'withdrawn',
        'active',
      ]);
    }
  });
  it('disabling fences an in-flight generation and preserves existing history', async () => {
    const instance = instances[0]!;
    await write('post', `/topics/instances/${instance.id}/run`, {})
      .set('Idempotency-Key', randomUUID())
      .expect(202);
    const lease = await claimTopicRun(infra, instance.definitionId, instance.id);
    expect(lease).not.toBeNull();
    const state = await write('put', `/topics/instances/${instance.id}/state`, {
      enabled: false,
    }).expect(200);
    expect(state.body.generation).toBe(instance.generation + 1);
    expect(await completeTopicRun(infra, lease!, [])).toBe(false);
    await write('post', `/topics/instances/${instance.id}/run`, {})
      .set('Idempotency-Key', randomUUID())
      .expect(409);
    expect(
      (await get(`/analysis/results?instanceId=${instance.id}`).expect(200)).body.items.length,
    ).toBeGreaterThan(0);
  });
});
