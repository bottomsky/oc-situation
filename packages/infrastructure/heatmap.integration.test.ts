import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { PositionObservation } from '../contracts';
import { createInfrastructure, type Infrastructure } from './clients';
import { saveHistoryBatch } from './storage';
import { queryAisHeatmap } from './heatmap';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import { hashToken } from '../../apps/api/src/auth/security';

describe('real ClickHouse AIS heatmap and authenticated HTTP reads', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  const prefix = `heatmap-test-${randomUUID()}`;
  const low = `${prefix}-low`,
    high = `${prefix}-high`;
  const baseMmsi = 970000000 + Math.floor(Math.random() * 1000000);
  const mmsis = Array.from({ length: 10 }, (_, i) => String(baseMmsi + i));
  const from = new Date(Date.now() - 3600000).toISOString();
  const to = new Date(Date.now() - 1800000).toISOString();
  const mid = new Date(Date.parse(from) + 600000).toISOString();
  const bbox: [number, number, number, number] = [0, -10, 20, 10];
  const userId = randomUUID();
  const loginIp = `198.18.72.${randomInt(1, 255)}`;
  let cookie: string;
  function position(
    index: number,
    lon: number,
    patch: Partial<PositionObservation> = {},
  ): PositionObservation {
    return {
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: `${prefix}-${randomUUID()}`,
      captureId: randomUUID(),
      sourceId: low,
      sourceKind: 'fixture-http',
      sourcePriority: 10,
      runId: null,
      observedAt: mid,
      receivedAt: mid,
      mmsi: mmsis[index]!,
      lat: 0,
      lon,
      sogKnots: null,
      cogDegrees: null,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'UNKNOWN',
      quality: [],
      ...patch,
    };
  }
  beforeAll(async () => {
    infra = await createInfrastructure();
    const version1 = position(0, 10);
    await saveHistoryBatch(infra, [version1]);
    // Seed a later stored revision directly: the current ingestion contract accepts version 1.
    await infra.clickhouse.command({
      query: `INSERT INTO positions SELECT * REPLACE (
        toUInt32(2) AS cleaningVersion,toFloat64(40) AS longitude,{observation:String} AS observation
      ) FROM positions WHERE eventId={eventId:String} AND cleaningVersion=1`,
      query_params: {
        eventId: version1.eventId,
        observation: JSON.stringify({ ...version1, cleaningVersion: 2, lon: 40 }),
      },
    });
    await saveHistoryBatch(infra, [
      position(1, 10),
      position(1, 40, { sourceId: high, sourcePriority: 20 }),
      position(2, 10, { eventId: `${prefix}-a` }),
      position(2, 40, { eventId: `${prefix}-z` }),
      position(3, 1),
      position(3, 19, { observedAt: new Date(Date.parse(mid) + 1000).toISOString() }),
      position(4, 10, { observedAt: from }),
      position(5, 10, { observedAt: to }),
      position(6, 180),
      position(6, -180, { observedAt: new Date(Date.parse(mid) + 1000).toISOString() }),
      position(7, 179),
      position(7, -179, { observedAt: new Date(Date.parse(mid) + 1000).toISOString() }),
      position(8, 0, { lat: 90 }),
      position(8, 0, { lat: -90, observedAt: new Date(Date.parse(mid) + 1000).toISOString() }),
      position(9, 10),
    ]);
    await infra.pool.query('INSERT INTO vessels(mmsi,ship_type) VALUES($1,70),($2,30)', [
      mmsis[3],
      mmsis[9],
    ]);
    api = await createApi(infra, { scheduler: false, origins: ['http://127.0.0.1:13001'] });
    // This override belongs only to the test server; production proxy policy is unchanged.
    const adapter = api.app.getHttpAdapter().getInstance();
    adapter.set('trust proxy', 'loopback');
    expect(adapter.get('trust proxy fn')('127.0.0.1')).toBe(true);
    expect(adapter.get('trust proxy fn')(loginIp)).toBe(false);
    const password = randomBytes(24).toString('hex');
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'viewer')",
      [userId, prefix, await hashPassword(password)],
    );
    const login = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-Forwarded-For', loginIp)
      .send({ username: prefix, password })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
  });
  afterAll(async () => {
    if (api) await api.stop();
    if (!infra) return;
    await infra.pool.query(
      "DELETE FROM audit WHERE action='login_attempt' AND resource_type='authentication' AND resource_id=$1",
      [hashToken(loginIp)],
    );
    await infra.clickhouse.command({
      query: 'ALTER TABLE positions DELETE WHERE sourceId IN {sources:Array(String)}',
      query_params: { sources: [low, high] },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [mmsis]);
    await infra.pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [userId]);
    await infra.pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await infra.close();
  });
  it('resolves duplicate cleaning versions before location filtering', async () => {
    expect(
      (await queryAisHeatmap(infra, { bbox, from, to, mmsis: [mmsis[0]!] })).totalVessels,
    ).toBe(0);
  });
  it('selects source priority then eventId before bbox, while source filtering precedes preference', async () => {
    const q = { bbox, from, to, mmsis: [mmsis[1]!, mmsis[2]!] };
    expect((await queryAisHeatmap(infra, q)).totalVessels).toBe(0);
    expect((await queryAisHeatmap(infra, { ...q, sourceId: low })).totalVessels).toBe(1);
  });
  it('counts one vessel once across two occupied cells', async () => {
    const result = await queryAisHeatmap(infra, { bbox, from, to, mmsis: [mmsis[3]!] });
    expect(result.totalVessels).toBe(1);
    expect(result.cells).toHaveLength(2);
    expect(result.cells.map((cell) => cell.vesselCount)).toEqual([1, 1]);
  });
  it('includes from and excludes to exactly', async () => {
    expect(
      (await queryAisHeatmap(infra, { bbox, from, to, mmsis: [mmsis[4]!, mmsis[5]!] }))
        .totalVessels,
    ).toBe(1);
  });
  it('normalizes 180 and -180 into one cell and crosses the date line', async () => {
    const result = await queryAisHeatmap(infra, {
      bbox: [178, -2, -178, 2],
      from,
      to,
      mmsis: [mmsis[6]!, mmsis[7]!],
    });
    expect(result.totalVessels).toBe(2);
    expect(result.cells).toHaveLength(3);
    const edge = await queryAisHeatmap(infra, {
      bbox: [180, -2, 180, 2],
      from,
      to,
      mmsis: [mmsis[6]!],
    });
    expect(edge.totalVessels).toBe(1);
    expect(edge.cells).toHaveLength(1);
    expect(edge.cells[0]!.x).toBe(0);
  });
  it('keeps both poles in valid global cells', async () => {
    const result = await queryAisHeatmap(infra, {
      bbox: [-180, -90, 180, 90],
      from,
      to,
      mmsis: [mmsis[8]!],
    });
    expect(result.totalVessels).toBe(1);
    expect(result.cells.map((cell) => cell.y)).toEqual([0, 31]);
  });
  it('filters ship type by current profile and intersects explicit MMSIs', async () => {
    const q = { bbox, from, to, mmsis: [mmsis[3]!, mmsis[9]!] };
    expect((await queryAisHeatmap(infra, { ...q, shipType: 70 })).totalVessels).toBe(1);
    expect((await queryAisHeatmap(infra, { ...q, shipType: 99 })).totalVessels).toBe(0);
  });
  it('requires a session, accepts a viewer and rechecks auth even for a cached request', async () => {
    const q = { bbox: bbox.join(','), from, to, sourceId: low, mmsis: mmsis[3] };
    await request(api.app.getHttpServer()).get('/api/v1/map/heatmap').query(q).expect(401);
    const read = () =>
      request(api.app.getHttpServer()).get('/api/v1/map/heatmap').set('Cookie', cookie).query(q);
    const result = await read().expect(200);
    expect(result.body.totalVessels).toBe(1);
    await infra.pool.query('UPDATE users SET disabled=true WHERE id=$1', [userId]);
    await read().expect(401);
  });
});
