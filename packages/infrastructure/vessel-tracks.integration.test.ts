import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { PositionObservation } from '../contracts';
import { VesselTracksQuerySchema } from '../contracts/vessel-tracks';
import { createInfrastructure, type Infrastructure } from './clients';
import { saveHistoryBatch } from './storage';
import { queryVesselTracks } from './vessel-tracks';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import { hashToken } from '../../apps/api/src/auth/security';

describe('real bounded historical vessel tracks', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  const prefix = `tracks-test-${randomUUID()}`;
  const low = prefix + '-low',
    high = prefix + '-high';
  const base = 970000000 + randomInt(1000000);
  const mmsis = Array.from({ length: 9 }, (_, index) => String(base + index));
  const from = new Date(Date.now() - 7200000).toISOString();
  const to = new Date(Date.parse(from) + 3600000).toISOString();
  const at = (minute: number) => new Date(Date.parse(from) + minute * 60000).toISOString();
  const bbox: [number, number, number, number] = [170, -10, -170, 10];
  const userId = randomUUID(),
    loginIp = `198.18.73.${randomInt(1, 255)}`;
  let cookie: string, csrf: string;
  const query = (indexes: number[] = [0]) =>
    VesselTracksQuerySchema.parse({
      bbox,
      from,
      to,
      selector: { mmsis: indexes.map((index) => mmsis[index]!) },
    });
  function position(
    index: number,
    lon: number,
    minute = 10,
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
      observedAt: at(minute),
      receivedAt: at(minute),
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
    if (
      new URL(process.env.DATABASE_URL ?? '').port !== '15433' ||
      new URL(process.env.CLICKHOUSE_URL ?? '').port !== '18124'
    )
      throw new Error('Vessel tracks fixtures require the isolated integration ports');
    infra = await createInfrastructure();
    for (let index = 0; index < mmsis.length; index++) {
      await infra.pool.query(
        'INSERT INTO vessels(mmsi,name,imo,callsign,ship_type) VALUES($1,$2,$3,$4,$5)',
        [
          mmsis[index],
          `${prefix}-ship-${index}`,
          String(7000000 + index),
          `CALL_${index}`,
          index === 4 ? 30 : 70,
        ],
      );
    }
    for (const [index, metadata, aliases] of [
      [3, { model: '052D' }, ['海巡%_特例']],
      [4, { vesselModel: '052D' }, ['普通别名']],
      [5, { shipClass: '052DL' }, []],
    ] as const) {
      const id = `${prefix}-object-${index}`;
      await infra.pool.query(
        "INSERT INTO intelligence_objects(id,kind,name,data) VALUES($1,'vessel',$2,$3::jsonb)",
        [
          id,
          `对象${index}`,
          JSON.stringify({
            id,
            kind: 'vessel',
            name: `对象${index}`,
            mmsi: mmsis[index],
            metadata,
            aliases,
          }),
        ],
      );
    }
    const version1 = position(8, 179);
    await saveHistoryBatch(infra, [
      position(0, 179),
      position(0, 150, 20),
      position(1, 179),
      position(1, 150, 10, { sourceId: high, sourcePriority: 20 }),
      position(2, 179, 0),
      position(2, -179, 1),
      position(2, -178, 40),
      ...Array.from({ length: 20 }, (_, index) => position(3, 179 + index / 100, index)),
      position(4, 179),
      position(5, 179),
      position(6, 179, 60),
      position(7, 180, 0),
      version1,
    ]);
    await infra.clickhouse.command({
      query: `INSERT INTO positions SELECT * REPLACE (
        toUInt32(2) AS cleaningVersion,toFloat64(150) AS longitude,{observation:String} AS observation
      ) FROM positions WHERE eventId={eventId:String} AND cleaningVersion=1`,
      query_params: {
        eventId: version1.eventId,
        observation: JSON.stringify({ ...version1, lon: 150, cleaningVersion: 2 }),
      },
    });
    const latest = position(0, 150, 20);
    await infra.pool.query(
      `INSERT INTO positions_latest
      (mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,
       latitude,longitude,location,observation)
      VALUES($1,$2,$3,$4,'fixture-http',10,$5,$5,1,0,150,ST_SetSRID(ST_MakePoint(150,0),4326)::geography,$6::jsonb)`,
      [mmsis[0], latest.eventId, latest.captureId, low, latest.observedAt, JSON.stringify(latest)],
    );
    api = await createApi(infra, { scheduler: false, origins: ['http://127.0.0.1:13001'] });
    api.app.getHttpAdapter().getInstance().set('trust proxy', 'loopback');
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
    csrf = login.body.csrfToken;
  });
  afterAll(async () => {
    if (api) await api.stop();
    if (!infra) return;
    await infra.clickhouse.command({
      query: 'ALTER TABLE positions DELETE WHERE sourceId IN {sources:Array(String)}',
      query_params: { sources: [low, high] },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=ANY($1::text[])', [mmsis]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [mmsis]);
    await infra.pool.query('DELETE FROM intelligence_objects WHERE id=ANY($1::text[])', [
      [3, 4, 5].map((index) => `${prefix}-object-${index}`),
    ]);
    await infra.pool.query('DELETE FROM sessions WHERE user_id=$1', [userId]);
    await infra.pool.query(
      "DELETE FROM audit WHERE user_id=$1 OR (action='login_attempt' AND resource_type='authentication' AND resource_id=$2)",
      [userId, hashToken(loginIp)],
    );
    await infra.pool.query('DELETE FROM users WHERE id=$1', [userId]);
    await infra.close();
  });
  it('selects historical membership even when the latest position has left the region', async () => {
    const result = await queryVesselTracks(infra, query());
    expect(result.returnedVessels).toBe(1);
    expect(
      result.tracks[0]!.segments.flatMap((segment) => segment.points.map((point) => point.lon)),
    ).toEqual([179, 150]);
    expect(result.trackScope).toBe('full_time_window');
  });
  it('resolves cleaning revisions and preferred sources before bbox, with consistent source filtering', async () => {
    expect((await queryVesselTracks(infra, query([1, 8]))).returnedVessels).toBe(0);
    const filtered = await queryVesselTracks(infra, { ...query([1]), sourceId: low });
    expect(filtered.returnedVessels).toBe(1);
    expect(filtered.tracks[0]?.segments[0]?.points[0]?.lon).toBe(179);
    expect(filtered.tracks[0]?.total).toBe(1);
  });
  it('uses half-open time bounds and equivalent date-line endpoints', async () => {
    expect(
      (await queryVesselTracks(infra, query([6, 7]))).tracks.map((track) => track.mmsi),
    ).toEqual([mmsis[7]]);
    expect(
      (await queryVesselTracks(infra, { ...query([7]), bbox: [180, -10, 180, 10] }))
        .returnedVessels,
    ).toBe(1);
  });
  it('preserves gaps and date-line segments and samples native endpoints', async () => {
    const result = await queryVesselTracks(infra, { ...query([2, 3]), maxPointsPerVessel: 4 });
    const crossing = result.tracks.find((track) => track.mmsi === mmsis[2])!;
    expect(crossing.segments.map((segment) => segment.points.length)).toEqual([1, 1, 1]);
    const sampled = result.tracks.find((track) => track.mmsi === mmsis[3])!;
    expect(sampled).toMatchObject({ total: 20, returned: 4, sampled: true, truncated: false });
    expect(sampled.segments[0]?.points.at(-1)?.observedAt).toBe(at(19));
    expect(
      (await queryVesselTracks(infra, { ...query([2]), maxPointsPerVessel: 2 })).tracks[0],
    ).toMatchObject({ truncated: true, returned: 2 });
  });
  it('resolves recorded models exactly, intersects fields and treats aliases as literal text', async () => {
    const models = await queryVesselTracks(infra, {
      ...query([3, 4, 5]),
      selector: { mmsis: mmsis.slice(3, 6), model: '052d' },
    });
    expect(models.tracks.map((track) => track.mmsi)).toEqual([mmsis[3], mmsis[4]]);
    const typed = await queryVesselTracks(infra, {
      ...query([3, 4]),
      selector: { model: '052D', shipTypes: [70], query: '海巡%_' },
    });
    expect(typed.tracks.map((track) => track.mmsi)).toEqual([mmsis[3]]);
    const percent = await queryVesselTracks(infra, {
      ...query([3, 4, 5]),
      selector: { mmsis: mmsis.slice(3, 6), query: '%' },
    });
    expect(percent.tracks.map((track) => track.mmsi)).toEqual([mmsis[3]]);
    expect(
      (await queryVesselTracks(infra, { ...query(), selector: { model: '未记录型号' } }))
        .returnedVessels,
    ).toBe(0);
  });
  it('reports bounded candidate overflow in stable MMSI order', async () => {
    const result = await queryVesselTracks(infra, { ...query([3, 4, 5]), maxVessels: 1 });
    expect(result).toMatchObject({
      returnedVessels: 1,
      matchedVesselsLowerBound: 2,
      hasMoreVessels: true,
    });
    expect(result.tracks[0]?.mmsi).toBe(mmsis[3]);
  });
  it('requires login, Origin and CSRF while allowing viewers to perform a read-only POST', async () => {
    const url = '/api/v1/map/vessel-tracks/query';
    await request(api.app.getHttpServer()).post(url).send(query()).expect(401);
    await request(api.app.getHttpServer())
      .post(url)
      .set('Cookie', cookie)
      .send(query())
      .expect(403);
    await request(api.app.getHttpServer())
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .send(query())
      .expect(403);
    const result = await request(api.app.getHttpServer())
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', csrf)
      .send(query())
      .expect(200);
    const shared = await queryVesselTracks(infra, query());
    expect(result.body.tracks).toEqual(shared.tracks);
    await infra.pool.query('UPDATE users SET disabled=true WHERE id=$1', [userId]);
    await request(api.app.getHttpServer())
      .post(url)
      .set('Cookie', cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', csrf)
      .send(query())
      .expect(401);
  });
});
