import pg, { type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import { loadConfig } from '../../../../packages/infrastructure/config';
import { MapPointSnapshotService } from '../../../../packages/infrastructure/map-snapshots';
import { queryAgentVessels } from '../../../../packages/infrastructure/agent-query';
import { MapController } from './controller';

const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl, max: 1 });
let client: PoolClient | undefined;
let infra: Infrastructure;
const mmsis = ['999000001', '999000002', '999000003'];
const bbox = [119, 29, 121, 31] as [number, number, number, number];

beforeAll(async () => {
  client = await pool.connect();
  await client.query('BEGIN');
  // Shadow only this connection's names; persistent business tables remain untouched.
  await client.query(
    `CREATE TEMP TABLE vessels(mmsi text PRIMARY KEY,name text,imo text,ship_type integer) ON COMMIT DROP`,
  );
  await client.query(
    `CREATE TEMP TABLE positions_latest(mmsi text PRIMARY KEY,source_id text,observed_at timestamptz,latitude double precision,longitude double precision,location geography(Point,4326),sog double precision,observation jsonb) ON COMMIT DROP`,
  );
  await client.query('INSERT INTO vessels SELECT mmsi,mmsi,NULL,70 FROM unnest($1::text[]) mmsi', [
    mmsis,
  ]);
  await client.query(
    `WITH samples AS (SELECT mmsi,now()-CASE i WHEN 1 THEN interval '2 minutes' WHEN 2 THEN interval '15 minutes' ELSE interval '15 minutes 0.001 seconds' END observed_at FROM unnest($1::text[]) WITH ORDINALITY t(mmsi,i)) INSERT INTO positions_latest SELECT mmsi,'minute-fixture',observed_at,30,120,ST_SetSRID(ST_MakePoint(120,30),4326)::geography,10,jsonb_build_object('mmsi',mmsi,'lat',30,'lon',120,'observedAt',to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceId','minute-fixture','sogKnots',10,'cogDegrees',90,'headingDegrees',90,'quality','[]'::jsonb) FROM samples`,
    [mmsis],
  );
  infra = {
    pool: { query: (sql: string, values?: unknown[]) => client!.query(sql, values) },
  } as Infrastructure;
});

afterAll(async () => {
  if (client) {
    await client.query('ROLLBACK');
    client.release();
  }
  await pool.end();
});

it('真实PostGIS的HTTP旧协议和单船快照保留15分钟截止点，排除早1毫秒观测', async () => {
  const legacy = await new MapController(infra).get({ bbox: bbox.join(','), zoom: 8, hours: 0.25 });
  expect(legacy.total).toBe(2);
  expect(legacy.items.map((item) => (item.kind === 'point' ? item.mmsi : ''))).toEqual(
    mmsis.slice(0, 2),
  );
  const points = await new MapPointSnapshotService(infra).read(
    { bbox, zoom: 3, hours: 0.25 },
    'test',
  );
  expect(points.items.map((item) => item.mmsi)).toEqual(mmsis.slice(0, 2));
  const widened = await new MapPointSnapshotService(infra).read({ bbox, hours: 0.5 }, 'test');
  expect(widened.items.map((item) => item.mmsi)).toEqual(mmsis);
});

it('真实AI区域查询与海图共享分钟范围，旧24小时调用保持全部船位', async () => {
  const selected = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: { bbox, filters: { hours: 0.25 } },
  });
  expect(selected.items.map((item) => item.mmsi)).toEqual(mmsis.slice(0, 2));
  const integer = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: { bbox, filters: { hours: 24 } },
  });
  expect(integer.items.map((item) => item.mmsi)).toEqual(mmsis);
});

it('船舶圆形区域中心及结果均遵守分钟范围，过期中心不能从旧区域回退', async () => {
  const selected = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: {
      vesselCircle: { mmsi: mmsis[0]!, radiusMeters: 100000 },
      filters: { hours: 0.25 },
    },
  });
  expect(selected.total).toBe(2);
  expect(selected.items.map((item) => item.mmsi)).toEqual(mmsis.slice(0, 2));
  await expect(
    queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        vesselCircle: { mmsi: mmsis[2]!, radiusMeters: 100000 },
        bbox,
        filters: { hours: 0.25 },
      },
    }),
  ).rejects.toMatchObject({ code: 'anchor_position_unavailable' });
});
