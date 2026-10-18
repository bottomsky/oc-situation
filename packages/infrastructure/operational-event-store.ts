import { logger } from './clients';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Infrastructure } from './clients';
import {
  OperationalEventFieldsSchema,
  CreateOperationalEventSchema,
  UpdateOperationalEventSchema,
  MergeOperationalEventsSchema,
  OperationalEventQuerySchema,
  type OperationalEvent,
  type OperationalEventQuery,
  type CreateOperationalEvent,
  type UpdateOperationalEvent,
  type MergeOperationalEvents,
  type OperationalEventSource,
} from '../contracts/operational-events';
import { effectiveEventFields, sourceSnapshotKey } from '../domain/operational-event';
import { validateSpatialGeometry } from './intelligence-store';

export class OperationalEventError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
  }
}
export interface OperationalEventActor {
  id: string;
  role: string;
}
export interface OperationalEventWriteOptions {
  beforeWrite?: (client: PoolClient) => Promise<void>;
}
type DB = Pick<PoolClient, 'query'>;
export async function getOperationalEvent(
  infra: Pick<Infrastructure, 'pool'>,
  id: string,
  resolveMerged = true,
): Promise<OperationalEvent | undefined> {
  return readEvent(infra.pool, id, resolveMerged);
}
async function readEvent(
  db: DB,
  id: string,
  resolve = true,
  lock = false,
): Promise<OperationalEvent | undefined> {
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const value = (
      await db.query<{ data: OperationalEvent }>(
        `SELECT data FROM operational_events WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      )
    ).rows[0]?.data;
    if (!value || !resolve || !value.mergedInto) return value;
    id = value.mergedInto;
  }
  throw new OperationalEventError('Event merge cycle');
}
export async function persistOperationalEvent(db: DB, value: OperationalEvent) {
  await validateSpatialGeometry(db, value.geometry);
  await db.query(
    `INSERT INTO operational_events(id,revision,status,data,geom) VALUES($1,$2,$3,$4::jsonb,CASE WHEN $5::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($5),4326) END)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status,data=excluded.data,geom=excluded.geom,updated_at=now()`,
    [
      value.id,
      value.revision,
      value.status,
      JSON.stringify(value),
      value.geometry ? JSON.stringify(value.geometry) : null,
    ],
  );
  await db.query(
    'INSERT INTO operational_event_revisions(event_id,revision,data) VALUES($1,$2,$3::jsonb)',
    [value.id, value.revision, JSON.stringify(value)],
  );
}
async function write(
  infra: Infrastructure,
  actor: OperationalEventActor,
  operationId: string,
  input: unknown,
  options: OperationalEventWriteOptions,
  action: string,
  execute: (c: PoolClient) => Promise<OperationalEvent>,
) {
  const c = await infra.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `operational-event-op:${actor.id}:${operationId}`,
    ]);
    const fingerprint = sourceSnapshotKey({ action, input });
    const receipt = (
      await c.query(
        'SELECT fingerprint,result FROM operational_event_operations WHERE actor_id=$1 AND operation_id=$2',
        [actor.id, operationId],
      )
    ).rows[0];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new OperationalEventError('Operation id reused with different input');
      await c.query('COMMIT');
      logger.info(
        { event: 'business_operation', kind: 'event', idempotent_hit: true },
        'Recovered committed business operation',
      );
      return receipt.result as OperationalEvent;
    }
    const user = (
      await c.query('SELECT role,disabled FROM users WHERE id=$1 FOR SHARE', [actor.id])
    ).rows[0];
    if (!user || user.disabled || !['operator', 'admin'].includes(user.role))
      throw new OperationalEventError('Operator permission required', 403);
    await options.beforeWrite?.(c);
    const result = await execute(c);
    await options.beforeWrite?.(c);
    await c.query(
      'INSERT INTO audit(id,user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [
        randomUUID(),
        actor.id,
        action,
        'operational-event',
        result.id,
        JSON.stringify({ operationId, revision: result.revision }),
      ],
    );
    await c.query(
      'INSERT INTO operational_event_operations(actor_id,operation_id,fingerprint,result) VALUES($1,$2,$3,$4::jsonb)',
      [actor.id, operationId, fingerprint, JSON.stringify(result)],
    );
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
export async function createOperationalEvent(
  infra: Infrastructure,
  raw: CreateOperationalEvent,
  actor: OperationalEventActor,
  options: OperationalEventWriteOptions = {},
) {
  const input = CreateOperationalEventSchema.parse(raw);
  return write(infra, actor, input.operationId, input, options, 'event.create', async (c) => {
    const fields = OperationalEventFieldsSchema.parse(inputFields(input));
    const timestamp = new Date().toISOString();
    const value: OperationalEvent = {
      ...fields,
      id: randomUUID(),
      revision: 1,
      status: 'active',
      primarySourceKey: null,
      sourceSuggestions: {},
      overrides: fields,
      mergedInto: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persistOperationalEvent(c, value);
    return value;
  });
}
function inputFields(input: CreateOperationalEvent) {
  const { operationId: _, ...fields } = input;
  return fields;
}
export async function updateOperationalEvent(
  infra: Infrastructure,
  id: string,
  raw: UpdateOperationalEvent,
  actor: OperationalEventActor,
  options: OperationalEventWriteOptions = {},
) {
  const input = UpdateOperationalEventSchema.parse(raw);
  return write(
    infra,
    actor,
    input.operationId,
    { id, ...input },
    options,
    'event.update',
    async (c) => {
      const current = await readEvent(c, id, false, true);
      if (!current) throw new OperationalEventError('Event not found', 404);
      if (current.revision !== input.expectedRevision || current.mergedInto)
        throw new OperationalEventError('Event revision conflict');
      const overrides = { ...current.overrides, ...input.fields };
      for (const key of input.releaseOverrides) {
        if (!(key in current.sourceSuggestions))
          throw new OperationalEventError('Released field requires a source suggestion', 400);
        delete overrides[key];
      }
      const fields = OperationalEventFieldsSchema.parse(
        effectiveEventFields(current.sourceSuggestions, overrides),
      );
      const value = {
        ...current,
        ...fields,
        overrides,
        status: input.status ?? current.status,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      };
      await persistOperationalEvent(c, value);
      return value;
    },
  );
}
export async function mergeOperationalEvents(
  infra: Infrastructure,
  id: string,
  raw: MergeOperationalEvents,
  actor: OperationalEventActor,
  options: OperationalEventWriteOptions = {},
) {
  const input = MergeOperationalEventsSchema.parse(raw);
  return write(
    infra,
    actor,
    input.operationId,
    { id, ...input },
    options,
    'event.merge',
    async (c) => {
      if (id === input.targetId)
        throw new OperationalEventError('Cannot merge an event into itself');
      // Lock in UUID order, also serializing consumers through the same rows.
      for (const key of [id, input.targetId].sort())
        await c.query('SELECT id FROM operational_events WHERE id=$1 FOR UPDATE', [key]);
      const source = await readEvent(c, id, false),
        target = await readEvent(c, input.targetId, false);
      if (!source || !target) throw new OperationalEventError('Event not found', 404);
      if (
        source.mergedInto ||
        target.mergedInto ||
        source.revision !== input.expectedRevision ||
        target.revision !== input.targetExpectedRevision
      )
        throw new OperationalEventError('Event revision conflict');
      const primary = (
        await c.query<{ data: OperationalEventSource }>(
          'SELECT data FROM operational_event_sources WHERE source_key=$1 AND event_id=ANY($2::uuid[])',
          [input.primarySourceKey, [id, target.id]],
        )
      ).rows[0]?.data;
      if (!primary)
        throw new OperationalEventError('Primary source must belong to a merged event', 400);
      await c.query(
        "UPDATE operational_event_sources SET event_id=$1::uuid,data=jsonb_set(data,'{eventId}',to_jsonb(($1::uuid)::text)) WHERE event_id=$2::uuid",
        [target.id, id],
      );
      const timestamp = new Date().toISOString();
      const merged = {
        ...source,
        status: 'merged' as const,
        mergedInto: target.id,
        revision: source.revision + 1,
        updatedAt: timestamp,
      };
      const result = {
        ...target,
        ...effectiveEventFields(primary.fields, target.overrides),
        primarySourceKey: input.primarySourceKey,
        sourceSuggestions: primary.fields,
        revision: target.revision + 1,
        updatedAt: timestamp,
      };
      await persistOperationalEvent(c, merged);
      await persistOperationalEvent(c, result);
      return result;
    },
  );
}
export async function listOperationalEvents(infra: Infrastructure, raw: OperationalEventQuery) {
  const q = OperationalEventQuerySchema.parse(raw),
    args: unknown[] = [];
  const add = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  const clauses: string[] = [];
  if (q.keyword)
    clauses.push(
      `(data->>'title' ILIKE ${add(`%${q.keyword}%`)} OR data->>'summary' ILIKE $${args.length})`,
    );
  if (q.status) clauses.push(`status=${add(q.status)}`);
  if (q.circle)
    clauses.push(
      `ST_DWithin(geom::geography,ST_SetSRID(ST_MakePoint(${add(q.circle.center[0])},${add(q.circle.center[1])}),4326)::geography,${add(q.circle.radiusMeters)})`,
    );
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // One snapshot keeps total consistent with the requested page even during synchronization.
  const result = await infra.pool.query<{ items: OperationalEvent[]; total: number }>(
    `WITH filtered AS MATERIALIZED (SELECT id,data FROM operational_events ${where}) SELECT (SELECT count(*)::int FROM filtered) total, COALESCE((SELECT jsonb_agg(page.data) FROM (SELECT data FROM filtered ORDER BY id LIMIT ${add(q.limit)} OFFSET ${add(q.offset)}) page),'[]'::jsonb) items`,
    args,
  );
  return result.rows[0]!;
}
export async function getOperationalEventHistory(infra: Infrastructure, id: string) {
  return (
    await infra.pool.query(
      'SELECT data FROM operational_event_revisions WHERE event_id=$1 ORDER BY revision DESC',
      [id],
    )
  ).rows.map((row) => row.data as OperationalEvent);
}
export async function getOperationalEventSources(infra: Infrastructure, id: string) {
  const target = await getOperationalEvent(infra, id);
  if (!target) return [];
  return (
    await infra.pool.query(
      'SELECT data FROM operational_event_sources WHERE event_id=$1 ORDER BY source_key',
      [target.id],
    )
  ).rows.map((row) => row.data as OperationalEventSource);
}
export async function getOperationalEventSourceHistory(infra: Infrastructure, key: string) {
  return (
    await infra.pool.query(
      'SELECT revision,snapshot,created_at FROM operational_event_source_revisions WHERE source_key=$1 ORDER BY revision DESC',
      [key],
    )
  ).rows;
}
