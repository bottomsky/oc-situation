import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApi } from '../app';
import { hashPassword } from '../auth/service';
import {
  createInfrastructure,
  type Infrastructure,
} from '../../../../packages/infrastructure/clients';
import { runMigrations } from '../../../../packages/infrastructure/migrations';
const origin = 'http://127.0.0.1:13001';
describe('intelligence API role and geometry boundaries', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  const users = new Map<string, { cookie: string; csrf: string }>();
  const sourceId = 'api-spatial-' + randomUUID();
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    api = await createApi(infra, { scheduler: false, origins: [origin] });
    const password = randomUUID();
    const hash = await hashPassword(password);
    for (const role of ['viewer', 'operator', 'admin']) {
      const username = sourceId + '-' + role;
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4)',
        [randomUUID(), username, hash, role],
      );
      const login = await request(api.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ username, password })
        .expect(200);
      users.set(role, {
        cookie: (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
        csrf: login.body.csrfToken,
      });
    }
  });
  afterAll(async () => {
    await api.stop();
    await infra.close();
  });
  const write = (path: string, body: object, role = 'operator') =>
    request(api.app.getHttpServer())
      .post('/api/v1/intelligence' + path)
      .set('Origin', origin)
      .set('Cookie', users.get(role)!.cookie)
      .set('X-CSRF-Token', users.get(role)!.csrf)
      .send(body);
  it('enforces viewer/operator/source administrator boundaries', async () => {
    const body = { sourceId, kind: 'manual', name: '测试人工源' };
    await write('/sources', body, 'operator').expect(403);
    await write('/sources', body, 'admin').expect(201);
    await write('/objects', { kind: 'port', name: '港口' }, 'viewer').expect(403);
    const object = await write('/objects', {
      kind: 'port',
      name: '港口',
      geometry: { type: 'Point', coordinates: [120, 30] },
    }).expect(201);
    const at = new Date().toISOString();
    const event = await write('/events', {
      sourceId,
      externalId: 'e',
      version: 1,
      category: 'notice',
      reviewStatus: 'candidate',
      title: '待审公告',
      summary: '原文',
      publishedAt: at,
      effectiveFrom: at,
      effectiveTo: null,
      paragraphs: [{ id: 'p', text: '原文' }],
      raw: {},
    }).expect(201);
    await write(`/events/${event.body.id}/review`, { reviewStatus: 'confirmed' }, 'viewer').expect(
      403,
    );
    await write(`/events/${event.body.id}/review`, { reviewStatus: 'confirmed' }).expect(201);
    await write(`/events/${event.body.id}/relations`, {
      kind: 'impacts',
      objectId: object.body.id,
      basis: '人工认定',
      impactType: 'restriction',
      effectiveFrom: at,
      reviewStatus: 'confirmed',
      paragraphIds: ['p'],
    }).expect(201);
    const detail = await request(api.app.getHttpServer())
      .get(`/api/v1/intelligence/events/${event.body.id}`)
      .set('Cookie', users.get('viewer')!.cookie)
      .expect(200);
    expect(detail.body.history).toHaveLength(2);
    const plot = await write(
      '/plot',
      { eventIds: [event.body.id], includeCandidates: false },
      'viewer',
    ).expect(201);
    expect(plot.body.features).toHaveLength(1);
  });
  it('returns actionable 400/404 for invalid topology and evidence references', async () => {
    await write('/objects', {
      kind: 'area',
      name: '非法自交',
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
    }).expect(400);
    await write('/events/missing/relations', {
      kind: 'mentions',
      objectId: 'missing',
      basis: '未知对象',
    }).expect(404);
  });
  it('documents all intelligence endpoints and bounded request schemas', () => {
    expect(api.openapi.paths['/api/v1/intelligence/plot']?.post?.requestBody).toBeDefined();
    expect(
      api.openapi.paths['/api/v1/intelligence/events']?.get?.parameters?.length,
    ).toBeGreaterThan(10);
    const sourceResponse = JSON.stringify(
      api.openapi.paths['/api/v1/intelligence/sources']?.get?.responses['200'],
    );
    for (const field of ['lastPolledAt', 'lastSuccessfulAt', 'lastError', 'lastIngestion']) {
      expect(sourceResponse).toContain(field);
    }
  });
});
