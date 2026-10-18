import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { queryAgentVessels } from './agent-query';
import type { Infrastructure } from './clients';
import { focusFromContext } from '../../apps/agent/focus-runtime';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const infra = { pool } as Infrastructure;
const source = `vessel-radius-${randomUUID()}`,
  anchorSource = `${source}-anchor`;
const base = 810000000 + Math.floor(Math.random() * 1000000);
const ids = Array.from({ length: 145 }, (_, i) => String(base + i));
const anchor = ids[0]!;
beforeAll(async () => {
  await pool.query(
    'INSERT INTO vessels(mmsi,ship_type) SELECT mmsi,CASE WHEN i=1 THEN 30 ELSE 70 END FROM unnest($1::text[]) WITH ORDINALITY t(mmsi,i)',
    [ids],
  );
  await pool.query(
    `WITH samples AS (
    SELECT mmsi,i,ST_Project(ST_SetSRID(ST_MakePoint(179.99,0),4326)::geography,
      CASE WHEN i<=40 THEN 150000 WHEN i=143 THEN 100000.001 ELSE 99999.999 END,pi()/2) AS point
    FROM unnest($1::text[]) WITH ORDINALITY t(mmsi,i))
    INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,observation)
    SELECT mmsi,mmsi,mmsi,$2,'fixture-http',1,now()-interval '1 hour',now(),1,ST_Y(point::geometry),ST_X(point::geometry),point,'{}'::jsonb FROM samples`,
    [ids.slice(1, 144), source],
  );
  await pool.query(
    `INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,observation)
    VALUES($1,$1,$1,$2,'fixture-http',1,now()-interval '1 hour',now(),1,0,179.99,ST_SetSRID(ST_MakePoint(179.99,0),4326)::geography,'{}'::jsonb)`,
    [anchor, anchorSource],
  );
});
afterAll(async () => {
  await pool.query('DELETE FROM positions_latest WHERE mmsi=ANY($1::text[])', [ids]);
  await pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [ids]);
  await pool.end();
});

it('counts the exact 100km sphere before limiting and anchors independently of target source/type', async () => {
  const result = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: {
      vesselCircle: { mmsi: anchor, radiusMeters: 100000 },
      bbox: [-1, -1, 1, 1],
      mmsis: [anchor],
      vesselSelector: { mmsis: [anchor] },
      filters: { sourceId: source, shipType: 70 },
    },
  });
  expect(result.total).toBe(102);
  expect(result.items).toHaveLength(100);
  expect(result.truncated).toBe(true);
  expect(result.selection.region).toEqual({
    kind: 'circle',
    center: [179.99, 0],
    radiusMeters: 100000,
  });
  expect(result.regionAnchor).toMatchObject({ mmsi: anchor, sourceId: anchorSource });
  expect(result.regionGeometry?.type).toBe('Polygon');
  await pool.query(
    'UPDATE positions_latest SET longitude=0,latitude=0,location=ST_SetSRID(ST_MakePoint(0,0),4326)::geography WHERE mmsi=$1',
    [anchor],
  );
  try {
    const focus = await focusFromContext(
      {
        task: {
          id: randomUUID(),
          sessionId: randomUUID(),
          inputRevision: 0,
          selection: { vesselCircle: { mmsi: anchor, radiusMeters: 100000 } },
        },
        results: [],
        steps: [],
        queryResult: result,
      } as never,
      {
        resolveFocus: async () => {
          throw new Error('must reuse frozen geometry');
        },
      } as never,
    );
    expect(focus.targets[0]).toMatchObject({
      ref: { kind: 'region' },
      geometry: result.regionGeometry,
      region: result.selection.region,
      observedAt: result.regionAnchor!.observedAt,
    });
    expect(focus.omittedCount).toBe(3);
  } finally {
    await pool.query(
      'UPDATE positions_latest SET longitude=179.99,latitude=0,location=ST_SetSRID(ST_MakePoint(179.99,0),4326)::geography WHERE mmsi=$1',
      [anchor],
    );
  }
});

it('counts the center ship when it matches the result filters', async () => {
  const result = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: {
      vesselCircle: { mmsi: anchor, radiusMeters: 100000 },
      filters: { sourceId: anchorSource },
    },
  });
  expect(result.total).toBe(1);
  expect(result.items[0]?.mmsi).toBe(anchor);
});

it('returns a located circle even when no target ship matches the result filters', async () => {
  const result = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: {
      vesselCircle: { mmsi: anchor, radiusMeters: 100000 },
      filters: { sourceId: source, shipType: 99 },
    },
  });
  expect(result.total).toBe(0);
  expect(result.regionAnchor?.mmsi).toBe(anchor);
  expect(result.regionGeometry).toBeDefined();
  const focus = await focusFromContext(
    {
      task: { id: randomUUID(), sessionId: randomUUID(), inputRevision: 0, selection: {} },
      results: [],
      steps: [],
      queryResult: result,
    } as never,
    {} as never,
  );
  expect(focus.targets).toHaveLength(1);
  expect(focus.targets[0]?.ref.kind).toBe('region');
});

it('fails clearly for an unknown center ship instead of using a supplied viewport', async () => {
  await expect(
    queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        vesselCircle: { mmsi: ids[144]!, radiusMeters: 100000 },
        bbox: [179, -1, 180, 1],
      },
    }),
  ).rejects.toMatchObject({ code: 'anchor_position_unavailable' });
});

it.each([-25, 1])('rejects an anchor observation %s hours from now', async (hours) => {
  await pool.query(
    'UPDATE positions_latest SET observed_at=now()+make_interval(hours=>$2) WHERE mmsi=$1',
    [anchor, hours],
  );
  try {
    await expect(
      queryAgentVessels(infra, {
        kind: 'vessel_list',
        inputRevision: 0,
        selection: { vesselCircle: { mmsi: anchor, radiusMeters: 100000 } },
      }),
    ).rejects.toMatchObject({ code: 'anchor_position_unavailable' });
  } finally {
    await pool.query(
      "UPDATE positions_latest SET observed_at=now()-interval '1 hour' WHERE mmsi=$1",
      [anchor],
    );
  }
});
