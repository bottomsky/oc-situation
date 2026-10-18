import { prepareRouteDataset } from './route-navigation';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRoute,
  updateRoute,
  routeHistory,
  listRoutes,
  createRoutePlan,
  getRoutePlan,
  cancelRoutePlan,
  saveRouteRestriction,
} from './routes';
import { executeRoutePlan } from './route-planning';

describe('planned routes on real PostGIS', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const infra = { pool };
  const actor = { id: randomUUID(), role: 'operator' };
  const dataset = `test-${randomUUID()}`;
  const routeIds: string[] = [];
  const planIds: string[] = [];
  const restrictionIds: string[] = [];
  beforeAll(async () => {
    await pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','operator')",
      [actor.id, `route-${actor.id}`],
    );
    await pool.query('INSERT INTO route_datasets(version,manifest) VALUES($1,$2)', [
      dataset,
      JSON.stringify({ fixture: true }),
    ]);
    await pool.query(
      `INSERT INTO route_land(dataset_version,geom,geog) VALUES($1,ST_MakeEnvelope(10,10,11,11,4326),ST_MakeEnvelope(10,10,11,11,4326)::geography)`,
      [dataset],
    );
    for (const [id, point] of [
      ['a', [0, 0]],
      ['b', [1, 1]],
      ['c', [2, 0]],
    ] as const)
      await pool.query(
        'INSERT INTO route_nodes(dataset_version,id,coordinate,geog) VALUES($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326)::geography)',
        [dataset, id, JSON.stringify(point), point[0], point[1]],
      );
    for (const edge of [
      {
        from: 'a',
        to: 'b',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
      {
        from: 'b',
        to: 'c',
        coordinates: [
          [1, 1],
          [2, 0],
        ],
      },
    ])
      await pool.query(
        'INSERT INTO route_edges(dataset_version,from_id,to_id,coordinates,geog) VALUES($1,$2,$3,$4,ST_GeomFromGeoJSON($5)::geography)',
        [
          dataset,
          edge.from,
          edge.to,
          JSON.stringify(edge.coordinates),
          JSON.stringify({ type: 'LineString', coordinates: edge.coordinates }),
        ],
      );
    await prepareRouteDataset(infra, dataset);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM route_revisions WHERE route_id=ANY($1::uuid[])', [routeIds]);
    await pool.query('DELETE FROM routes WHERE id=ANY($1::uuid[])', [routeIds]);
    await pool.query('DELETE FROM route_plans WHERE user_id=$1', [actor.id]);
    await pool.query('DELETE FROM route_restrictions WHERE id=ANY($1::uuid[])', [restrictionIds]);
    await pool.query('DELETE FROM route_operation_receipts WHERE user_id=$1', [actor.id]);
    await pool.query('DELETE FROM audit WHERE user_id=$1', [actor.id]);
    await pool.query('DELETE FROM users WHERE id=$1', [actor.id]);
    await pool.query('DELETE FROM route_edges WHERE dataset_version=$1', [dataset]);
    await pool.query('DELETE FROM route_nodes WHERE dataset_version=$1', [dataset]);
    await pool.query('DELETE FROM route_land WHERE dataset_version=$1', [dataset]);
    await pool.query('DELETE FROM route_datasets WHERE version=$1', [dataset]);
    await pool.end();
  });
  const body = () => ({
    operationId: randomUUID(),
    name: 'Fixture route',
    waypoints: [
      [0, 0],
      [2, 0],
    ],
    geometry: {
      type: 'LineString',
      coordinates: [
        [0, 0],
        [1, 1],
        [2, 0],
      ],
    },
  });
  it('commits one business record, audit and receipt; rejects conflicting retries and stale revisions', async () => {
    const input = body();
    const route = await createRoute(infra, actor, input);
    routeIds.push(route.id);
    expect((await createRoute(infra, actor, input)).id).toBe(route.id);
    await expect(createRoute(infra, actor, { ...input, name: 'different' })).rejects.toThrow(
      'operation_conflict',
    );
    const updated = await updateRoute(infra, actor, route.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      name: 'Revised',
    });
    expect(updated.revision).toBe(2);
    await expect(
      updateRoute(infra, actor, route.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        name: 'Late',
      }),
    ).rejects.toThrow('revision_conflict');
    expect(await routeHistory(infra, route.id)).toHaveLength(2);
    expect(
      Number(
        (await pool.query('SELECT count(*) AS n FROM audit WHERE user_id=$1', [actor.id])).rows[0]
          .n,
      ),
    ).toBe(2);
  });
  it('rolls back a failing task fence and enforces current database role', async () => {
    const input = body();
    await expect(
      createRoute(infra, actor, input, async () => {
        throw new Error('cancelled_task');
      }),
    ).rejects.toThrow('cancelled_task');
    expect(
      (
        await pool.query('SELECT * FROM route_operation_receipts WHERE operation_id=$1', [
          input.operationId,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(createRoute(infra, { ...actor, role: 'viewer' }, body())).rejects.toThrow(
      'forbidden',
    );
  });
  it('filters geography before counting and paging', async () => {
    const found = await listRoutes(infra, {
      longitude: 1,
      latitude: 1,
      radiusMeters: 100,
      limit: 1,
    });
    expect(found.total).toBeGreaterThan(0);
    expect(found.items).toHaveLength(1);
    const absent = await listRoutes(infra, { longitude: 0, latitude: 50, radiusMeters: 100 });
    expect(absent.total).toBe(0);
  });
  async function plan(waypoints: number[][]) {
    const job = await createRoutePlan(infra, actor, { operationId: randomUUID(), waypoints });
    planIds.push(job.id);
    await pool.query('UPDATE route_plans SET dataset_version=$2 WHERE id=$1', [job.id, dataset]);
    return job;
  }
  it('rejects unprepared datasets and resumes completed preparation idempotently', async () => {
    await pool.query("UPDATE route_datasets SET navigation_status='preparing' WHERE version=$1", [
      dataset,
    ]);
    const job = await plan([
      [0, 0],
      [2, 0],
    ]);
    await executeRoutePlan(infra, job.id);
    expect((await getRoutePlan(infra, job.id))?.error).toBe('dataset_unprepared');
    await pool.query('UPDATE route_edges SET base_navigable=NULL WHERE dataset_version=$1', [
      dataset,
    ]);
    await expect(
      prepareRouteDataset(infra, dataset, {
        batchSize: 1,
        onProgress: () => {
          throw new Error('interrupted preparation');
        },
      }),
    ).rejects.toThrow('interrupted preparation');
    const progress = (
      await pool.query(
        'SELECT navigation_status,navigation_checked_edges FROM route_datasets WHERE version=$1',
        [dataset],
      )
    ).rows[0];
    expect(progress).toEqual({ navigation_status: 'failed', navigation_checked_edges: 1 });
    const prepared = await prepareRouteDataset(infra, dataset, { batchSize: 1 });
    expect(prepared).toEqual({ edges: 2, navigable: 2 });
    const again = await prepareRouteDataset(infra, dataset);
    expect(again).toEqual(prepared);
  });
  it('runs a real worker, saves route geometry and ignores a cancelled job', async () => {
    const job = await plan([
      [0, 0],
      [2, 0],
    ]);
    await executeRoutePlan(infra, job.id);
    const result = await getRoutePlan(infra, job.id);
    expect(result?.status).toBe('completed');
    expect(result?.result?.lengthMeters).toBeGreaterThan(200000);
    const cancelled = await plan([
      [0, 0],
      [2, 0],
    ]);
    await cancelRoutePlan(infra, actor, cancelled.id, { operationId: randomUUID() });
    await executeRoutePlan(infra, cancelled.id);
    expect((await getRoutePlan(infra, cancelled.id))?.status).toBe('cancelled');
  });
  it('hard-times out the complete task and reports absent datasets', async () => {
    const job = await plan([
      [0, 0],
      [2, 0],
    ]);
    await executeRoutePlan(infra, job.id, { timeoutMs: 1 });
    expect((await getRoutePlan(infra, job.id))?.error).toBe('timeout');
    const absent = await plan([
      [0, 0],
      [2, 0],
    ]);
    await pool.query('UPDATE route_plans SET dataset_version=NULL WHERE id=$1', [absent.id]);
    await executeRoutePlan(infra, absent.id);
    expect((await getRoutePlan(infra, absent.id))?.error).toBe('dataset_unavailable');
  });
  it('keeps a running cancellation durable against late completion', async () => {
    const job = await plan([
      [0, 0],
      [2, 0],
    ]);
    const running = executeRoutePlan(infra, job.id, { cancelPollMs: 1 });
    for (let i = 0; i < 100; i++) {
      const state = await getRoutePlan(infra, job.id);
      if (state?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await cancelRoutePlan(infra, actor, job.id, { operationId: randomUUID() });
    await running;
    expect((await getRoutePlan(infra, job.id))?.status).toBe('cancelled');
  });
  it('reports on-land endpoints without inventing a route', async () => {
    const job = await plan([
      [10.5, 10.5],
      [2, 0],
    ]);
    await executeRoutePlan(infra, job.id);
    expect((await getRoutePlan(infra, job.id))?.error).toBe('endpoint_on_land');
  });
  it('rejects water endpoints whose only near connector crosses actual land', async () => {
    const inserted = await pool.query(
      `INSERT INTO route_land(dataset_version,geom,geog) VALUES($1,ST_MakeEnvelope(-0.6,-1,-0.4,1,4326),ST_MakeEnvelope(-0.6,-1,-0.4,1,4326)::geography) RETURNING id`,
      [dataset],
    );
    try {
      const job = await plan([
        [-1, 0],
        [2, 0],
      ]);
      await executeRoutePlan(infra, job.id);
      expect((await getRoutePlan(infra, job.id))?.error).toBe('no_connector');
    } finally {
      await pool.query('DELETE FROM route_land WHERE id=$1', [inserted.rows[0].id]);
    }
  });
  it('blocks crossing edge polylines and land-crossing connectors', async () => {
    // Barrier separates every start connector (within 200 km) from every destination connector.
    const id = randomUUID();
    restrictionIds.push(id);
    await saveRouteRestriction(infra, actor, id, {
      operationId: randomUUID(),
      name: 'Barrier',
      validFrom: '2000-01-01T00:00:00Z',
      validUntil: null,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [0.8, -2],
            [1.2, -2],
            [1.2, 2],
            [0.8, 2],
            [0.8, -2],
          ],
        ],
      },
    });
    const job = await plan([
      [0, 0],
      [2, 0],
    ]);
    await executeRoutePlan(infra, job.id);
    const failed = await getRoutePlan(infra, job.id);
    expect(failed?.status).toBe('failed');
    expect(['no_connector', 'no_path']).toContain(failed?.error);
  });
});
