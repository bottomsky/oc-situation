import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createInfrastructure,
  runMigrations,
  bootstrapJetstream,
  saveHistoryBatch,
  saveLatestBatch,
  type Infrastructure,
} from '@ais/infrastructure';
import type { PositionObservation, UserRole } from '@ais/contracts';
import { createApi } from './src/app';
import { hashPassword } from './src/auth/service';
import { hashToken } from './src/auth/security';
import { SystemController } from './src/system/controller';
import { startOperationsServer } from './src/system/operations';
describe('API with real PostgreSQL, ClickHouse, JetStream and S3', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  let operations: Awaited<ReturnType<typeof startOperationsServer>>;
  const origin = 'http://127.0.0.1:13001';
  const prefix = `api-test-${randomUUID()}`;
  const password = randomBytes(32).toString('base64url');
  const users = new Map<UserRole, { id: string; username: string; cookie: string; csrf: string }>();
  const sourceId = `${prefix}-source`;
  const jobId = randomUUID();
  const mmsi = `9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const start = new Date(Date.now() - 3600000).toISOString();
  const end = new Date().toISOString();
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await bootstrapJetstream(infra);
    api = await createApi(infra, { scheduler: false, origins: [origin] });
    operations = await startOperationsServer(api.app.get(SystemController), { port: 0 });
    const hash = await hashPassword(password);
    for (const role of ['viewer', 'operator', 'admin'] as const) {
      const id = randomUUID();
      const username = `${prefix}-${role}`;
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',
        [id, username, hash, role],
      );
      const response = await request(api.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ username, password })
        .expect(200);
      const cookies = response.headers['set-cookie'] as unknown as string[];
      expect(cookies[0]).toContain('HttpOnly');
      users.set(role, {
        id,
        username,
        cookie: cookies[0]!.split(';')[0]!,
        csrf: response.body.csrfToken,
      });
    }
    const point: PositionObservation = {
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: `${prefix}-position`,
      captureId: `${prefix}-capture`,
      mmsi,
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 1,
      runId: null,
      receivedAt: start,
      observedAt: start,
      lat: 0,
      lon: 179,
      sogKnots: 1,
      cogDegrees: 0,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'TER',
      quality: [],
    };
    const second = {
      ...point,
      eventId: `${prefix}-second`,
      captureId: `${prefix}-second-capture`,
      observedAt: new Date(Date.parse(start) + 60000).toISOString(),
      lon: -179,
    };
    await saveLatestBatch(infra, [point, second]);
    await saveHistoryBatch(infra, [point, point, second]);
  });
  afterAll(async () => {
    if (operations) await operations.close();
    if (api) await api.stop();
    if (infra) {
      await infra.pool.query("DELETE FROM outbox WHERE payload->>'sourceId'=$1", [sourceId]);
      await infra.pool.query('DELETE FROM replays WHERE source_id=$1', [sourceId]);
      await infra.pool.query('DELETE FROM runs WHERE source_id=$1', [sourceId]);
      await infra.pool.query('DELETE FROM jobs WHERE source_id=$1', [sourceId]);
      await infra.pool.query('DELETE FROM sources WHERE id=$1', [sourceId]);
      for (const user of users.values()) {
        await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [user.id]);
        await infra.pool.query('DELETE FROM users WHERE id=$1', [user.id]);
      }
      await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
      await infra.pool.query('DELETE FROM field_provenance WHERE mmsi=$1', [mmsi]);
      await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
      await infra.clickhouse.command({
        query: 'ALTER TABLE positions DELETE WHERE mmsi={mmsi:String}',
        query_params: { mmsi },
        clickhouse_settings: { mutations_sync: '1' },
      });
      await infra.close();
    }
  });
  const get = (path: string, role: UserRole = 'viewer') =>
    request(api.app.getHttpServer()).get(`/api/v1${path}`).set('Cookie', users.get(role)!.cookie);
  const post = (path: string, body: object, role: UserRole = 'admin') =>
    request(api.app.getHttpServer())
      .post(`/api/v1${path}`)
      .set('Cookie', users.get(role)!.cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', users.get(role)!.csrf)
      .send(body);
  it('stores hashed tokens and issues HttpOnly cookies; auth failures are uniform', async () => {
    const user = users.get('viewer')!;
    const raw = user.cookie.slice('ais_session='.length);
    const session = await infra.pool.query('SELECT id FROM sessions WHERE user_id=$1', [user.id]);
    expect(session.rows[0].id).toBe(hashToken(raw));
    expect(session.rows[0].id).not.toBe(raw);
    await get('/auth/me').expect(200);
    const wrong = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: user.username, password: 'wrong' })
      .expect(401);
    const absent = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: `${prefix}-missing`, password: 'wrong' })
      .expect(401);
    expect(absent.body.error.message).toBe(wrong.body.error.message);
  });
  it('denies anonymous business access, invalid origin, missing CSRF and viewer mutations', async () => {
    await request(api.app.getHttpServer()).get('/api/v1/vessels').expect(401);
    await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'https://evil.test')
      .send({ username: users.get('admin')!.username, password })
      .expect(403);
    await request(api.app.getHttpServer())
      .post('/api/v1/sources')
      .set('Cookie', users.get('admin')!.cookie)
      .set('Origin', origin)
      .send({})
      .expect(403);
    await post('/sources', {}, 'viewer').expect(403);
    await post('/sources', {}, 'operator').expect(403);
  });
  it('validates commercial authorization and queues a stable idempotent outbox command', async () => {
    await post('/sources', {
      sourceId,
      name: 'invalid',
      sourceKind: 'marinetraffic',
      status: 'enabled',
      secretRef: 'TEST_API_KEY',
      priority: 1,
    }).expect(400);
    await post('/sources', {
      sourceId,
      name: 'fixture',
      sourceKind: 'fixture-http',
      status: 'enabled',
      secretRef: null,
      priority: 1,
      endpoint: 'http://127.0.0.1:13002/fixture/vessels',
      settings: { allowedHosts: ['127.0.0.1'], requestsPerMinute: 2, maxPages: 1 },
    }).expect(201);
    await post('/jobs', {
      jobId,
      sourceId,
      name: 'API integration manual job',
      mode: 'crawl',
      status: 'enabled',
      scheduleSeconds: null,
    }).expect(201);
    const key = randomUUID();
    const first = await post(`/jobs/${jobId}/run`, {}, 'operator')
      .set('Idempotency-Key', key)
      .expect(202);
    await infra.pool.query('UPDATE runs SET checkpoint=$2::jsonb WHERE id=$1', [
      first.body.runId,
      JSON.stringify({ page: 5 }),
    ]);
    const second = await post(`/jobs/${jobId}/run`, {}, 'operator')
      .set('Idempotency-Key', key)
      .expect(202);
    expect(second.body.runId).toBe(first.body.runId);
    expect(first.body.status).toBe('queued');
    const outbox = await infra.pool.query("SELECT * FROM outbox WHERE payload->>'runId'=$1", [
      first.body.runId,
    ]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].published_at).toBeNull();
    await post(`/jobs/${jobId}/pause`, {}, 'operator').expect(200);
    const state = await infra.pool.query('SELECT status FROM runs WHERE id=$1', [first.body.runId]);
    expect(state.rows[0].status).toBe('cancelled');
  });
  it('queries native de-duplicated tracks, date line bounds and rejects unbounded or injected queries', async () => {
    const track = await get(`/vessels/${mmsi}/track`)
      .query({ from: start, to: end, maxPoints: 5000 })
      .expect(200);
    expect(track.body.total).toBe(2);
    expect(track.body.segments).toHaveLength(2);
    const map = await get('/map').query({ bbox: '170,-10,-170,10', zoom: 9 }).expect(200);
    expect(map.body.items.some((v: { mmsi: string }) => v.mmsi === mmsi)).toBe(true);
    await get(`/vessels/${mmsi}/track`)
      .query({ from: '2026-01-01T00:00:00Z', to: '2026-03-01T00:00:00Z' })
      .expect(400);
    await get('/quality')
      .query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
      .expect(400);
    await get(`/vessels/${mmsi}/track`)
      .query({ from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' })
      .expect(400);
    await get('/map').query({ bbox: '0,0,1,1;DROP TABLE vessels', zoom: 9 }).expect(400);
    await get('/vessels').query({ query: "';DROP TABLE vessels;--" }).expect(200);
    await get('/vessels').query({ limit: 101 }).expect(400);
  });
  it('reports actual dependency readiness and independent quality counts', async () => {
    const health = await request(api.app.getHttpServer()).get('/api/v1/system/health').expect(200);
    expect(health.body.services).toEqual({
      postgres: true,
      clickhouse: true,
      nats: true,
      s3: true,
    });
    await get('/system/ready').expect(200);
    await request(operations.server).get('/ready').expect(200);
    const metrics = await request(operations.server).get('/metrics').expect(200);
    expect(metrics.text).toContain('ais_api_');
    await request(api.app.getHttpServer()).get('/api/v1/system/metrics').expect(401);
    const quality = await get('/quality').query({ from: start, to: end, sourceId }).expect(200);
    expect(quality.body.normalizedPositions).toBe(2);
    expect(quality.body.receivedCapturesLabel).toBe('归档确认响应数');
  });
});
