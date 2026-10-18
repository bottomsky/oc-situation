import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { AccessGuard } from '../auth/guard';
import { AuthService } from '../auth/service';
import { csrfToken, hashToken } from '../auth/security';
import { INFRA, OPTIONS, ApiExceptionFilter } from '../common';
import { RoutesController } from './controller';
import { OperationalEventsController } from '../operational-events/controller';
import { SystemController } from '../system/controller';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const origin = 'http://127.0.0.1:13001';
const people = ['viewer', 'operator'].map((role) => ({
  role,
  id: randomUUID(),
  token: randomBytes(32).toString('base64url'),
}));
let app: INestApplication;
const routeIds: string[] = [],
  eventIds: string[] = [];
beforeAll(async () => {
  for (const p of people) {
    await pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused',$3)",
      [p.id, `qa-${p.id}`, p.role],
    );
    await pool.query(
      "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
      [hashToken(p.token), p.id],
    );
  }
  @Module({
    controllers: [RoutesController, OperationalEventsController, SystemController],
    providers: [
      { provide: INFRA, useValue: { pool } },
      { provide: OPTIONS, useValue: { origins: [origin], production: false, scheduler: false } },
      AuthService,
      { provide: APP_GUARD, useClass: AccessGuard },
    ],
  })
  class QaModule {}
  app = await NestFactory.create(QaModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  await app.init();
});
afterAll(async () => {
  await app?.close();
  await pool.query('DELETE FROM route_revisions WHERE route_id=ANY($1::uuid[])', [routeIds]);
  await pool.query('DELETE FROM routes WHERE id=ANY($1::uuid[])', [routeIds]);
  await pool.query('DELETE FROM operational_event_revisions WHERE event_id=ANY($1::uuid[])', [
    eventIds,
  ]);
  await pool.query('DELETE FROM operational_events WHERE id=ANY($1::uuid[])', [eventIds]);
  for (const p of people) {
    await pool.query('DELETE FROM route_operation_receipts WHERE user_id=$1', [p.id]);
    await pool.query('DELETE FROM operational_event_operations WHERE actor_id=$1', [p.id]);
    await pool.query('DELETE FROM audit WHERE user_id=$1', [p.id]);
    await pool.query('DELETE FROM sessions WHERE user_id=$1', [p.id]);
    await pool.query('DELETE FROM users WHERE id=$1', [p.id]);
  }
  await pool.end();
});
const route = () => ({
  operationId: randomUUID(),
  name: 'QA',
  waypoints: [
    [0, 0],
    [1, 0],
  ],
  geometry: {
    type: 'LineString',
    coordinates: [
      [0, 0],
      [1, 0],
    ],
  },
});
function write(
  method: 'post' | 'put' | 'patch',
  path: string,
  role: string,
  body: Record<string, unknown>,
  csrf = true,
) {
  const p = people.find((p) => p.role === role)!;
  const client = request(app.getHttpServer());
  const req = client[method](`/api/v1/${path}`)
    .set('Cookie', `ais_session=${p.token}`)
    .set('Origin', origin);
  if (csrf) req.set('X-CSRF-Token', csrfToken(p.token));
  return req.send(body);
}
for (const path of ['routes', 'operational-events'])
  it(`guards ${path} writes with actual Nest role + CSRF guard`, async () => {
    const body = path === 'routes' ? route() : { operationId: randomUUID(), title: 'QA event' };
    await write('post', path, 'viewer', body).expect(403);
    await write('post', path, 'operator', body, false).expect(403);
    const response = await write('post', path, 'operator', body).expect(201);
    (path === 'routes' ? routeIds : eventIds).push(response.body.id);
    const update =
      path === 'routes'
        ? { operationId: randomUUID(), expectedRevision: 1, name: 'updated' }
        : { operationId: randomUUID(), expectedRevision: 1, fields: { title: 'updated' } };
    const method = path === 'routes' ? 'put' : 'patch';
    await write(method, `${path}/${response.body.id}`, 'operator', update).expect(200);
    await write(method, `${path}/${response.body.id}`, 'operator', {
      ...update,
      operationId: randomUUID(),
    }).expect(409);
  });
it('executes actual durable business metric aggregates against PostGIS', async () => {
  const text = await app.get(SystemController).metricsText();
  expect(text).toContain('ais_event_sync_pending ');
  expect(text).toContain('ais_business_operation_receipts{kind="route"} ');
  expect(text).toContain('ais_focus_ui_failures ');
});
