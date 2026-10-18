import { logger } from './clients';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Infrastructure } from './clients';
import { routeDistance } from '../domain/route-planning';
import {
  CreateRouteSchema,
  UpdateRouteSchema,
  PlanRouteSchema,
  RestrictionSchema,
  CircleRouteQuerySchema,
  ImportRouteSchema,
  routeQueryCircle,
  type Route,
  type RoutePlan,
} from '../contracts/routes';

export class RouteStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
export interface RouteActor {
  id: string;
  role: string;
}
export type RouteFence = (client: PoolClient) => Promise<void>;
export type RouteInfrastructure = Pick<Infrastructure, 'pool'>;
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export function routeOperationHash(value: unknown) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
export async function routeWrite<T>(
  infra: RouteInfrastructure,
  actor: RouteActor,
  operationId: string,
  input: unknown,
  action: string,
  run: (client: PoolClient) => Promise<T>,
  fence?: RouteFence,
): Promise<T> {
  if (!['operator', 'admin'].includes(actor.role)) throw new RouteStoreError('forbidden', 403);
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `${actor.id}:${operationId}`,
    ]);
    const user = await client.query('SELECT role,disabled FROM users WHERE id=$1 FOR SHARE', [
      actor.id,
    ]);
    if (
      !user.rows[0] ||
      user.rows[0].disabled ||
      !['operator', 'admin'].includes(user.rows[0].role)
    )
      throw new RouteStoreError('forbidden', 403);
    const hash = routeOperationHash(input);
    const old = await client.query(
      'SELECT input_hash,result FROM route_operation_receipts WHERE user_id=$1 AND operation_id=$2',
      [actor.id, operationId],
    );
    if (old.rows[0]) {
      if (old.rows[0].input_hash !== hash) throw new RouteStoreError('operation_conflict');
      await client.query('COMMIT');
      logger.info(
        { event: 'business_operation', kind: 'route', idempotent_hit: true },
        'Recovered committed business operation',
      );
      return old.rows[0].result as T;
    }
    if (fence) await fence(client);
    const result = await run(client);
    if (fence) await fence(client);
    await client.query(
      'INSERT INTO audit(id,user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5,$6)',
      [
        randomUUID(),
        actor.id,
        action,
        'route',
        (result as { id?: string })?.id ?? null,
        JSON.stringify({ operationId }),
      ],
    );
    await client.query(
      'INSERT INTO route_operation_receipts(user_id,operation_id,input_hash,result) VALUES($1,$2,$3,$4)',
      [actor.id, operationId, hash, JSON.stringify(result)],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function persist(client: PoolClient, actor: RouteActor, route: Route) {
  await client.query(
    `INSERT INTO routes(id,revision,document,geog) VALUES($1,$2,$3,ST_GeomFromGeoJSON($4)::geography) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,document=excluded.document,geog=excluded.geog,updated_at=now()`,
    [route.id, route.revision, JSON.stringify(route), JSON.stringify(route.geometry)],
  );
  await client.query(
    'INSERT INTO route_revisions(route_id,revision,document,user_id) VALUES($1,$2,$3,$4)',
    [route.id, route.revision, JSON.stringify(route), actor.id],
  );
  return route;
}
export async function createRoute(
  infra: RouteInfrastructure,
  actor: RouteActor,
  body: unknown,
  fence?: RouteFence,
): Promise<Route> {
  const value = CreateRouteSchema.parse(body);
  return routeWrite(
    infra,
    actor,
    value.operationId,
    { kind: 'create', value },
    'route.create',
    async (client) => {
      let geometry = value.geometry,
        waypoints = value.waypoints;
      if (value.planId) {
        const plan = await client.query(
          "SELECT * FROM route_plans WHERE id=$1 AND status='completed'",
          [value.planId],
        );
        if (!plan.rows[0]) throw new RouteStoreError('plan_not_completed');
        geometry = plan.rows[0].result.geometry;
        waypoints = plan.rows[0].input.waypoints;
      }
      const now = new Date().toISOString();
      return persist(client, actor, {
        id: randomUUID(),
        revision: 1,
        name: value.name,
        status: value.status,
        mmsis: value.mmsis,
        geometry: geometry!,
        waypoints: waypoints!,
        lengthMeters: routeDistance(geometry!.coordinates),
        generatedBy: value.planId ? 'planner' : 'manual',
        planId: value.planId ?? null,
        createdAt: now,
        updatedAt: now,
      });
    },
    fence,
  );
}
export async function getRoute(infra: RouteInfrastructure, id: string): Promise<Route | null> {
  return (
    (await infra.pool.query('SELECT document FROM routes WHERE id=$1', [id])).rows[0]?.document ??
    null
  );
}
export async function updateRoute(
  infra: RouteInfrastructure,
  actor: RouteActor,
  id: string,
  body: unknown,
  fence?: RouteFence,
): Promise<Route> {
  const value = UpdateRouteSchema.parse(body);
  return routeWrite(
    infra,
    actor,
    value.operationId,
    { kind: 'update', id, value },
    'route.update',
    async (client) => {
      const row = (await client.query('SELECT document FROM routes WHERE id=$1 FOR UPDATE', [id]))
        .rows[0];
      if (!row) throw new RouteStoreError('route_not_found', 404);
      const old = row.document as Route;
      if (old.revision !== value.expectedRevision) throw new RouteStoreError('revision_conflict');
      const { operationId: _operationId, expectedRevision: _expectedRevision, ...patch } = value;
      const next = {
        ...old,
        ...patch,
        revision: old.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      if (value.geometry) {
        next.lengthMeters = routeDistance(value.geometry.coordinates);
        next.generatedBy = 'manual';
        next.planId = null;
      }
      return persist(client, actor, next);
    },
    fence,
  );
}
export async function archiveRoute(
  infra: RouteInfrastructure,
  actor: RouteActor,
  id: string,
  body: { operationId: string; expectedRevision: number },
  fence?: RouteFence,
) {
  return updateRoute(infra, actor, id, { ...body, status: 'archived' }, fence);
}
export async function copyRoute(
  infra: RouteInfrastructure,
  actor: RouteActor,
  id: string,
  body: { operationId: string; expectedRevision: number; name: string },
  fence?: RouteFence,
) {
  return routeWrite(
    infra,
    actor,
    body.operationId,
    { kind: 'copy', id, body },
    'route.copy',
    async (client) => {
      const row = (await client.query('SELECT document FROM routes WHERE id=$1 FOR SHARE', [id]))
        .rows[0];
      if (!row) throw new RouteStoreError('route_not_found', 404);
      const old = row.document as Route;
      if (old.revision !== body.expectedRevision) throw new RouteStoreError('revision_conflict');
      const now = new Date().toISOString();
      return persist(client, actor, {
        ...old,
        id: randomUUID(),
        name: body.name,
        status: 'draft',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      });
    },
    fence,
  );
}
export async function routeHistory(infra: RouteInfrastructure, id: string) {
  return (
    await infra.pool.query(
      'SELECT document FROM route_revisions WHERE route_id=$1 ORDER BY revision DESC',
      [id],
    )
  ).rows.map((r) => r.document as Route);
}
export async function listRoutes(infra: RouteInfrastructure, body: unknown = {}) {
  const query = CircleRouteQuerySchema.parse(body);
  const circle = routeQueryCircle(query);
  const params: unknown[] = [];
  const filters: string[] = [];
  if (query.status) {
    params.push(query.status);
    filters.push(`document->>'status'=$${params.length}`);
  }
  if (query.search) {
    params.push(
      `%${query.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
    );
    filters.push(`document->>'name' ILIKE $${params.length}`);
  }
  if (circle) {
    params.push(circle.center[0], circle.center[1], circle.radiusMeters);
    filters.push(
      `ST_DWithin(geog,ST_SetSRID(ST_MakePoint($${params.length - 2},$${params.length - 1}),4326)::geography,$${params.length})`,
    );
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const total = Number(
      (await client.query(`SELECT count(*) AS total FROM routes ${where}`, params)).rows[0].total,
    );
    const rows = await client.query(
      `SELECT document FROM routes ${where} ORDER BY created_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, query.limit, query.offset],
    );
    await client.query('COMMIT');
    return { items: rows.rows.map((r) => r.document as Route), total };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function exportRoute(infra: RouteInfrastructure, id: string) {
  const route = await getRoute(infra, id);
  if (!route) throw new RouteStoreError('route_not_found', 404);
  return {
    type: 'Feature' as const,
    geometry: route.geometry,
    properties: {
      name: route.name,
      mmsis: route.mmsis,
      waypoints: route.waypoints,
      revision: route.revision,
    },
  };
}
export async function importRoute(
  infra: RouteInfrastructure,
  actor: RouteActor,
  body: unknown,
  fence?: RouteFence,
) {
  const v = ImportRouteSchema.parse(body);
  const coordinates = v.geojson.geometry.coordinates;
  return routeWrite(
    infra,
    actor,
    v.operationId,
    { kind: 'import', v },
    'route.import',
    (client) => {
      const now = new Date().toISOString();
      return persist(client, actor, {
        id: randomUUID(),
        revision: 1,
        name: v.name,
        status: 'draft',
        mmsis: [],
        waypoints: [coordinates[0]!, coordinates.at(-1)!],
        geometry: v.geojson.geometry,
        lengthMeters: routeDistance(coordinates),
        generatedBy: 'import',
        planId: null,
        createdAt: now,
        updatedAt: now,
      });
    },
    fence,
  );
}
export async function listRouteRestrictions(infra: RouteInfrastructure) {
  return (
    await infra.pool.query(
      'SELECT DISTINCT ON(id) id,revision,version,name,geometry,valid_from AS "validFrom",valid_until AS "validUntil",enabled FROM route_restrictions ORDER BY id,revision DESC',
    )
  ).rows;
}
export async function saveRouteRestriction(
  infra: RouteInfrastructure,
  actor: RouteActor,
  id: string,
  body: unknown,
  fence?: RouteFence,
) {
  const v = RestrictionSchema.parse(body);
  return routeWrite(
    infra,
    actor,
    v.operationId,
    { kind: 'restriction', id, v },
    'route.restriction',
    async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('route-restrictions'))");
      const old = (
        await client.query(
          'SELECT revision FROM route_restrictions WHERE id=$1 ORDER BY revision DESC LIMIT 1',
          [id],
        )
      ).rows[0];
      if (Number(old?.revision ?? 0) !== v.expectedRevision)
        throw new RouteStoreError('revision_conflict');
      const valid = (
        await client.query('SELECT ST_IsValid(ST_GeomFromGeoJSON($1)) AS valid', [
          JSON.stringify(v.geometry),
        ])
      ).rows[0];
      if (!valid.valid) throw new RouteStoreError('invalid_polygon', 400);
      const result = await client.query(
        `INSERT INTO route_restrictions(id,revision,name,geometry,geog,valid_from,valid_until,enabled) VALUES($1,$2,$3,$4,ST_GeomFromGeoJSON($4::jsonb)::geography,$5,$6,$7) RETURNING id,revision,version,name,geometry,valid_from AS "validFrom",valid_until AS "validUntil",enabled`,
        [
          id,
          v.expectedRevision + 1,
          v.name,
          JSON.stringify(v.geometry),
          v.validFrom,
          v.validUntil,
          v.enabled,
        ],
      );
      return result.rows[0];
    },
    fence,
  );
}
export async function createRoutePlan(
  infra: RouteInfrastructure,
  actor: RouteActor,
  body: unknown,
  fence?: RouteFence,
): Promise<RoutePlan> {
  if (process.env.ROUTE_PLANNING_ENABLED === 'false')
    throw new RouteStoreError('planning_disabled', 503);
  const v = PlanRouteSchema.parse(body);
  return routeWrite(
    infra,
    actor,
    v.operationId,
    { kind: 'plan', v },
    'route.plan',
    async (client) => {
      const dataset =
        (await client.query('SELECT version FROM route_datasets WHERE active')).rows[0]?.version ??
        null;
      const restriction = Number(
        (await client.query('SELECT COALESCE(max(version),0) AS version FROM route_restrictions'))
          .rows[0].version,
      );
      const row = (
        await client.query(
          `INSERT INTO route_plans(id,user_id,status,input,dataset_version,restriction_version) VALUES($1,$2,'queued',$3,$4,$5) RETURNING *`,
          [randomUUID(), actor.id, JSON.stringify(v), dataset, restriction],
        )
      ).rows[0];
      return mapPlan(row, false);
    },
    fence,
  );
}
function mapPlan(row: Record<string, unknown>, stale: boolean): RoutePlan {
  return {
    id: String(row.id),
    status: row.status as RoutePlan['status'],
    input: row.input as RoutePlan['input'],
    datasetVersion: row.dataset_version as string | null,
    restrictionVersion: Number(row.restriction_version),
    result: (row.result ?? null) as RoutePlan['result'],
    error: row.error as string | null,
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
    stale,
  };
}
export async function getRoutePlan(
  infra: RouteInfrastructure,
  id: string,
): Promise<RoutePlan | null> {
  const row = (
    await infra.pool.query(
      `SELECT p.*, (p.dataset_version IS DISTINCT FROM (SELECT version FROM route_datasets WHERE active) OR p.restriction_version <> (SELECT COALESCE(max(version),0) FROM route_restrictions)) AS stale FROM route_plans p WHERE id=$1`,
      [id],
    )
  ).rows[0];
  return row ? mapPlan(row, row.stale) : null;
}
export async function cancelRoutePlan(
  infra: RouteInfrastructure,
  actor: RouteActor,
  id: string,
  body: { operationId: string },
  fence?: RouteFence,
) {
  return routeWrite(
    infra,
    actor,
    body.operationId,
    { kind: 'cancel', id, body },
    'route.plan.cancel',
    async (client) => {
      await client.query(
        "UPDATE route_plans SET status='cancelled',updated_at=now() WHERE id=$1 AND status IN ('queued','running')",
        [id],
      );
      const row = (await client.query('SELECT * FROM route_plans WHERE id=$1', [id])).rows[0];
      if (!row) throw new RouteStoreError('plan_not_found', 404);
      return mapPlan(row, false);
    },
    fence,
  );
}
