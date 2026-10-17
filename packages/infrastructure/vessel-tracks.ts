import { randomUUID } from 'node:crypto';
import {
  VesselTracksQuerySchema,
  VesselTracksResultSchema,
  validateVesselTracksWindow,
  VESSEL_TRACKS_RETENTION_DAYS,
  type VesselTracksQuery,
  type VesselTracksResult,
  type VesselTracksSelector,
  type VesselTrack,
  type VesselTrackPoint,
} from '../contracts/vessel-tracks';
import type { Infrastructure } from './clients';

export type VesselTracksErrorCategory =
  'invalid_input' | 'retention' | 'data_limit' | 'busy' | 'cancelled' | 'unavailable';
const messages: Record<VesselTracksErrorCategory, string> = {
  invalid_input: '航线查询条件无效，请检查船舶条件、区域与时间。',
  retention: '航线查询超出近30天在线历史范围，请选择近期时间。',
  data_limit: '航线查询数据量超过限制，请缩小时间、区域或船舶范围。',
  busy: '航线查询正在处理其他请求，请稍后重试。',
  cancelled: '航线查询已取消。',
  unavailable: '航线查询暂时不可用，请稍后重试。',
};
export class VesselTracksQueryError extends Error {
  constructor(readonly category: VesselTracksErrorCategory) {
    super(messages[category]);
  }
}
export interface VesselTracksQueryContext {
  ownerId?: string;
  signal?: AbortSignal;
  now?: Date;
}
type Profile = Pick<VesselTrack, 'mmsi' | 'name' | 'shipType'>;
const PROFILE_LIMIT = 100000;
const RAW_POINT_LIMIT = 100000;
const active = new WeakSet<Infrastructure>();
const settings = {
  max_execution_time: 20,
  max_memory_usage: '536870912',
  max_rows_to_read: '50000000',
  max_bytes_to_read: '4294967296',
  read_overflow_mode: 'throw',
  timeout_overflow_mode: 'throw',
  group_by_overflow_mode: 'throw',
  result_overflow_mode: 'throw',
  max_result_rows: String(RAW_POINT_LIMIT),
  max_result_bytes: '16777216',
  cancel_http_readonly_queries_on_client_close: 1,
} as const;
function checkCancelled(signal: AbortSignal) {
  if (signal.aborted)
    throw signal.reason instanceof VesselTracksQueryError
      ? signal.reason
      : new VesselTracksQueryError('cancelled');
}

/** Model labels are exact case-insensitive strings in vessel GeoObject metadata.
 * Supported keys: model, vesselModel, shipClass. AIS ship_type never implies a model.
 * Different selector fields intersect; query text is a literal substring, not SQL wildcards.
 */
export async function resolveVesselTracksSelector(
  infra: Infrastructure,
  selector: VesselTracksSelector,
  signal: AbortSignal,
): Promise<Profile[]> {
  checkCancelled(signal);
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query("SET LOCAL statement_timeout='5000ms'");
    checkCancelled(signal);
    const result = await client.query<Profile>(
      `WITH objects AS (
      SELECT id,name,data,data->>'mmsi' AS mmsi FROM intelligence_objects
      WHERE kind='vessel' AND data->>'mmsi' ~ '^[1-9][0-9]{8}$'
    ), identifiers AS (
      SELECT mmsi FROM vessels UNION SELECT mmsi FROM objects UNION SELECT unnest($1::text[])
    )
    SELECT i.mmsi,coalesce(v.name,(SELECT o.name FROM objects o WHERE o.mmsi=i.mmsi ORDER BY o.id LIMIT 1)) AS name,
      CASE WHEN v.ship_type BETWEEN 1 AND 99 THEN v.ship_type ELSE NULL END AS "shipType"
    FROM identifiers i LEFT JOIN vessels v ON v.mmsi=i.mmsi
    WHERE i.mmsi ~ '^[1-9][0-9]{8}$'
      AND ($1::text[] IS NULL OR i.mmsi=ANY($1::text[]))
      AND ($2::int[] IS NULL OR v.ship_type=ANY($2::int[]))
      AND ($3::text IS NULL OR
        position(lower($3) in lower(i.mmsi))>0 OR
        position(lower($3) in lower(coalesce(v.name,'')))>0 OR
        position(lower($3) in lower(coalesce(v.imo,'')))>0 OR
        position(lower($3) in lower(coalesce(v.callsign,'')))>0 OR
        EXISTS(SELECT 1 FROM objects o WHERE o.mmsi=i.mmsi AND (
          position(lower($3) in lower(o.name))>0 OR
          EXISTS(SELECT 1 FROM jsonb_array_elements_text(
            CASE WHEN jsonb_typeof(o.data->'aliases')='array' THEN o.data->'aliases' ELSE '[]'::jsonb END
          ) AS alias(value) WHERE position(lower($3) in lower(alias.value))>0))))
      AND ($4::text IS NULL OR EXISTS(SELECT 1 FROM objects o
        CROSS JOIN (VALUES ('model'),('vesselModel'),('shipClass')) AS key(name)
        WHERE o.mmsi=i.mmsi AND jsonb_typeof(o.data->'metadata'->key.name)='string'
          AND lower(btrim(o.data->'metadata'->>key.name))=lower($4)))
    ORDER BY i.mmsi LIMIT $5`,
      [
        selector.mmsis ?? null,
        selector.shipTypes ?? null,
        selector.query ?? null,
        selector.model ?? null,
        PROFILE_LIMIT + 1,
      ],
    );
    if (result.rows.length > PROFILE_LIMIT) throw new VesselTracksQueryError('data_limit');
    await client.query('COMMIT');
    checkCancelled(signal);
    return result.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Input is one vessel's time-ordered, source-preferred native observations. */
export function buildVesselTrack(
  profile: Profile,
  points: VesselTrackPoint[],
  max: number,
): VesselTrack {
  const segments: VesselTrack['segments'] = [];
  for (const point of points) {
    const previous = segments.at(-1)?.points.at(-1);
    if (
      !previous ||
      Date.parse(point.observedAt) - Date.parse(previous.observedAt) > 1800000 ||
      Math.abs(point.lon - previous.lon) > 180
    )
      segments.push({ points: [] });
    segments.at(-1)!.points.push(point);
  }
  const minimum = segments.reduce((sum, segment) => sum + Math.min(2, segment.points.length), 0);
  const interior = points.length - minimum;
  let remaining = Math.max(0, max - minimum),
    returned = 0;
  const sampled = segments
    .map((segment, index) => {
      const size = segment.points.length;
      let allowance: number;
      if (minimum > max) {
        allowance = size === 1 && returned < max ? 1 : max - returned >= 2 ? 2 : 0;
      } else {
        const extra =
          index === segments.length - 1
            ? remaining
            : Math.min(
                remaining,
                Math.floor(((max - minimum) * Math.max(0, size - 2)) / Math.max(1, interior)),
              );
        remaining -= extra;
        allowance = Math.min(size, Math.min(2, size) + extra);
      }
      const selected =
        allowance === 0
          ? []
          : allowance >= size
            ? segment.points
            : Array.from(
                { length: allowance },
                (_, index) => segment.points[Math.round((index * (size - 1)) / (allowance - 1))]!,
              );
      returned += selected.length;
      return { points: selected };
    })
    .flatMap((segment) => {
      // Sampling can span >180 degrees even when every native edge was local.
      // Split that retained pair instead of drawing a new date-line connection.
      const pieces: VesselTrack['segments'] = [];
      for (const point of segment.points) {
        const previous = pieces.at(-1)?.points.at(-1);
        if (!previous || Math.abs(point.lon - previous.lon) > 180) pieces.push({ points: [] });
        pieces.at(-1)!.points.push(point);
      }
      return pieces;
    });
  return {
    ...profile,
    segments: sampled,
    total: points.length,
    returned,
    sampled: returned < points.length,
    truncated: minimum > max,
  };
}

function preferredSql(source: boolean) {
  return `SELECT mmsi,observedAt,argMax(tuple(longitude,latitude),tuple(sourcePriority,eventId)) AS point
    FROM positions FINAL
    WHERE observedAt>=parseDateTime64BestEffort({from:String})
      AND observedAt<parseDateTime64BestEffort({to:String})
      AND mmsi IN {mmsis:Array(String)}
      ${source ? 'AND sourceId={sourceId:String}' : ''}
    GROUP BY mmsi,observedAt`;
}
async function execute(
  infra: Infrastructure,
  query: VesselTracksQuery,
  asOf: string,
  signal: AbortSignal,
): Promise<VesselTracksResult> {
  const empty = (): VesselTracksResult => ({
    query,
    asOf,
    generatedAt: new Date().toISOString(),
    shipTypeBasis: 'current_profile',
    selectionBasis: 'historical_observation_in_bbox',
    trackScope: 'full_time_window',
    returnedVessels: 0,
    matchedVesselsLowerBound: 0,
    hasMoreVessels: false,
    tracks: [],
  });
  const profiles = await resolveVesselTracksSelector(infra, query.selector, signal);
  if (!profiles.length) return empty();
  checkCancelled(signal);
  const [west, south, east, north] = query.bbox;
  const params = {
    from: query.from,
    to: query.to,
    ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
  };
  const candidatesResponse = await infra.clickhouse.query({
    query_id: `vessel-tracks-candidates-${randomUUID()}`,
    // Resolve cleaning versions and source preference before testing regional membership.
    query: `WITH preferred AS (${preferredSql(query.sourceId !== undefined)}),
      located AS (SELECT mmsi,if(point.1=180,-180,point.1) AS lon,point.2 AS lat FROM preferred)
      SELECT DISTINCT mmsi FROM located WHERE lat BETWEEN {south:Float64} AND {north:Float64}
        AND ((lon >= {west:Float64} ${west <= east ? 'AND' : 'OR'} lon <= {east:Float64})
          OR (lon=-180 AND ({west:Float64}=180 OR {east:Float64}=180)))
      ORDER BY mmsi LIMIT {limit:UInt32}`,
    query_params: {
      ...params,
      mmsis: profiles.map((profile) => profile.mmsi),
      west,
      south,
      east,
      north,
      limit: query.maxVessels + 1,
    },
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: { ...settings, max_result_rows: '51' },
  });
  const candidates = await candidatesResponse.json<{ mmsi: string }>();
  checkCancelled(signal);
  if (!candidates.length) return empty();
  const mmsis = candidates.slice(0, query.maxVessels).map((candidate) => candidate.mmsi);
  const response = await infra.clickhouse.query({
    query_id: `vessel-tracks-points-${randomUUID()}`,
    query: `WITH preferred AS (${preferredSql(query.sourceId !== undefined)})
      SELECT mmsi,toUnixTimestamp64Milli(observedAt) AS observedMs,point.1 AS lon,point.2 AS lat
      FROM preferred ORDER BY mmsi,observedAt`,
    query_params: { ...params, mmsis },
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: settings,
  });
  const rows = await response.json<{
    mmsi: string;
    observedMs: string | number;
    lon: number;
    lat: number;
  }>();
  checkCancelled(signal);
  if (rows.length > RAW_POINT_LIMIT) throw new VesselTracksQueryError('data_limit');
  const grouped = new Map(mmsis.map((mmsi) => [mmsi, [] as VesselTrackPoint[]]));
  for (const row of rows) {
    const points = grouped.get(row.mmsi);
    if (!points) throw new VesselTracksQueryError('unavailable');
    points.push({
      lon: row.lon,
      lat: row.lat,
      observedAt: new Date(Number(row.observedMs)).toISOString(),
    });
  }
  const byMmsi = new Map(profiles.map((profile) => [profile.mmsi, profile]));
  return VesselTracksResultSchema.parse({
    ...empty(),
    returnedVessels: mmsis.length,
    matchedVesselsLowerBound: candidates.length,
    hasMoreVessels: candidates.length > query.maxVessels,
    tracks: mmsis.map((mmsi) =>
      buildVesselTrack(
        byMmsi.get(mmsi) ?? { mmsi, name: null, shipType: null },
        grouped.get(mmsi)!,
        query.maxPointsPerVessel,
      ),
    ),
  });
}
function safeError(error: unknown, signal: AbortSignal): VesselTracksQueryError {
  if (error instanceof VesselTracksQueryError) return error;
  if (signal.aborted)
    return signal.reason instanceof VesselTracksQueryError
      ? signal.reason
      : new VesselTracksQueryError('cancelled');
  const code = String((error as { code?: unknown })?.code ?? '');
  return new VesselTracksQueryError(
    ['158', '159', '160', '241', '307', '396', '202', '57014'].includes(code)
      ? 'data_limit'
      : 'unavailable',
  );
}
/** Both transports authenticate before invoking this shared, read-only query. No cross-owner cache. */
export async function queryVesselTracks(
  infra: Infrastructure,
  input: VesselTracksQuery,
  context: VesselTracksQueryContext = {},
): Promise<VesselTracksResult> {
  if (context.signal?.aborted) throw new VesselTracksQueryError('cancelled');
  const parsed = VesselTracksQuerySchema.safeParse(input);
  if (!parsed.success) throw new VesselTracksQueryError('invalid_input');
  const query = parsed.data,
    now = context.now ?? new Date();
  if (Date.parse(query.from) < now.getTime() - VESSEL_TRACKS_RETENTION_DAYS * 86400000)
    throw new VesselTracksQueryError('retention');
  try {
    validateVesselTracksWindow(query, now);
  } catch {
    throw new VesselTracksQueryError('invalid_input');
  }
  if (active.has(infra)) throw new VesselTracksQueryError('busy');
  active.add(infra);
  const controller = new AbortController();
  const abort = () => controller.abort(new VesselTracksQueryError('cancelled'));
  context.signal?.addEventListener('abort', abort, { once: true });
  if (context.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new VesselTracksQueryError('data_limit')), 25000);
  let detachAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const cancel = () => reject(controller.signal.reason);
    controller.signal.addEventListener('abort', cancel, { once: true });
    detachAbort = () => controller.signal.removeEventListener('abort', cancel);
    if (controller.signal.aborted) cancel();
  });
  // Keep ownership until actual I/O settles even when the caller has stopped waiting.
  const execution = execute(infra, query, now.toISOString(), controller.signal).finally(() =>
    active.delete(infra),
  );
  try {
    return await Promise.race([execution, cancelled]);
  } catch (error) {
    throw safeError(error, controller.signal);
  } finally {
    clearTimeout(timer);
    detachAbort();
    context.signal?.removeEventListener('abort', abort);
  }
}
