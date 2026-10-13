import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { DiscardPolicy, RetentionPolicy, StorageType } from '@nats-io/jetstream';
import { z } from 'zod';
import {
  parseNormalizedObservation,
  BboxSchema,
  type Bbox,
  type NormalizedObservation,
  type PositionObservation,
} from '@ais/contracts';
import {
  IntelligenceInputSchema,
  type IntelligenceEvent,
  type IntelligenceInput,
  type FusionDataset,
  type FusionReadyEvent,
} from '../contracts/intelligence';
import type { Infrastructure } from './clients';
import { projectIntelligenceRelations } from './intelligence-store';

export function boxesOverlap(a: Bbox, b: Bbox): boolean {
  if (a[1] > b[3] || b[1] > a[3]) return false;
  const pieces = (v: Bbox) =>
    v[0] <= v[2]
      ? [[v[0], v[2]]]
      : [
          [v[0], 180],
          [-180, v[2]],
        ];
  return pieces(a).some((x) => pieces(b).some((y) => x[0]! <= y[1]! && y[0]! <= x[1]!));
}
export const readyEventId = (eventId: string, version: number) =>
  createHash('sha256').update(`${eventId}:${version}`).digest('hex');
export const intelligenceEventId = (sourceId: string, externalId: string, version: number) =>
  createHash('sha256')
    .update(JSON.stringify([sourceId, externalId, version]))
    .digest('hex');

export async function ensureFusionBus(infra: Infrastructure): Promise<void> {
  let info;
  try {
    info = await infra.jsm.streams.info('FUSION_READY');
  } catch (error) {
    const e = error as {
      code?: string | number;
      api_error?: { code?: number };
      apiError?: { code?: number };
      name?: string;
    };
    if (
      e.code !== '404' &&
      e.code !== 404 &&
      e.api_error?.code !== 404 &&
      e.apiError?.code !== 404 &&
      e.name !== 'StreamNotFoundError'
    )
      throw error;
    try {
      info = await infra.jsm.streams.add({
        name: 'FUSION_READY',
        subjects: ['fusion.ready'],
        retention: RetentionPolicy.Limits,
        storage: StorageType.File,
        discard: DiscardPolicy.Old,
        max_bytes: 1_000_000_000,
        max_age: 7 * 86400 * 1e9,
        duplicate_window: 120e9,
      });
    } catch (createError) {
      // Another worker may have created the same stream after our lookup.
      try {
        info = await infra.jsm.streams.info('FUSION_READY');
      } catch {
        throw createError;
      }
    }
  }
  if (
    info.config.retention !== RetentionPolicy.Limits ||
    info.config.storage !== StorageType.File ||
    JSON.stringify(info.config.subjects) !== JSON.stringify(['fusion.ready'])
  )
    throw new Error('FUSION_READY topology drift');
}

/** Publish-before-mark provides at-least-once delivery; consumers deduplicate the stable event id. */
export async function flushReadyOutbox(infra: Infrastructure): Promise<number> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query<{ id: string; event: FusionReadyEvent }>(
      'SELECT id,event FROM fusion_ready_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED',
    );
    for (const row of rows.rows) {
      await infra.js.publish('fusion.ready', JSON.stringify(row.event), { msgID: row.id });
      await client.query('UPDATE fusion_ready_outbox SET published_at=now() WHERE id=$1', [row.id]);
    }
    await client.query('COMMIT');
    return rows.rowCount ?? 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Called only after the target persistence finishes. Receipts survive mismatched batching and retries. */
export async function markFusionWriterReady(
  infra: Infrastructure,
  target: 'postgres' | 'clickhouse',
  observations: readonly NormalizedObservation[],
): Promise<void> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    for (const o of [...observations].sort((a, b) => a.eventId.localeCompare(b.eventId))) {
      if (o.kind === 'quarantine') continue;
      const id = readyEventId(o.eventId, o.cleaningVersion);
      const at = o.observedAt ?? o.receivedAt;
      const event: FusionReadyEvent = {
        id,
        kind: 'ais',
        from: at,
        to: o.kind === 'static' ? new Date(Math.max(Date.parse(at), Date.now())).toISOString() : at,
        recordIds: [o.eventId],
        createdAt: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO fusion_writer_receipts(id,postgres_ready,clickhouse_ready,event) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET postgres_ready=fusion_writer_receipts.postgres_ready OR excluded.postgres_ready,clickhouse_ready=fusion_writer_receipts.clickhouse_ready OR excluded.clickhouse_ready`,
        [id, target === 'postgres', target === 'clickhouse', JSON.stringify(event)],
      );
      await client.query(
        'INSERT INTO fusion_ready_outbox(id,event) SELECT id,event FROM fusion_writer_receipts WHERE id=$1 AND postgres_ready AND clickhouse_ready ON CONFLICT(id) DO NOTHING',
        [id],
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

export async function archiveIntelligenceRaw(
  infra: Infrastructure,
  sourceId: string,
  bytes: Buffer,
  contentType: string,
) {
  if (bytes.length > 10_485_760) throw new Error('Intelligence archive exceeds 10 MiB');
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const id = createHash('sha256').update(`${sourceId}:${checksum}`).digest('hex');
  const key = `intelligence/${id.slice(0, 2)}/${id}`;
  try {
    await infra.s3.send(
      new PutObjectCommand({
        Bucket: infra.config.s3Bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        IfNoneMatch: '*',
        Metadata: { sha256: checksum },
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode !== 412)
      throw error;
  }
  await infra.pool.query(
    'INSERT INTO intelligence_archives(id,source_id,object_key,checksum,bytes,content_type) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING',
    [id, sourceId, key, checksum, bytes.length, contentType],
  );
  return { archiveId: id, archiveKey: key, checksum };
}

export async function saveIntelligenceEvent(
  infra: Infrastructure,
  value: IntelligenceInput,
): Promise<IntelligenceEvent> {
  const input = IntelligenceInputSchema.parse(value);
  if (input.originalArchiveId) {
    const origin = await infra.pool.query(
      'SELECT id FROM intelligence_archives WHERE id=$1 AND source_id=$2',
      [input.originalArchiveId, input.sourceId],
    );
    if (!origin.rowCount) throw new Error('Original archive is not associated with this source');
  }
  const id = intelligenceEventId(input.sourceId, input.externalId, input.version);
  const bytes = Buffer.from(JSON.stringify({ ...input, originalArchiveId: undefined }));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `${input.sourceId}:${input.externalId}`,
    ]);
    const versions = await client.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 ORDER BY version DESC',
      [input.sourceId, input.externalId],
    );
    const existing = versions.rows.find((r) => r.event.version === input.version)?.event;
    if (existing) {
      let unchanged = existing.checksum === checksum;
      if (!unchanged && (existing.reviewStatus === undefined || existing.relations === undefined)) {
        const {
          id: _id,
          archiveKey: _key,
          checksum: _checksum,
          recordedAt: _at,
          ...oldInput
        } = existing;
        // Old archive bytes omitted optional archive references and predate new schema defaults.
        const { originalArchiveId: _oldOrigin, ...oldContent } =
          IntelligenceInputSchema.parse(oldInput);
        const { originalArchiveId: _newOrigin, ...newContent } = input;
        unchanged = isDeepStrictEqual(oldContent, newContent);
      }
      if (!unchanged) throw new Error('Intelligence version is immutable; increment version');
      await client.query('COMMIT');
      return existing;
    }
    const latest = versions.rows[0]?.event;
    if (
      (latest && (input.version !== latest.version + 1 || input.supersedesId !== latest.id)) ||
      (!latest && input.version !== 1)
    )
      throw new Error('Revision must supersede the current version');
    const archive = await archiveIntelligenceRaw(infra, input.sourceId, bytes, 'application/json');
    const event: IntelligenceEvent = {
      ...input,
      id,
      archiveKey: archive.archiveKey,
      checksum: archive.checksum,
      recordedAt: new Date().toISOString(),
    };
    await client.query(
      'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,effective_to,event) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
      [
        id,
        input.sourceId,
        input.externalId,
        input.version,
        input.publishedAt,
        input.effectiveFrom,
        input.effectiveTo,
        JSON.stringify(event),
      ],
    );
    await projectIntelligenceRelations(client, event);
    const readyEnd = new Date(
      Math.max(
        Date.parse(input.effectiveTo ?? event.recordedAt),
        Date.parse(latest?.effectiveTo ?? event.recordedAt),
        Date.parse(input.effectiveFrom),
      ),
    ).toISOString();
    const ready: FusionReadyEvent = {
      id,
      kind: 'intelligence',
      from:
        latest && latest.effectiveFrom < input.effectiveFrom
          ? latest.effectiveFrom
          : input.effectiveFrom,
      to: readyEnd,
      recordIds: [id],
      createdAt: event.recordedAt,
    };
    await client.query(
      'INSERT INTO fusion_ready_outbox(id,event) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING',
      [id, JSON.stringify(ready)],
    );
    await client.query('COMMIT');
    return event;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export class FusionDatasetLimitError extends Error {
  constructor() {
    super('Fusion dataset exceeds explicit maximum; narrow the time window or area');
  }
}
const WindowSchema = z
  .object({
    from: z.iso.datetime(),
    to: z.iso.datetime(),
    maxRecords: z.number().int().min(1).max(100000).default(50000),
    bbox: BboxSchema.optional(),
    mmsis: z
      .array(z.string().regex(/^\d{9}$/))
      .max(100000)
      .optional(),
    sourceId: z.string().min(1).max(200).optional(),
  })
  .refine((v) => Date.parse(v.from) <= Date.parse(v.to), 'Reversed window');
export async function queryFusionDataset(
  infra: Infrastructure,
  input: {
    from: string;
    to: string;
    bbox?: Bbox;
    maxRecords?: number;
    mmsis?: string[];
    sourceId?: string;
  },
): Promise<FusionDataset> {
  const { from, to, maxRecords, bbox, mmsis: selectedMmsis, sourceId } = WindowSchema.parse(input);
  if (Date.parse(from) < Date.now() - 30 * 86400000)
    throw new Error(
      'Requested AIS history precedes the 30-day online retention; restore the raw archive before recomputation',
    );
  const spatial = bbox
    ? ` AND latitude BETWEEN {south:Float64} AND {north:Float64} AND (longitude >= {west:Float64} ${bbox[0] <= bbox[2] ? 'AND' : 'OR'} longitude <= {east:Float64})`
    : '';
  const response = await infra.clickhouse.query({
    query: `SELECT observation FROM positions FINAL WHERE observedAt>=parseDateTime64BestEffort({from:String}) AND observedAt<=parseDateTime64BestEffort({to:String})${spatial}${selectedMmsis !== undefined ? ' AND mmsi IN {selectedMmsis:Array(String)}' : ''}${sourceId ? ' AND sourceId={sourceId:String}' : ''} ORDER BY observedAt,eventId LIMIT {limit:UInt32}`,
    query_params: {
      from,
      to,
      limit: maxRecords + 1,
      ...(selectedMmsis !== undefined ? { selectedMmsis } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(bbox ? { west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] } : {}),
    },
    format: 'JSONEachRow',
    clickhouse_settings: { max_result_bytes: '33554432', result_overflow_mode: 'throw' },
  });
  const rows = await response.json<{ observation: string }>();
  if (rows.length > maxRecords) throw new FusionDatasetLimitError();
  const positions = rows
    .map((r) => parseNormalizedObservation(JSON.parse(r.observation)))
    .filter((o): o is PositionObservation => o.kind === 'position');
  const mmsis = [...new Set(positions.map((o) => o.mmsi))];
  const identifiers = await infra.pool.query<{
    identifier: string;
    vessel_id: string;
    valid_from: Date;
    valid_to: Date | null;
  }>(
    "SELECT identifier,vessel_id,valid_from,valid_to FROM vessel_identifiers WHERE identifier_type='mmsi' AND identifier=ANY($1::text[]) AND valid_from<=$3 AND (valid_to IS NULL OR valid_to>$2)",
    [mmsis, from, to],
  );
  const missing = mmsis.filter((m) => !identifiers.rows.some((r) => r.identifier === m));
  for (const mmsi of missing) {
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `vessel:${mmsi}`,
      ]);
      const current = await client.query(
        "SELECT vessel_id FROM vessel_identifiers WHERE identifier_type='mmsi' AND identifier=$1",
        [mmsi],
      );
      if (!current.rowCount) {
        const id = randomUUID();
        await client.query('INSERT INTO vessel_objects(id) VALUES($1)', [id]);
        await client.query(
          'INSERT INTO vessel_identifiers(vessel_id,identifier,valid_from) VALUES($1,$2,$3)',
          [id, mmsi, '1970-01-01T00:00:00Z'],
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
  const identityRows = missing.length
    ? (
        await infra.pool.query<{
          identifier: string;
          vessel_id: string;
          valid_from: Date;
          valid_to: Date | null;
        }>(
          "SELECT identifier,vessel_id,valid_from,valid_to FROM vessel_identifiers WHERE identifier_type='mmsi' AND identifier=ANY($1::text[])",
          [mmsis],
        )
      ).rows
    : identifiers.rows;
  const staticResponse = mmsis.length
    ? await infra.clickhouse.query({
        query:
          'SELECT mmsi,observation FROM static_history_v2 FINAL WHERE mmsi IN {mmsis:Array(String)} AND coalesce(observedAt,receivedAt)<=parseDateTime64BestEffort({to:String}) ORDER BY coalesce(observedAt,receivedAt) DESC,sourcePriority DESC,eventId DESC LIMIT {limit:UInt32}',
        query_params: { mmsis, to, limit: maxRecords + 1 },
        format: 'JSONEachRow',
        clickhouse_settings: { max_result_bytes: '33554432', result_overflow_mode: 'throw' },
      })
    : null;
  const statics = staticResponse
    ? await staticResponse.json<{ mmsi: string; observation: string }>()
    : [];
  if (statics.length > maxRecords) throw new FusionDatasetLimitError();
  const staticByMmsi = new Map<string, Extract<NormalizedObservation, { kind: 'static' }>[]>();
  for (const row of statics) {
    const value = parseNormalizedObservation(JSON.parse(row.observation));
    if (value.kind !== 'static' || value.fields.shipType === undefined) continue;
    const group = staticByMmsi.get(value.mmsi) ?? [];
    group.push(value);
    staticByMmsi.set(value.mmsi, group);
  }
  const west = "(event->'bbox'->>0)::double precision";
  const east = "(event->'bbox'->>2)::double precision";
  const documentRegion = bbox
    ? ` AND (event->'bbox' IS NULL OR ((event->'bbox'->>1)::double precision <= $7 AND (event->'bbox'->>3)::double precision >= $5 AND ${bbox[0] <= bbox[2] ? `(CASE WHEN ${west}<=${east} THEN ${west}<=$6 AND ${east}>=$4 ELSE ${west}<=$6 OR ${east}>=$4 END)` : `(${west}>${east} OR ${west}<=$6 OR ${east}>=$4)`}))`
    : '';
  // Select related logical documents by any historical revision, then retain every revision
  // so a later moved or withdrawn announcement can invalidate an earlier match.
  const events = await infra.pool.query<{ event: IntelligenceEvent | null }>(
    `WITH related AS (SELECT e.event || jsonb_build_object('reviewStatus',COALESCE((SELECT review_status FROM intelligence_reviews WHERE event_id=e.id ORDER BY id DESC LIMIT 1),e.event->>'reviewStatus','confirmed')) event FROM intelligence_events e WHERE (e.source_id,e.external_id) IN (SELECT source_id,external_id FROM intelligence_events WHERE effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$1)${documentRegion}) ORDER BY e.id LIMIT $3)
    SELECT CASE WHEN sum(octet_length(event::text)) OVER () <= 33554432 THEN event ELSE NULL END event FROM related`,
    [from, to, maxRecords + 1, ...(bbox ? [...bbox] : [])],
  );
  if (events.rows.length > maxRecords || events.rows.some((row) => row.event === null))
    throw new FusionDatasetLimitError();
  const identityByMmsi = new Map<string, typeof identityRows>();
  for (const row of identityRows) {
    const group = identityByMmsi.get(row.identifier) ?? [];
    group.push(row);
    identityByMmsi.set(row.identifier, group);
  }
  return {
    from,
    to,
    queriedAt: new Date().toISOString(),
    complete: true,
    ais: positions.map((o) => {
      const identity = (identityByMmsi.get(o.mmsi) ?? []).filter(
        (r) =>
          r.identifier === o.mmsi &&
          r.valid_from.getTime() <= Date.parse(o.observedAt) &&
          (!r.valid_to || r.valid_to.getTime() > Date.parse(o.observedAt)),
      );
      if (identity.length !== 1)
        throw new Error(`Vessel identity missing or ambiguous for ${o.mmsi}`);
      const group = staticByMmsi.get(o.mmsi) ?? [];
      let low = 0,
        high = group.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        const candidate = group[middle]!;
        if (Date.parse(candidate.observedAt ?? candidate.receivedAt) > Date.parse(o.observedAt))
          low = middle + 1;
        else high = middle;
      }
      const historical = group[low];
      return {
        recordId: o.eventId,
        messageId: o.captureId,
        vesselId: identity[0]!.vessel_id,
        mmsi: o.mmsi,
        occurredAt: o.observedAt,
        longitude: o.lon,
        latitude: o.lat,
        speedOverGround: o.sogKnots,
        shipType: historical?.fields.shipType ?? null,
        ...(historical
          ? { staticEvidence: { recordId: historical.eventId, raw: historical } }
          : {}),
        raw: o,
      };
    }),
    intelligence: events.rows.map((r) => r.event!),
  };
}
