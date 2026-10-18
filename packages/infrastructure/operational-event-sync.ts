import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Infrastructure } from './clients';
import { logger } from './clients';
import type { IntelligenceEvent } from '../contracts/intelligence';
import type { AnalysisResult } from '../contracts/topics';
import {
  OperationalEventFieldsSchema,
  type OperationalEventSourceSnapshot,
  type OperationalEventSource,
  type OperationalEvent,
} from '../contracts/operational-events';
import { sourceSnapshotKey, effectiveEventFields } from '../domain/operational-event';
import { persistOperationalEvent } from './operational-event-store';
type DB = Pick<PoolClient, 'query'>;

export async function enqueueOperationalEventSource(
  db: DB,
  snapshot: OperationalEventSourceSnapshot,
) {
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `event-source:${snapshot.key}`,
  ]);
  const head = (
    await db.query(
      'SELECT revision,fingerprint,snapshot FROM operational_event_source_heads WHERE source_key=$1 FOR UPDATE',
      [snapshot.key],
    )
  ).rows[0];
  if (head && head.snapshot.version > snapshot.version) return;
  const fingerprint = sourceSnapshotKey(snapshot);
  if (head?.fingerprint === fingerprint) return;
  const revision = Number(head?.revision ?? 0) + 1;
  await db.query(
    'INSERT INTO operational_event_source_heads(source_key,revision,fingerprint,snapshot) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(source_key) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,snapshot=excluded.snapshot',
    [snapshot.key, revision, fingerprint, JSON.stringify(snapshot)],
  );
  await db.query(
    'INSERT INTO operational_event_source_revisions(source_key,revision,snapshot) VALUES($1,$2,$3::jsonb)',
    [snapshot.key, revision, JSON.stringify(snapshot)],
  );
  await db.query(
    'INSERT INTO event_sync_outbox(source_key,revision,snapshot) VALUES($1,$2,$3::jsonb)',
    [snapshot.key, revision, JSON.stringify(snapshot)],
  );
}
export async function enqueueIntelligenceOperationalEvent(db: DB, eventId: string) {
  const identity = (
    await db.query('SELECT source_id,external_id FROM intelligence_events WHERE id=$1', [eventId])
  ).rows[0];
  if (!identity) return;
  const key = JSON.stringify(['intelligence', identity.source_id, identity.external_id]);
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`event-source:${key}`]);
  const event = (
    await db.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 ORDER BY version DESC LIMIT 1',
      [identity.source_id, identity.external_id],
    )
  ).rows[0]!.event;
  const reviewStatus =
    (
      await db.query(
        'SELECT review_status FROM intelligence_reviews WHERE event_id=$1 ORDER BY id DESC LIMIT 1',
        [event.id],
      )
    ).rows[0]?.review_status ??
    event.reviewStatus ??
    'confirmed';
  const geom =
    (
      await db.query(
        `WITH latest AS (SELECT DISTINCT ON(id) * FROM intelligence_relations WHERE event_id=$1 ORDER BY id,revision DESC), eligible AS (SELECT geom FROM latest WHERE data->>'reviewStatus'='confirmed' AND geom IS NOT NULL) SELECT ST_AsGeoJSON(ST_Multi(ST_CollectionExtract(ST_Collect(geom),max(ST_Dimension(geom))+1)))::jsonb geometry FROM eligible`,
        [event.id],
      )
    ).rows[0]?.geometry ?? null;
  await enqueueOperationalEventSource(db, {
    key,
    kind: 'intelligence',
    sourceId: event.sourceId,
    externalId: event.externalId,
    version: event.version,
    status: event.status,
    reviewStatus,
    fields: OperationalEventFieldsSchema.parse({
      title: event.title,
      summary: event.summary,
      category: event.category,
      occurredAt: event.effectiveFrom,
      geometry: geom,
      linkedMmsis: event.mmsis,
    }),
  });
}
export async function enqueueAnalysisOperationalEvent(db: DB, result: AnalysisResult) {
  const [w, s, e, n] = result.bbox;
  const ring = (a: number, b: number): [number, number][] => [
    [a, s],
    [b, s],
    [b, n],
    [a, n],
    [a, s],
  ];
  const geometry =
    w === e && s === n
      ? { type: 'Point', coordinates: [w, s] }
      : w <= e
        ? { type: 'Polygon', coordinates: [ring(w, e)] }
        : { type: 'MultiPolygon', coordinates: [[ring(w, 180)], [ring(-180, e)]] };
  await enqueueOperationalEventSource(db, {
    key: JSON.stringify(['analysis', result.id]),
    kind: 'analysis',
    sourceId: result.instanceId,
    externalId: result.id,
    version: result.revision,
    status: result.status,
    reviewStatus: 'confirmed',
    fields: OperationalEventFieldsSchema.parse({
      title: result.title,
      summary: result.summary,
      category: result.definitionId,
      occurredAt: result.from,
      geometry,
      linkedMmsis: result.mmsi ? [result.mmsi] : [],
    }),
  });
}
async function applySnapshot(
  c: PoolClient,
  snapshot: OperationalEventSourceSnapshot,
  revision: number,
) {
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `event-apply:${snapshot.key}`,
  ]);
  // Consumers and merges acquire event rows before modifying source rows, preventing lock inversion.
  const existing = (
    await c.query<{ data: OperationalEventSource }>(
      'SELECT data FROM operational_event_sources WHERE source_key=$1',
      [snapshot.key],
    )
  ).rows[0]?.data;
  if (existing && existing.revision >= revision) return;
  let event: OperationalEvent;
  const timestamp = new Date().toISOString();
  if (existing) {
    let id = existing.eventId;
    for (;;) {
      const row = (
        await c.query<{ data: OperationalEvent }>(
          'SELECT data FROM operational_events WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]!;
      if (!row.data.mergedInto) {
        event = row.data;
        break;
      }
      id = row.data.mergedInto;
    }
    if (event.primarySourceKey === snapshot.key) {
      event = {
        ...event,
        ...effectiveEventFields(snapshot.fields, event.overrides),
        sourceSuggestions: snapshot.fields,
        revision: event.revision + 1,
        updatedAt: timestamp,
      };
      await persistOperationalEvent(c, event);
    } else {
      event = { ...event, revision: event.revision + 1, updatedAt: timestamp };
      await persistOperationalEvent(c, event);
    }
  } else {
    event = {
      ...snapshot.fields,
      id: randomUUID(),
      revision: 1,
      status: 'active',
      primarySourceKey: snapshot.key,
      sourceSuggestions: snapshot.fields,
      overrides: {},
      mergedInto: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await persistOperationalEvent(c, event);
  }
  const data: OperationalEventSource = {
    ...snapshot,
    eventId: event.id,
    revision,
    updatedAt: timestamp,
  };
  await c.query(
    'INSERT INTO operational_event_sources(source_key,event_id,revision,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(source_key) DO UPDATE SET event_id=excluded.event_id,revision=excluded.revision,data=excluded.data,updated_at=now()',
    [snapshot.key, event.id, revision, JSON.stringify(data)],
  );
}
export async function processOperationalEventSync(
  infra: Infrastructure,
  limit = 100,
): Promise<number> {
  let count = 0;
  for (let i = 0; i < limit; i++) {
    const c = await infra.pool.connect();
    let id: string | undefined;
    try {
      await c.query('BEGIN');
      const row = (
        await c.query(
          'SELECT * FROM event_sync_outbox WHERE applied_at IS NULL ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1',
        )
      ).rows[0];
      if (!row) {
        await c.query('COMMIT');
        break;
      }
      id = row.id;
      await applySnapshot(c, row.snapshot, Number(row.revision));
      await c.query(
        'UPDATE event_sync_outbox SET applied_at=now(),attempts=attempts+1,last_error=NULL WHERE id=$1',
        [id],
      );
      await c.query('COMMIT');
      count++;
    } catch (error) {
      await c.query('ROLLBACK');
      if (id)
        await infra.pool.query(
          'UPDATE event_sync_outbox SET attempts=attempts+1,last_error=$2 WHERE id=$1 AND applied_at IS NULL',
          [id, String(error).slice(0, 2000)],
        );
      throw error;
    } finally {
      c.release();
    }
  }
  return count;
}
export async function backfillOperationalEventSources(infra: Infrastructure) {
  const c = await infra.pool.connect();
  try {
    // Each source commits independently, making restarts bounded and repeatable.
    const documents = (
      await c.query(
        'SELECT DISTINCT ON(source_id,external_id) id FROM intelligence_events ORDER BY source_id,external_id,version DESC',
      )
    ).rows;
    for (const row of documents) {
      await c.query('BEGIN');
      await enqueueIntelligenceOperationalEvent(c, row.id);
      await c.query('COMMIT');
    }
    const results = (
      await c.query<{ payload: AnalysisResult }>('SELECT payload FROM analysis_results ORDER BY id')
    ).rows;
    for (const row of results) {
      await c.query('BEGIN');
      const latest = (
        await c.query<{ payload: AnalysisResult }>(
          'SELECT payload FROM analysis_results WHERE id=$1 FOR SHARE',
          [row.payload.id],
        )
      ).rows[0];
      if (latest) await enqueueAnalysisOperationalEvent(c, latest.payload);
      await c.query('COMMIT');
    }
    return { intelligence: documents.length, analysis: results.length };
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
export function startOperationalEventSync(infra: Infrastructure) {
  const metrics = { applied: 0, failures: 0, lagSeconds: 0 };
  let backfilled = false;
  let stopped = false,
    running: Promise<void> | undefined;
  const tick = () => {
    if (running || stopped) return;
    running = (async () => {
      try {
        if (!backfilled) {
          await backfillOperationalEventSources(infra);
          backfilled = true;
        }
        metrics.applied += await processOperationalEventSync(infra);
        metrics.lagSeconds = Number(
          (
            await infra.pool.query(
              'SELECT COALESCE(EXTRACT(epoch FROM now()-min(created_at)),0) lag FROM event_sync_outbox WHERE applied_at IS NULL',
            )
          ).rows[0].lag,
        );
      } catch (error) {
        metrics.failures++;
        logger.error({ error: String(error) }, 'Operational event synchronization failed');
      } finally {
        running = undefined;
      }
    })();
  };
  const timer = setInterval(tick, 1000);
  timer.unref();
  tick();
  return {
    metrics,
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
