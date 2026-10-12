import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Infrastructure } from './clients';
import type { IntelligenceEvent } from '../contracts/intelligence';
import {
  GeoObjectInputSchema,
  RelationInputSchema,
  type GeoObjectInput,
  type IntelligenceEventQuery,
  type IntelligenceGeoObject,
  type IntelligenceRelationInput,
  type IntelligenceRelation,
  type IntelligencePlot,
} from '../contracts/intelligence-spatial';
type DB = Pick<PoolClient, 'query'>;
export async function getLatestIntelligenceEvent(
  infra: Infrastructure,
  sourceId: string,
  externalId: string,
) {
  return (
    await infra.pool.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 ORDER BY version DESC LIMIT 1',
      [sourceId, externalId],
    )
  ).rows[0]?.event;
}
export async function saveGeoObject(
  db: DB,
  value: GeoObjectInput,
  validFrom = new Date().toISOString(),
): Promise<IntelligenceGeoObject> {
  const input = GeoObjectInputSchema.parse(value);
  await validateSpatialGeometry(db, input.geometry);
  let id = input.id;
  if (input.kind === 'vessel') {
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `vessel:${input.mmsi}`,
    ]);
    const rows = await db.query(
      "SELECT vessel_id FROM vessel_identifiers WHERE identifier_type='mmsi' AND identifier=$1 AND valid_to IS NULL",
      [input.mmsi],
    );
    if (rows.rows[0]) {
      if (id && id !== rows.rows[0].vessel_id)
        throw new IntelligenceValidationError('Vessel id must match stable AIS identity');
      id = rows.rows[0].vessel_id;
    } else {
      id = id ?? randomUUID();
      await db.query('INSERT INTO vessel_objects(id) VALUES($1)', [id]);
      await db.query(
        'INSERT INTO vessel_identifiers(vessel_id,identifier,valid_from) VALUES($1,$2,$3)',
        [id, input.mmsi, validFrom],
      );
    }
  }
  id =
    id ??
    createHash('sha256')
      .update(JSON.stringify([input.kind, input.name, input.geometry ?? null]))
      .digest('hex');
  const object = { ...input, id, updatedAt: new Date().toISOString() };
  await db.query(
    'INSERT INTO intelligence_objects(id,kind,name,data,geom) VALUES($1,$2,$3,$4::jsonb,CASE WHEN $5::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($5),4326) END) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,data=excluded.data,geom=excluded.geom,updated_at=now()',
    [
      id,
      input.kind,
      input.name,
      JSON.stringify(object),
      input.geometry ? JSON.stringify(input.geometry) : null,
    ],
  );
  return object;
}
export async function writeGeoObject(infra: Infrastructure, value: GeoObjectInput) {
  const c = await infra.pool.connect();
  try {
    await c.query('BEGIN');
    const o = await saveGeoObject(c, value);
    await c.query('COMMIT');
    return o;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function saveRelation(
  db: DB,
  eventId: string,
  value: IntelligenceRelationInput,
  actor?: string,
  id: string = randomUUID(),
): Promise<IntelligenceRelation> {
  const input = RelationInputSchema.parse(value);
  await validateSpatialGeometry(db, input.geometry);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`relation:${id}`]);
  const event = (
    await db.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE id=$1',
      [eventId],
    )
  ).rows[0]?.event;
  if (!event) throw new IntelligenceValidationError('Event not found');
  if (input.paragraphIds.some((p) => !event.paragraphs.some((e) => e.id === p)))
    throw new IntelligenceValidationError('Paragraph is not part of this evidence');
  if (
    input.objectId &&
    !(await db.query('SELECT id FROM intelligence_objects WHERE id=$1', [input.objectId])).rowCount
  )
    throw new IntelligenceValidationError('Object not found');
  const latest = (
    await db.query(
      'SELECT revision FROM intelligence_relations WHERE id=$1 ORDER BY revision DESC LIMIT 1',
      [id],
    )
  ).rows[0];
  const previous = (
    await db.query<{ data: IntelligenceRelation }>(
      'SELECT data FROM intelligence_relations WHERE id=$1 ORDER BY revision DESC LIMIT 1',
      [id],
    )
  ).rows[0]?.data;
  const objectSnapshot =
    previous?.objectId === input.objectId && previous?.objectSnapshot
      ? previous.objectSnapshot
      : input.objectId
        ? (
            await db.query<{ data: IntelligenceGeoObject }>(
              'SELECT data FROM intelligence_objects WHERE id=$1',
              [input.objectId],
            )
          ).rows[0]?.data
        : undefined;
  const relation: IntelligenceRelation = {
    ...input,
    ...(objectSnapshot ? { objectSnapshot } : {}),
    id,
    eventId,
    revision: (latest?.revision ?? 0) + 1,
    recordedAt: new Date().toISOString(),
    ...(actor
      ? { createdBy: actor, ...(input.reviewStatus !== 'candidate' ? { reviewedBy: actor } : {}) }
      : {}),
  };
  await db.query(
    'INSERT INTO intelligence_relations(id,event_id,revision,data,geom) VALUES($1,$2,$3,$4::jsonb,CASE WHEN $5::text IS NULL THEN NULL ELSE ST_SetSRID(ST_GeomFromGeoJSON($5),4326) END)',
    [
      id,
      eventId,
      relation.revision,
      JSON.stringify(relation),
      input.geometry
        ? JSON.stringify(input.geometry)
        : objectSnapshot?.geometry
          ? JSON.stringify(objectSnapshot.geometry)
          : null,
    ],
  );
  return relation;
}
export async function writeRelation(
  infra: Infrastructure,
  eventId: string,
  value: IntelligenceRelationInput,
  actor: string,
  id?: string,
) {
  const c = await infra.pool.connect();
  try {
    await c.query('BEGIN');
    const r = await saveRelation(c, eventId, value, actor, id);
    await suggestSpatialRelations(c, eventId, r);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function projectIntelligenceRelations(db: DB, event: IntelligenceEvent) {
  const initialRelations: IntelligenceRelation[] = [];
  for (const r of event.relations ?? []) {
    const relation = await saveRelation(
      db,
      event.id,
      r,
      undefined,
      createHash('sha256')
        .update(JSON.stringify([event.id, r]))
        .digest('hex'),
    );
    initialRelations.push(relation);
  }
  for (const relation of initialRelations) await suggestSpatialRelations(db, event.id, relation);
  {
    if (event.bbox && !(event.relations ?? []).some((r) => !!r.geometry)) {
      const [w, s, e, n] = event.bbox;
      const ring = (a: number, b: number) =>
        [
          [a, s],
          [b, s],
          [b, n],
          [a, n],
          [a, s],
        ] as [number, number][];
      await saveRelation(
        db,
        event.id,
        {
          kind: 'applies-to',
          geometry:
            w <= e
              ? { type: 'Polygon', coordinates: [ring(w, e)] }
              : { type: 'MultiPolygon', coordinates: [[ring(w, 180)], [ring(-180, e)]] },
          basis: '旧公告区域框兼容转换',
          paragraphIds: [],
          reviewStatus: event.reviewStatus ?? 'confirmed',
          origin: 'legacy',
        },
        undefined,
        `${event.id}:legacy:bbox`,
      );
    }
    for (const mmsi of event.mmsis) {
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`vessel:${mmsi}`]);
      const existing = (
        await db.query<{ data: IntelligenceGeoObject }>(
          "SELECT o.data FROM vessel_identifiers v JOIN intelligence_objects o ON o.id=v.vessel_id::text WHERE v.identifier_type='mmsi' AND v.identifier=$1 AND v.valid_to IS NULL",
          [mmsi],
        )
      ).rows[0]?.data;
      const o =
        existing ??
        (await saveGeoObject(
          db,
          {
            kind: 'vessel',
            name: mmsi,
            mmsi,
            aliases: [],
            metadata: { identityBasis: '情报业务时间登记' },
          },
          event.effectiveFrom,
        ));
      if ((event.relations ?? []).some((r) => r.kind === 'involves' && r.objectId === o.id))
        continue;
      await saveRelation(
        db,
        event.id,
        {
          kind: 'involves',
          objectId: o.id,
          basis: '旧公告MMSI兼容转换',
          paragraphIds: [],
          reviewStatus: event.reviewStatus ?? 'confirmed',
          origin: 'legacy',
        },
        undefined,
        `${event.id}:legacy:mmsi:${mmsi}`,
      );
    }
  }
}
export async function queryIntelligenceEvents(infra: Infrastructure, q: IntelligenceEventQuery) {
  const params: unknown[] = [];
  const add = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const conditions: string[] = [];
  if (q.latest)
    conditions.push(
      'e.version=(SELECT max(x.version) FROM intelligence_events x WHERE x.source_id=e.source_id AND x.external_id=e.external_id)',
    );
  if (q.cursor) conditions.push(`e.id>${add(q.cursor)}`);
  if (q.keyword)
    conditions.push(
      `(e.event->>'title' ILIKE ${add('%' + q.keyword + '%')} OR e.event->>'summary' ILIKE $${params.length} OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.event->'paragraphs','[]'::jsonb)) p WHERE p->>'text' ILIKE $${params.length}))`,
    );
  if (q.sourceId) conditions.push(`e.source_id=${add(q.sourceId)}`);
  if (q.category) conditions.push(`e.event->>'category'=${add(q.category)}`);
  if (q.reviewStatus)
    conditions.push(
      `COALESCE(r.review_status,e.event->>'reviewStatus','confirmed')=${add(q.reviewStatus)}`,
    );
  if (q.status) conditions.push(`e.event->>'status'=${add(q.status)}`);
  if (q.from)
    conditions.push(`(e.effective_to IS NULL OR e.effective_to>=${add(q.from)}::timestamptz)`);
  if (q.to) conditions.push(`e.effective_from<=${add(q.to)}::timestamptz`);
  if (q.objectId || q.bbox) {
    let clause = '';
    if (q.objectId) clause = `AND rel.data->>'objectId'=${add(q.objectId)}`;
    if (q.bbox) {
      const [w, s, e, n] = q.bbox;
      const pw = add(w),
        ps = add(s),
        pe = add(e),
        pn = add(n);
      const envelope =
        w <= e
          ? `ST_MakeEnvelope(${pw},${ps},${pe},${pn},4326)`
          : `ST_Collect(ST_MakeEnvelope(${pw},${ps},180,${pn},4326),ST_MakeEnvelope(-180,${ps},${pe},${pn},4326))`;
      clause += ` AND (ST_Intersects(COALESCE(rel.geom,o.geom),${envelope}) OR ST_Intersects(vp.location::geometry,${envelope}))`;
    }
    conditions.push(
      `EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(id) * FROM intelligence_relations ORDER BY id,revision DESC) rel LEFT JOIN intelligence_objects o ON o.id=rel.data->>'objectId' LEFT JOIN positions_latest vp ON o.kind='vessel' AND vp.mmsi=o.data->>'mmsi' WHERE rel.event_id=e.id AND rel.data->>'reviewStatus'<>'rejected' ${clause})`,
    );
  }
  const limit = add(q.limit + 1);
  const rows = await infra.pool.query<{ id: string; event: IntelligenceEvent }>(
    `SELECT e.id,e.event||jsonb_build_object('reviewStatus',COALESCE(r.review_status,e.event->>'reviewStatus','confirmed')) event FROM intelligence_events e LEFT JOIN LATERAL(SELECT review_status FROM intelligence_reviews WHERE event_id=e.id ORDER BY id DESC LIMIT 1) r ON true ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY e.id LIMIT ${limit}`,
    params,
  );
  return {
    items: rows.rows.slice(0, q.limit).map((r) => r.event),
    nextCursor: rows.rows.length > q.limit ? rows.rows[q.limit - 1]!.id : null,
  };
}
export async function intelligenceDetail(infra: Infrastructure, id: string) {
  const row = (
    await infra.pool.query<{ event: IntelligenceEvent }>(
      "SELECT e.event||jsonb_build_object('reviewStatus',COALESCE((SELECT review_status FROM intelligence_reviews WHERE event_id=e.id ORDER BY id DESC LIMIT 1),e.event->>'reviewStatus','confirmed')) event FROM intelligence_events e WHERE e.id=$1",
      [id],
    )
  ).rows[0];
  if (!row) return null;
  const relations = (
    await infra.pool.query<{ data: IntelligenceRelation }>(
      'SELECT DISTINCT ON(id) data FROM intelligence_relations WHERE event_id=$1 ORDER BY id,revision DESC',
      [id],
    )
  ).rows.map((r) => r.data);
  const history = (
    await infra.pool.query(
      'SELECT actor,review_status AS "reviewStatus",recorded_at AS "recordedAt" FROM intelligence_reviews WHERE event_id=$1 ORDER BY id',
      [id],
    )
  ).rows;
  const revisions = (
    await infra.pool.query(
      'SELECT data FROM intelligence_relations WHERE event_id=$1 ORDER BY recorded_at,revision',
      [id],
    )
  ).rows.map((r) => r.data);
  const versions = (
    await infra.pool.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 AND id<>$3 ORDER BY version',
      [row.event.sourceId, row.event.externalId, id],
    )
  ).rows.map(({ event }) => ({
    kind: 'event-version',
    id: event.id,
    eventId: event.id,
    version: event.version,
    title: event.title,
    status: event.status,
    recordedAt: event.recordedAt,
    supersedesId: event.supersedesId,
  }));
  return { event: row.event, relations, history: [...history, ...revisions, ...versions] };
}
export async function plotIntelligence(
  infra: Infrastructure,
  eventIds: string[],
  includeCandidates: boolean,
): Promise<IntelligencePlot> {
  const ids = [...new Set(eventIds)];
  const result: IntelligencePlot = { type: 'FeatureCollection', features: [], items: [] };
  const events = (
    await infra.pool.query<{ event: IntelligenceEvent; latest: number }>(
      "SELECT e.event||jsonb_build_object('reviewStatus',COALESCE((SELECT review_status FROM intelligence_reviews WHERE event_id=e.id ORDER BY id DESC LIMIT 1),e.event->>'reviewStatus','confirmed')) event,(SELECT max(version) FROM intelligence_events x WHERE x.source_id=e.source_id AND x.external_id=e.external_id) latest FROM intelligence_events e WHERE e.id=ANY($1::text[])",
      [ids],
    )
  ).rows;
  const relations = (
    await infra.pool.query<{ data: IntelligenceRelation }>(
      'SELECT DISTINCT ON(id) data FROM intelligence_relations WHERE event_id=ANY($1::text[]) ORDER BY id,revision DESC',
      [ids],
    )
  ).rows.map((r) => r.data);
  const objectIds = [...new Set(relations.flatMap((r) => (r.objectId ? [r.objectId] : [])))];
  const objects = (
    await infra.pool.query<{
      data: IntelligenceGeoObject;
      longitude: number | null;
      latitude: number | null;
      observed_at: Date | null;
      synthetic: boolean;
    }>(
      "SELECT o.data,p.longitude,p.latitude,p.observed_at,COALESCE(p.observation->'quality' ? 'synthetic',false) synthetic FROM intelligence_objects o LEFT JOIN positions_latest p ON o.kind='vessel' AND p.mmsi=o.data->>'mmsi' WHERE o.id=ANY($1::text[])",
      [objectIds],
    )
  ).rows;
  const byObject = new Map(objects.map((o) => [o.data.id, o]));
  const byEvent = new Map(events.map((e) => [e.event.id, e]));
  let bytes = 0;
  for (const id of ids) {
    const row = byEvent.get(id);
    if (!row) {
      result.items.push({ eventId: id, title: id, featureCount: 0, reason: '情报版本不存在' });
      continue;
    }
    const event = row.event;
    const before = result.features.length;
    if (event.reviewStatus !== 'rejected')
      for (const r of relations.filter((r) => r.eventId === id)) {
        if (r.reviewStatus === 'rejected' || (!includeCandidates && r.reviewStatus !== 'confirmed'))
          continue;
        const object = r.objectId ? byObject.get(r.objectId) : undefined;
        const validFrom = r.effectiveFrom ?? event.effectiveFrom;
        const validTo = r.effectiveTo === undefined ? event.effectiveTo : r.effectiveTo;
        const expired = !!validTo && Date.parse(validTo) < Date.now();
        const future = Date.parse(validFrom) > Date.now();
        const historical = event.version < row.latest || expired || event.status === 'withdrawn';
        const raw = event.raw as Record<string, unknown>;
        const effectiveTimePending =
          !!raw &&
          (raw.requiresEffectiveTimeReview === true || raw.requiresOccurrenceTimeReview === true) &&
          raw.manualTimeConfirmed !== true;
        const properties = {
          eventSynthetic: raw?.synthetic === true,
          synthetic: raw?.synthetic === true,
          effectiveTimePending,
          sourceObserved: effectiveTimePending,
          eventId: id,
          eventVersion: event.version,
          eventReviewStatus: event.reviewStatus ?? 'confirmed',
          relationId: r.id,
          relationRevision: r.revision,
          ...(r.objectId ? { objectId: r.objectId } : {}),
          ...(object ? { objectName: object.data.name } : {}),
          kind: r.kind,
          reviewStatus: r.reviewStatus,
          origin: r.origin,
          basis: r.basis,
          observedAt: effectiveTimePending ? event.publishedAt : validFrom,
          status:
            event.status === 'withdrawn'
              ? 'withdrawn'
              : expired
                ? 'expired'
                : future
                  ? 'future'
                  : event.status,
          title: event.title,
          historical,
          validFrom,
          validTo,
        };
        const geometry = r.geometry ?? r.objectSnapshot?.geometry ?? object?.data.geometry;
        if (geometry) {
          bytes += JSON.stringify(geometry).length;
          if (bytes > 1048576)
            throw new IntelligenceValidationError('Plot geometry total exceeds 1 MiB');
          result.features.push({
            type: 'Feature',
            id: r.id,
            geometry,
            properties: { ...properties, positionSource: r.geometry ? 'relation' : 'object' },
          });
        }
        if (
          object?.longitude !== null &&
          object?.longitude !== undefined &&
          object.latitude !== null &&
          object.observed_at
        ) {
          result.features.push({
            type: 'Feature',
            id: r.id + ':ais-latest',
            geometry: { type: 'Point', coordinates: [object.longitude, object.latitude] },
            properties: {
              ...properties,
              observedAt: object.observed_at.toISOString(),
              positionSource: 'ais-latest',
              synthetic: object.synthetic || raw?.synthetic === true,
              historical: false,
            },
          });
        }
      }
    const count = result.features.length - before;
    result.items.push({
      eventId: id,
      title: event.title,
      featureCount: count,
      ...(!count
        ? {
            reason:
              event.reviewStatus === 'rejected' ? '情报审核已驳回' : '暂无符合审核条件的空间证据',
          }
        : {}),
    });
  }
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 33554432)
    throw new IntelligenceValidationError('Plot payload exceeds 32 MiB');
  return result;
}
export class IntelligenceValidationError extends Error {}
export async function validateSpatialGeometry(db: DB, geometry: unknown) {
  if (!geometry) return;
  const row = (
    await db.query<{ valid: boolean }>(
      'SELECT ST_IsValid(ST_SetSRID(ST_GeomFromGeoJSON($1),4326)) valid',
      [JSON.stringify(geometry)],
    )
  ).rows[0];
  if (!row?.valid) throw new IntelligenceValidationError('Geometry topology is invalid');
}
export async function importGeoObjects(infra: Infrastructure, values: GeoObjectInput[]) {
  const c = await infra.pool.connect();
  try {
    await c.query('BEGIN');
    const items = [];
    for (const value of values) items.push(await saveGeoObject(c, value));
    await c.query('COMMIT');
    return { items };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
export async function reviewIntelligenceEvent(
  infra: Infrastructure,
  eventId: string,
  reviewStatus: string,
  actor: string,
) {
  const c = await infra.pool.connect();
  try {
    await c.query('BEGIN');
    const event = (
      await c.query<{ event: IntelligenceEvent }>(
        'SELECT event FROM intelligence_events WHERE id=$1 FOR UPDATE',
        [eventId],
      )
    ).rows[0]?.event;
    if (!event) throw new IntelligenceValidationError('Event not found');
    const raw = event.raw as Record<string, unknown>;
    if (
      reviewStatus === 'confirmed' &&
      raw &&
      (raw.requiresEffectiveTimeReview === true || raw.requiresOccurrenceTimeReview === true) &&
      raw.manualTimeConfirmed !== true
    )
      throw new IntelligenceValidationError('请先修订并确认实际有效时间');
    const review = (
      await c.query(
        'INSERT INTO intelligence_reviews(event_id,review_status,actor) VALUES($1,$2,$3) RETURNING id',
        [eventId, reviewStatus, actor],
      )
    ).rows[0];
    const id = createHash('sha256').update(`${eventId}:review:${review.id}`).digest('hex');
    await c.query('INSERT INTO fusion_ready_outbox(id,event) VALUES($1,$2::jsonb)', [
      id,
      JSON.stringify({
        id,
        kind: 'intelligence',
        from: event.effectiveFrom,
        to: new Date(
          Math.max(
            Date.parse(event.effectiveTo ?? new Date().toISOString()),
            Date.parse(event.effectiveFrom),
          ),
        ).toISOString(),
        recordIds: [eventId],
        createdAt: new Date().toISOString(),
      }),
    ]);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return intelligenceDetail(infra, eventId);
}
export async function suggestSpatialRelations(
  db: DB,
  eventId: string,
  relation: IntelligenceRelation,
) {
  if (!relation.geometry || relation.objectId || relation.origin === 'legacy') return;
  const matches = (
    await db.query<{ id: string; name: string; kind: string }>(
      'SELECT id,name,kind FROM intelligence_objects WHERE geom IS NOT NULL AND ST_Intersects(geom,ST_SetSRID(ST_GeomFromGeoJSON($1),4326)) ORDER BY id LIMIT 100',
      [JSON.stringify(relation.geometry)],
    )
  ).rows;
  for (const object of matches) {
    const id = createHash('sha256')
      .update(JSON.stringify([relation.id, object.id, 'spatial-suggestion']))
      .digest('hex');
    const duplicate = await db.query(
      "SELECT id FROM (SELECT DISTINCT ON(id) id,data FROM intelligence_relations WHERE event_id=$1 ORDER BY id,revision DESC) r WHERE data->>'objectId'=$2 AND data->>'origin'='rule' AND data->>'reviewStatus'<>'rejected'",
      [eventId, object.id],
    );
    if (
      duplicate.rowCount ||
      (await db.query('SELECT id FROM intelligence_relations WHERE id=$1', [id])).rowCount
    )
      continue;
    await saveRelation(
      db,
      eventId,
      {
        kind: object.kind === 'area' || object.kind === 'channel' ? 'applies-to' : 'occurs-at',
        objectId: object.id,
        basis: `空间相交候选：原文位置与“${object.name}”几何相交，需人工核验适用或发生关系`,
        paragraphIds: relation.paragraphIds,
        reviewStatus: 'candidate',
        origin: 'rule',
      },
      undefined,
      id,
    );
  }
}
