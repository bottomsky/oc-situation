import {
  mergeStaticFields,
  selectLatestPositions,
  type StaticFieldState,
} from '@ais/domain';
import type {
  NormalizedObservation,
  PositionObservation,
  QuarantineObservation,
  StaticFields,
  StaticObservation,
} from '@ais/contracts';
import type { Infrastructure } from './clients';
import { createHash } from 'node:crypto';

export async function saveLatestBatch(
  infra: Infrastructure,
  observations: readonly NormalizedObservation[],
): Promise<void> {
  const positions = selectLatestPositions(
    observations.filter(
      (o): o is PositionObservation =>
        o.kind === 'position' && isWithinOnlineRetention(o),
    ),
  );
  const statics = observations.filter((o): o is StaticObservation => o.kind === 'static');
  const mmsis = [...new Set([...positions, ...statics].map((o) => o.mmsi))].sort();
  if (!mmsis.length) return;
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'INSERT INTO vessels(mmsi) SELECT unnest($1::text[]) ON CONFLICT(mmsi) DO NOTHING',
      [mmsis],
    );
    const lockedVessels = await client.query<{ mmsi: string; static_data: StaticFields }>(
      'SELECT mmsi,static_data FROM vessels WHERE mmsi=ANY($1::text[]) ORDER BY mmsi FOR UPDATE',
      [mmsis],
    );
    if (positions.length) {
      await client.query(
        `INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,sog,cog,heading,nav_status,quality,observation)
        SELECT p->>'mmsi',p->>'eventId',p->>'captureId',p->>'sourceId',p->>'sourceKind',(p->>'sourcePriority')::integer,(p->>'observedAt')::timestamptz,(p->>'receivedAt')::timestamptz,(p->>'cleaningVersion')::integer,(p->>'lat')::double precision,(p->>'lon')::double precision,ST_SetSRID(ST_MakePoint((p->>'lon')::double precision,(p->>'lat')::double precision),4326)::geography,(p->>'sogKnots')::double precision,(p->>'cogDegrees')::double precision,(p->>'headingDegrees')::double precision,(p->>'navigationStatus')::integer,p->'quality',p
        FROM jsonb_array_elements($1::jsonb) p
        ON CONFLICT(mmsi) DO UPDATE SET event_id=excluded.event_id,capture_id=excluded.capture_id,source_id=excluded.source_id,source_kind=excluded.source_kind,source_priority=excluded.source_priority,observed_at=excluded.observed_at,received_at=excluded.received_at,cleaning_version=excluded.cleaning_version,latitude=excluded.latitude,longitude=excluded.longitude,location=excluded.location,sog=excluded.sog,cog=excluded.cog,heading=excluded.heading,nav_status=excluded.nav_status,quality=excluded.quality,observation=excluded.observation,updated_at=now()
        WHERE (excluded.observed_at,excluded.source_priority,excluded.event_id COLLATE "C") > (positions_latest.observed_at,positions_latest.source_priority,positions_latest.event_id COLLATE "C")`,
        [JSON.stringify(positions)],
      );
    }
    if (statics.length) {
      const staticMmsis = [...new Set(statics.map((o) => o.mmsi))];
      const staticMmsiSet = new Set(staticMmsis);
      const states = new Map<string, StaticFieldState>(
        lockedVessels.rows
          .filter((row) => staticMmsiSet.has(row.mmsi))
          .map((row) => [row.mmsi, { fields: row.static_data, provenance: {} }]),
      );
      const provenanceRows = await client.query(
        'SELECT * FROM field_provenance WHERE mmsi=ANY($1::text[])',
        [staticMmsis],
      );
      for (const row of provenanceRows.rows) {
        const state = states.get(row.mmsi)!;
        state.provenance[row.field as keyof StaticFields] = {
          sourceId: row.source_id,
          sourceKind: row.source_kind,
          sourcePriority: row.source_priority,
          eventId: row.event_id,
          observedAt: row.observed_at?.toISOString() ?? null,
          receivedAt: row.received_at.toISOString(),
        };
      }
      for (const observation of statics)
        states.set(observation.mmsi, mergeStaticFields(states.get(observation.mmsi)!, observation));
      const vesselUpdates = [...states].map(([mmsi, state]) => ({
        mmsi,
        fields: state.fields,
        dimensions: {
          length: state.fields.length,
          width: state.fields.width,
          draught: state.fields.draught,
        },
      }));
      await client.query(
        `UPDATE vessels v SET static_data=p->'fields',name=p->'fields'->>'name',imo=p->'fields'->>'imo',callsign=p->'fields'->>'callsign',ship_type=(p->'fields'->>'shipType')::integer,destination=p->'fields'->>'destination',dimensions=p->'dimensions',updated_at=now() FROM jsonb_array_elements($1::jsonb) p WHERE v.mmsi=p->>'mmsi'`,
        [JSON.stringify(vesselUpdates)],
      );
      const provenanceUpdates = [...states].flatMap(([mmsi, state]) =>
        Object.entries(state.provenance).map(([field, origin]) => ({
          mmsi,
          field,
          ...origin,
          value: state.fields[field as keyof StaticFields],
        })),
      );
      if (provenanceUpdates.length)
        await client.query(
          `INSERT INTO field_provenance(mmsi,field,source_id,event_id,observed_at,received_at,source_kind,source_priority,value) SELECT p->>'mmsi',p->>'field',p->>'sourceId',p->>'eventId',(p->>'observedAt')::timestamptz,(p->>'receivedAt')::timestamptz,p->>'sourceKind',(p->>'sourcePriority')::integer,p->'value' FROM jsonb_array_elements($1::jsonb) p ON CONFLICT(mmsi,field) DO UPDATE SET source_id=excluded.source_id,event_id=excluded.event_id,observed_at=excluded.observed_at,received_at=excluded.received_at,source_kind=excluded.source_kind,source_priority=excluded.source_priority,value=excluded.value`,
          [JSON.stringify(provenanceUpdates)],
        );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
const chTimestamp = (value: string) => value.replace('T', ' ').replace(/Z$/, '');
async function insertDeduplicated(
  infra: Infrastructure,
  table: string,
  values: { eventId: string; cleaningVersion: number }[],
) {
  const ordered = values.sort(
    (a, b) => a.eventId.localeCompare(b.eventId) || a.cleaningVersion - b.cleaningVersion,
  );
  const token = createHash('sha256')
    .update(`${table}:${ordered.map((o) => `${o.eventId}:${o.cleaningVersion}`).join(',')}`)
    .digest('hex');
  await infra.clickhouse.insert({
    table,
    values: ordered,
    format: 'JSONEachRow',
    clickhouse_settings: {
      insert_deduplication_token: token,
      async_insert: 0,
      wait_for_async_insert: 1,
      insert_deduplicate: 1,
    },
  });
}
export async function saveHistoryBatch(
  infra: Infrastructure,
  observations: readonly NormalizedObservation[],
): Promise<void> {
  const positions = observations
    .filter(
      (o): o is PositionObservation =>
        o.kind === 'position' && isWithinOnlineRetention(o),
    )
    .map((o) => ({
      eventId: o.eventId,
      captureId: o.captureId,
      mmsi: o.mmsi,
      sourceId: o.sourceId,
      sourceKind: o.sourceKind,
      sourcePriority: o.sourcePriority,
      observedAt: chTimestamp(o.observedAt),
      receivedAt: chTimestamp(o.receivedAt),
      cleaningVersion: o.cleaningVersion,
      latitude: o.lat,
      longitude: o.lon,
      sog: o.sogKnots,
      cog: o.cogDegrees,
      heading: o.headingDegrees,
      navStatus: o.navigationStatus,
      quality: o.quality,
      observation: JSON.stringify(o),
    }));
  const statics = observations
    .filter((o) => o.kind === 'static')
    .map((o) => ({
      eventId: o.eventId,
      captureId: o.captureId,
      mmsi: o.mmsi,
      sourceId: o.sourceId,
      sourceKind: o.sourceKind,
      sourcePriority: o.sourcePriority,
      observedAt: o.observedAt ? chTimestamp(o.observedAt) : null,
      receivedAt: chTimestamp(o.receivedAt),
      cleaningVersion: o.cleaningVersion,
      observation: JSON.stringify(o),
    }));
  const quarantines = observations.filter(
    (o): o is QuarantineObservation => o.kind === 'quarantine',
  );
  const quality = observations
    .filter((o) => o.quality.length)
    .map((o) => ({
      eventId: o.eventId,
      sourceId: o.sourceId,
      observedAt: o.observedAt ? chTimestamp(o.observedAt) : null,
      receivedAt: chTimestamp(o.receivedAt),
      cleaningVersion: o.cleaningVersion,
      flags: o.quality,
    }));
  if (positions.length) await insertDeduplicated(infra, 'positions', positions);
  if (statics.length) await insertDeduplicated(infra, 'static_history_v2', statics);
  if (quarantines.length) await saveQuarantine(infra, quarantines);
  if (quality.length) await insertDeduplicated(infra, 'quality_events_v2', quality);
}
export async function saveQuarantine(
  infra: Infrastructure,
  observations: readonly QuarantineObservation[],
): Promise<void> {
  if (!observations.length) return;
  await insertDeduplicated(
    infra,
    'quarantine_v2',
    observations.map((o) => ({
      eventId: o.eventId,
      captureId: o.captureId,
      sourceId: o.sourceId,
      receivedAt: chTimestamp(o.receivedAt),
      cleaningVersion: o.cleaningVersion,
      reasons: o.reasons,
      observation: JSON.stringify(o),
    })),
  );
}
export function isWithinOnlineRetention(observation: PositionObservation, now = Date.now()): boolean {
  return Date.parse(observation.observedAt) >= now - 30 * 86_400_000;
}
