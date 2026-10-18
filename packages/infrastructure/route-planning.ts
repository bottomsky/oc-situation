import { logger } from './clients';
import { routeBaseObstacleTest, routePassageTest } from './route-navigation';
import { Worker } from 'node:worker_threads';
import type { PoolClient } from 'pg';
import type { RouteCoordinate } from '../contracts/routes';
import {
  planGraphRoute,
  routeDistance,
  RoutePlanningError,
  RouteMinHeap,
  type RouteGraphInput,
} from '../domain/route-planning';
import type { RouteInfrastructure } from './routes';

/** Self-contained worker source built from the exact functions exercised by the domain tests. */
export function routeWorkerSource() {
  return `const __name=(target,value)=>Object.defineProperty(target,'name',{value,configurable:true});const {parentPort,workerData}=require('node:worker_threads');const routeDistance=${routeDistance.toString()};const RoutePlanningError=${RoutePlanningError.toString()};const RouteMinHeap=${RouteMinHeap.toString()};const planGraphRoute=${planGraphRoute.toString()};try{const coordinates=[];for(const leg of workerData){const result=planGraphRoute(leg);coordinates.push(...result.coordinates.slice(coordinates.length?1:0));}parentPort.postMessage({geometry:{type:'LineString',coordinates},lengthMeters:routeDistance(coordinates)});}catch(error){parentPort.postMessage({error:error.code||error.message});}`;
}
const activeRestrictions = `SELECT * FROM (SELECT DISTINCT ON(id) * FROM route_restrictions WHERE version<=$2 ORDER BY id,revision DESC) r WHERE enabled AND valid_from<=$3 AND (valid_until IS NULL OR valid_until>$3)`;
function obstacleTest(expression: string) {
  return `(${routeBaseObstacleTest(expression)} OR EXISTS(SELECT 1 FROM (${activeRestrictions}) r WHERE ST_Intersects(r.geog,${expression})))`;
}
async function inputs(
  client: PoolClient,
  job: Record<string, unknown>,
  deadline: number,
): Promise<RouteGraphInput[]> {
  const query = async (sql: string, values: unknown[]) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new RoutePlanningError('timeout');
    await client.query(`SET LOCAL statement_timeout = '${remaining}ms'`);
    const state = await client.query('SELECT status FROM route_plans WHERE id=$1', [job.id]);
    if (state.rows[0]?.status !== 'running') throw new RoutePlanningError('cancelled');
    const budget = deadline - Date.now();
    if (budget <= 0) throw new RoutePlanningError('timeout');
    await client.query(`SET LOCAL statement_timeout = '${budget}ms'`);
    return client.query(sql, values);
  };
  const dataset = job.dataset_version;
  if (!dataset) throw new RoutePlanningError('dataset_unavailable');
  const prepared = await query('SELECT navigation_status FROM route_datasets WHERE version=$1', [
    dataset,
  ]);
  if (prepared.rows[0]?.navigation_status !== 'ready')
    throw new RoutePlanningError('dataset_unprepared');
  const available = await query(
    'SELECT EXISTS(SELECT 1 FROM route_nodes WHERE dataset_version=$1) AND EXISTS(SELECT 1 FROM route_land WHERE dataset_version=$1) AS valid',
    [dataset],
  );
  if (!available.rows[0]?.valid) throw new RoutePlanningError('dataset_unavailable');
  const params = [dataset, job.restriction_version, job.created_at];
  const waypoints = (job.input as { waypoints: RouteCoordinate[] }).waypoints;
  const connectors: string[][] = [];
  for (const point of waypoints) {
    const p = [...params, point[0], point[1]];
    const coordinate = 'ST_SetSRID(ST_MakePoint($4,$5),4326)::geography';
    const blocked = await query(
      `SELECT EXISTS(SELECT 1 FROM route_land WHERE dataset_version=$1 AND ST_Intersects(geog,${coordinate})) AS land, EXISTS(SELECT 1 FROM (${activeRestrictions}) r WHERE ST_Intersects(geog,${coordinate})) OR ${routePassageTest(coordinate)} AS restricted`,
      p,
    );
    if (blocked.rows[0].land) throw new RoutePlanningError('endpoint_on_land');
    if (blocked.rows[0].restricted) throw new RoutePlanningError('endpoint_restricted');
    const line = `ST_MakeLine(${coordinate}::geometry,n.geog::geometry)::geography`;
    const nodes = await query(
      `SELECT n.id FROM route_nodes n WHERE dataset_version=$1 AND ST_DWithin(n.geog,${coordinate},200000) AND NOT ${obstacleTest(line)} ORDER BY ST_Distance(n.geog,${coordinate}),n.id LIMIT 16`,
      p,
    );
    if (!nodes.rowCount) throw new RoutePlanningError('no_connector');
    connectors.push(nodes.rows.map((r) => r.id));
  }
  const nodes = (
    await query('SELECT id,coordinate FROM route_nodes WHERE dataset_version=$1', [dataset])
  ).rows;
  const edges = (
    await query(
      `SELECT from_id AS "from",to_id AS "to",coordinates,channel FROM route_edges e WHERE dataset_version=$1 AND base_navigable AND NOT EXISTS(SELECT 1 FROM (${activeRestrictions}) r WHERE ST_Intersects(r.geog,e.geog))`,
      params,
    )
  ).rows;
  return waypoints.slice(1).map((end, index) => ({
    nodes,
    edges,
    start: [waypoints[index]!, connectors[index]!],
    end: [end, connectors[index + 1]!],
  }));
}
export async function executeRoutePlan(
  infra: RouteInfrastructure,
  id: string,
  options: { timeoutMs?: number; cancelPollMs?: number } = {},
) {
  const deadline = Date.now() + (options.timeoutMs ?? 30000);
  let connectionExpired = false;
  let connectionTimer: ReturnType<typeof setTimeout> | undefined;
  const acquisition = infra.pool.connect().then((client) => {
    if (connectionExpired) {
      client.release();
      return undefined;
    }
    return client;
  });
  const client = await Promise.race([
    acquisition,
    new Promise<undefined>((resolve) => {
      connectionTimer = setTimeout(
        () => {
          connectionExpired = true;
          resolve(undefined);
        },
        Math.max(1, deadline - Date.now()),
      );
    }),
  ]).finally(() => clearTimeout(connectionTimer));
  if (!client) return;
  let worker: Worker | undefined;
  let job: Record<string, unknown> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined,
    poll: ReturnType<typeof setInterval> | undefined;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
    const claimed = await client.query(
      "UPDATE route_plans SET status='running',claimed_at=now(),updated_at=now() WHERE id=$1 AND status='queued' RETURNING *",
      [id],
    );
    job = claimed.rows[0];
    await client.query('COMMIT');
    if (!job) return;
    if (Date.now() >= deadline) throw new RoutePlanningError('timeout');
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
    const legs = await inputs(client, job, deadline);
    await client.query('COMMIT');
    if (Date.now() >= deadline) throw new RoutePlanningError('timeout');
    const result = await new Promise<{
      geometry: { type: 'LineString'; coordinates: RouteCoordinate[] };
      lengthMeters: number;
    }>((resolve, reject) => {
      worker = new Worker(routeWorkerSource(), { eval: true, workerData: legs });
      deadlineTimer = setTimeout(
        () => {
          void worker?.terminate();
          reject(new RoutePlanningError('timeout'));
        },
        Math.max(1, deadline - Date.now()),
      );
      poll = setInterval(() => {
        void infra.pool
          .query('SELECT status FROM route_plans WHERE id=$1', [id])
          .then((r) => {
            if (r.rows[0]?.status !== 'running') {
              void worker?.terminate();
              reject(new RoutePlanningError('cancelled'));
            }
          })
          .catch(reject);
      }, options.cancelPollMs ?? 250);
      worker.once('message', (value) =>
        value.error ? reject(new RoutePlanningError(value.error)) : resolve(value),
      );
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new RoutePlanningError('worker_failed'));
      });
    });
    // Repeat the complete polyline obstacle check; commit is fenced by durable job state.
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
    const valid = await client.query(
      `SELECT NOT ${obstacleTest('ST_GeomFromGeoJSON($4)::geography')} AS valid`,
      [
        job.dataset_version,
        job.restriction_version,
        job.created_at,
        JSON.stringify(result.geometry),
      ],
    );
    if (!valid.rows[0].valid) throw new RoutePlanningError('route_blocked');
    if (Date.now() >= deadline) throw new RoutePlanningError('timeout');
    await client.query(`SET LOCAL statement_timeout = '${Math.max(1, deadline - Date.now())}ms'`);
    const completion = await client.query(
      "UPDATE route_plans SET status='completed',result=$2,updated_at=now() WHERE id=$1 AND status='running' AND clock_timestamp()<to_timestamp($3/1000.0)",
      [id, JSON.stringify(result), deadline],
    );
    if (!completion.rowCount && Date.now() >= deadline) throw new RoutePlanningError('timeout');
    await client.query('COMMIT');
  } catch (error) {
    if (!(error instanceof RoutePlanningError))
      logger.error(
        {
          code: (error as { code?: string }).code,
          message: error instanceof Error ? error.message : String(error),
        },
        'Route planning failed',
      );
    await client.query('ROLLBACK');
    const code =
      error instanceof RoutePlanningError
        ? error.code
        : (error as { code?: string }).code === '57014'
          ? 'timeout'
          : 'planning_failed';
    const knownReasons = new Set([
      'dataset_unavailable',
      'dataset_unprepared',
      'endpoint_on_land',
      'endpoint_restricted',
      'no_connector',
      'no_path',
      'route_blocked',
      'timeout',
      'cancelled',
      'worker_failed',
      'planning_failed',
    ]);
    logger.warn(
      { event: 'route_plan_failed', reason: knownReasons.has(code) ? code : 'planning_failed' },
      'Route plan did not complete',
    );
    await client.query(
      "UPDATE route_plans SET status=$2,error=$3,updated_at=now() WHERE id=$1 AND status='running'",
      [id, code === 'cancelled' ? 'cancelled' : 'failed', code],
    );
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(poll);
    await worker?.terminate();
    client.release();
  }
}
/** Per-process concurrency cap. Row claim prevents duplicate work across schedulers. */
export class RoutePlanningScheduler {
  private running = 0;
  private ticking = false;
  private tasks = new Set<Promise<void>>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;
  constructor(private readonly infra: RouteInfrastructure) {}
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 500);
    this.timer.unref();
    void this.tick().catch(() => {});
  }
  async tick() {
    if (this.stopped || this.ticking || this.running >= 2) return;
    this.ticking = true;
    try {
      // A crashed process cannot leave jobs running indefinitely.
      await this.infra.pool.query(
        "UPDATE route_plans SET status='failed',error='worker_interrupted',updated_at=now() WHERE status='running' AND claimed_at < now()-interval '35 seconds'",
      );
      const free = 2 - this.running;
      const rows = await this.infra.pool.query(
        "SELECT id FROM route_plans WHERE status='queued' ORDER BY created_at LIMIT $1",
        [free],
      );
      for (const row of rows.rows) {
        if (this.stopped || this.running >= 2) break;
        this.running++;
        const task = executeRoutePlan(this.infra, row.id)
          .catch(() => {})
          .finally(() => {
            this.running--;
            this.tasks.delete(task);
          });
        this.tasks.add(task);
      }
    } finally {
      this.ticking = false;
    }
  }
  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    while (this.ticking) await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.allSettled([...this.tasks]);
  }
}
