import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { queryAgentVessels } from './agent-query';
import { projectCircleRegion } from './agent-focus';
import type { Infrastructure } from './clients';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const infra = { pool } as Infrastructure;
const source = `radius-qa-${randomUUID()}`;
const ids: string[] = [];
beforeAll(async () => {
  // A unique source isolates the test from imported/user vessels without clearing any data.
  const base = 800000000 + Math.floor(Math.random() * 1000000);
  for (let i = 0; i < 143; i++) ids.push(String(base + i));
  await pool.query('INSERT INTO vessels(mmsi) SELECT unnest($1::text[])', [ids]);
});
afterAll(async () => {
  await pool.query('DELETE FROM positions_latest WHERE source_id=$1', [source]);
  await pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [ids]);
  await pool.end();
});
for (const center of [
  [179.99, 0],
  [179.99, 80],
] as [number, number][]) {
  it(`filters a real spheroidal circle before total/100 limit at ${center}`, async () => {
    await pool.query('DELETE FROM positions_latest WHERE source_id=$1', [source]);
    // First 40 MMSIs are outside: paginating first would lose eligible rows.
    await pool.query(
      `WITH samples AS (
      SELECT mmsi,i, ST_Project(ST_SetSRID(ST_MakePoint($3,$4),4326)::geography,
        CASE WHEN i<=40 THEN 1500 WHEN i=143 THEN 1000.001 ELSE 999.999 END,pi()/2) AS point
      FROM unnest($1::text[]) WITH ORDINALITY AS t(mmsi,i))
      INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,
      observed_at,received_at,cleaning_version,latitude,longitude,location,observation)
      SELECT mmsi,mmsi,mmsi,$2,'fixture-http',1,now()-interval '1 second',now(),1,
      ST_Y(point::geometry),ST_X(point::geometry),point,'{}'::jsonb FROM samples`,
      [ids, source, ...center],
    );
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        filters: { sourceId: source },
        region: { kind: 'circle', center, radiusMeters: 1000 },
      },
    });
    expect(result.total).toBe(102);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(
      result.items.every((item) => ids.indexOf(item.mmsi) >= 40 && item.mmsi !== ids[142]),
    ).toBe(true);
    const repeated = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        filters: { sourceId: source },
        region: { kind: 'circle', center, radiusMeters: 1000 },
      },
    });
    expect(repeated.total).toBe(result.total);
    expect(repeated.items.map((x) => x.mmsi)).toEqual(result.items.map((x) => x.mmsi));
    const geometry = await projectCircleRegion(infra, {
      kind: 'circle',
      center,
      radiusMeters: 1000,
    });
    const points = await pool.query(
      `SELECT min(ST_Distance(p.geom::geography,c.g)) AS minimum,
      max(ST_Distance(p.geom::geography,c.g)) AS maximum,
      bool_and(ST_DWithin(p.geom::geography,c.g,1000.001)) AS inside,
      bool_or(ST_X(p.geom)<0) AS crossed
      FROM ST_DumpPoints(ST_GeomFromGeoJSON($1)) p CROSS JOIN
      (SELECT ST_SetSRID(ST_MakePoint($2,$3),4326)::geography g)c`,
      [JSON.stringify(geometry), ...center],
    );
    expect(Number(points.rows[0].minimum)).toBeCloseTo(1000, 3);
    expect(Number(points.rows[0].maximum)).toBeCloseTo(1000, 3);
    expect(points.rows[0].inside).toBe(true);
    if (center[1] === 80) expect(points.rows[0].crossed).toBe(true);
  });
}
