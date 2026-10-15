import { randomUUID } from 'node:crypto';
import {
  HEATMAP_MAX_CELLS,
  HEATMAP_RETENTION_DAYS,
  HeatmapQuerySchema,
  HeatmapResultSchema,
  validateHeatmapQueryWindow,
  type HeatmapGrid,
  type HeatmapQuery,
  type HeatmapResult,
} from '../contracts/heatmap';
import type { Infrastructure } from './clients';

export type HeatmapErrorCategory =
  'invalid_input' | 'retention' | 'data_limit' | 'busy' | 'cancelled' | 'unavailable';
const messages: Record<HeatmapErrorCategory, string> = {
  invalid_input: '热力查询条件无效，请检查区域与时间范围。',
  retention: '热力查询超出近30天在线历史范围，请选择近期时间。',
  data_limit: '热力查询数据量超过限制，请缩小时间、区域或船舶范围。',
  busy: '热力查询正在处理其他请求，请稍后重试。',
  cancelled: '热力查询已取消。',
  unavailable: '热力查询暂时不可用，请稍后重试。',
};
export class HeatmapQueryError extends Error {
  constructor(readonly category: HeatmapErrorCategory) {
    super(messages[category]);
  }
}
export interface HeatmapQueryContext {
  ownerId?: string;
  signal?: AbortSignal;
}

const longitude = (lon: number) => (lon === 180 ? -180 : lon);
function cellCentre(x: number, y: number, level: number) {
  const cellDegrees = 360 / 2 ** level;
  const south = -90 + y * cellDegrees;
  return {
    id: `${level}:${x}:${y}`,
    x,
    y,
    lon: -180 + (x + 0.5) * cellDegrees,
    lat: (south + Math.min(90, south + cellDegrees)) / 2,
  };
}
export function heatmapCellCoordinates(lon: number, lat: number, level: number) {
  const size = 360 / 2 ** level;
  return cellCentre(
    Math.floor((longitude(lon) + 180) / size),
    Math.min(Math.max(1, 2 ** (level - 1)) - 1, Math.floor((lat + 90) / size)),
    level,
  );
}

/** Inclusive region edges, half-open global cells, and longitude 180 belongs to x=0. */
export function chooseHeatmapGrid(bbox: HeatmapQuery['bbox']): HeatmapGrid {
  const [west, south, east, north] = bbox;
  for (let level = 20; level >= 0; level--) {
    const cellDegrees = 360 / 2 ** level;
    const xMax = 2 ** level - 1;
    const x = (value: number) => Math.min(xMax, Math.floor((value + 180) / cellDegrees));
    const segments: [number, number][] =
      west === 180
        ? [[0, east === 180 ? 0 : x(east)]]
        : west <= east
          ? [[x(west), x(east)]]
          : [
              [x(west), xMax],
              [0, x(east)],
            ];
    if (west === 180 || east === 180) segments.push([0, 0]);
    segments.sort((a, b) => a[0] - b[0]);
    let columns = 0,
      end = -1;
    for (const [start, stop] of segments) {
      columns += Math.max(0, stop - Math.max(start, end + 1) + 1);
      end = Math.max(end, stop);
    }
    const yMax = Math.max(1, 2 ** (level - 1)) - 1;
    const y = (value: number) => Math.min(yMax, Math.floor((value + 90) / cellDegrees));
    if (columns * (y(north) - y(south) + 1) <= HEATMAP_MAX_CELLS) return { level, cellDegrees };
  }
  return { level: 0, cellDegrees: 360 };
}

function normalizeQuery(input: HeatmapQuery): HeatmapQuery {
  const parsed = HeatmapQuerySchema.safeParse(input);
  if (!parsed.success) throw new HeatmapQueryError('invalid_input');
  const query = parsed.data;
  const now = new Date();
  if (Date.parse(query.from) < now.getTime() - HEATMAP_RETENTION_DAYS * 86400000)
    throw new HeatmapQueryError('retention');
  try {
    validateHeatmapQueryWindow(query, now);
  } catch {
    throw new HeatmapQueryError('invalid_input');
  }
  return {
    bbox: query.bbox,
    from: new Date(query.from).toISOString(),
    to: new Date(query.to).toISOString(),
    ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
    ...(query.shipType === undefined ? {} : { shipType: query.shipType }),
    ...(query.mmsis?.length ? { mmsis: [...query.mmsis].sort() } : {}),
  };
}

const PROFILE_MMSI_LIMIT = 100000;
async function execute(
  infra: Infrastructure,
  query: HeatmapQuery,
  signal: AbortSignal,
): Promise<HeatmapResult> {
  const grid = chooseHeatmapGrid(query.bbox);
  const empty = (): HeatmapResult => ({
    query,
    grid,
    cells: [],
    totalVessels: 0,
    generatedAt: new Date().toISOString(),
    metric: 'unique_vessels',
    shipTypeBasis: 'current_profile',
  });
  let selectedMmsis = query.mmsis;
  if (query.shipType !== undefined) {
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      // A server-side timeout stops PostgreSQL work; a client read timeout only stops waiting.
      await client.query("SET LOCAL statement_timeout='5000ms'");
      if (signal.aborted) throw new HeatmapQueryError('cancelled');
      const profiles = await client.query<{ mmsi: string }>(
        'SELECT mmsi FROM vessels WHERE ship_type=$1 AND ($2::text[] IS NULL OR mmsi=ANY($2::text[])) ORDER BY mmsi LIMIT $3',
        [query.shipType, query.mmsis ?? null, PROFILE_MMSI_LIMIT + 1],
      );
      if (profiles.rows.length > PROFILE_MMSI_LIMIT) throw new HeatmapQueryError('data_limit');
      selectedMmsis = profiles.rows.map((row) => row.mmsi);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (signal.aborted) throw new HeatmapQueryError('cancelled');
    if (!selectedMmsis.length) return empty();
  }
  if (signal.aborted) throw new HeatmapQueryError('cancelled');
  const [west, south, east, north] = query.bbox;
  const response = await infra.clickhouse.query({
    query_id: `heatmap-${randomUUID()}`,
    // FINAL resolves cleaning versions before source preference. Spatial predicates
    // deliberately follow argMax, so a preferred point outside the bbox wins.
    query: `WITH preferred AS (
      SELECT mmsi, observedAt, argMax(tuple(longitude,latitude),tuple(sourcePriority,eventId)) AS point
      FROM positions FINAL
      WHERE observedAt>=parseDateTime64BestEffort({from:String}) AND observedAt<parseDateTime64BestEffort({to:String})
      ${query.sourceId === undefined ? '' : 'AND sourceId={sourceId:String}'}
      ${selectedMmsis === undefined ? '' : 'AND mmsi IN {selectedMmsis:Array(String)}'}
      GROUP BY mmsi,observedAt
    ), located AS (
      SELECT mmsi, if(point.1=180,-180,point.1) AS lon,point.2 AS lat FROM preferred
    ), cells AS (
      SELECT mmsi,toUInt32(floor((lon+180)/{cellDegrees:Float64})) AS x,
        toUInt32(least({yMax:UInt32},floor((lat+90)/{cellDegrees:Float64}))) AS y
      FROM located WHERE lat BETWEEN {south:Float64} AND {north:Float64}
      AND ((lon >= {west:Float64} ${west <= east ? 'AND' : 'OR'} lon <= {east:Float64})
        OR (lon=-180 AND ({west:Float64}=180 OR {east:Float64}=180)))
    )
    SELECT GROUPING(x,y) AS isTotal,x,y,uniqExact(mmsi) AS vesselCount
    FROM cells GROUP BY GROUPING SETS ((x,y),()) ORDER BY isTotal DESC,x,y`,
    query_params: {
      from: query.from,
      to: query.to,
      west,
      south,
      east,
      north,
      cellDegrees: grid.cellDegrees,
      yMax: Math.max(1, 2 ** (grid.level - 1)) - 1,
      ...(query.sourceId === undefined ? {} : { sourceId: query.sourceId }),
      ...(selectedMmsis === undefined ? {} : { selectedMmsis }),
    },
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      max_execution_time: 20,
      max_memory_usage: '536870912',
      max_rows_to_read: '50000000',
      max_bytes_to_read: '4294967296',
      read_overflow_mode: 'throw',
      timeout_overflow_mode: 'throw',
      group_by_overflow_mode: 'throw',
      max_result_rows: '4097',
      max_result_bytes: '2097152',
      result_overflow_mode: 'throw',
      cancel_http_readonly_queries_on_client_close: 1,
    },
  });
  const rows = await response.json<{
    isTotal: number;
    x: number;
    y: number;
    vesselCount: string | number;
  }>();
  if (signal.aborted) throw new HeatmapQueryError('cancelled');
  const cells = rows
    .filter((row) => Number(row.isTotal) === 0)
    .map((row) => ({
      ...cellCentre(Number(row.x), Number(row.y), grid.level),
      vesselCount: Number(row.vesselCount),
    }));
  if (cells.length > HEATMAP_MAX_CELLS) throw new HeatmapQueryError('data_limit');
  return HeatmapResultSchema.parse({
    ...empty(),
    cells,
    totalVessels: Number(rows.find((row) => Number(row.isTotal) !== 0)?.vesselCount ?? 0),
  });
}

type Flight = {
  infra: Infrastructure;
  key: string;
  controller: AbortController;
  subscribers: number;
  promise: Promise<HeatmapResult>;
};
let active: Flight | undefined;
const cache = new Map<string, { infra: Infrastructure; expires: number; result: HeatmapResult }>();
function safeError(error: unknown, signal: AbortSignal): HeatmapQueryError {
  if (error instanceof HeatmapQueryError) return error;
  if (signal.aborted) return new HeatmapQueryError('cancelled');
  const code = String((error as { code?: unknown })?.code ?? '');
  return new HeatmapQueryError(
    ['158', '159', '160', '241', '307', '396', '202', '57014'].includes(code)
      ? 'data_limit'
      : 'unavailable',
  );
}
function subscribe(flight: Flight, signal?: AbortSignal): Promise<HeatmapResult> {
  flight.subscribers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      settled = true;
      signal?.removeEventListener('abort', abort);
      flight.subscribers--;
    };
    const abort = () => {
      if (settled) return;
      cleanup();
      if (flight.subscribers === 0) flight.controller.abort();
      reject(new HeatmapQueryError('cancelled'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    flight.promise.then(
      (result) => {
        if (!settled) {
          cleanup();
          resolve(structuredClone(result));
        }
      },
      (error: unknown) => {
        if (!settled) {
          cleanup();
          reject(error);
        }
      },
    );
  });
}

/** Callers authenticate on every invocation, including cache hits. Omitted owner disables reuse. */
export async function queryAisHeatmap(
  infra: Infrastructure,
  input: HeatmapQuery,
  context: HeatmapQueryContext = {},
): Promise<HeatmapResult> {
  if (context.signal?.aborted) throw new HeatmapQueryError('cancelled');
  const query = normalizeQuery(input);
  const key = JSON.stringify([context.ownerId ?? randomUUID(), query]);
  for (const [entryKey, entry] of cache) if (entry.expires <= Date.now()) cache.delete(entryKey);
  const cached = context.ownerId ? cache.get(key) : undefined;
  if (cached?.infra === infra) {
    cache.delete(key);
    cache.set(key, cached);
    return structuredClone(cached.result);
  }
  if (active) {
    if (
      context.ownerId &&
      active.infra === infra &&
      active.key === key &&
      !active.controller.signal.aborted
    )
      return subscribe(active, context.signal);
    throw new HeatmapQueryError('busy');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new HeatmapQueryError('data_limit')), 25_000);
  const flight: Flight = { infra, key, controller, subscribers: 0, promise: undefined! };
  active = flight;
  let detachAbort = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const abort = () =>
      reject(
        controller.signal.reason instanceof HeatmapQueryError
          ? controller.signal.reason
          : new HeatmapQueryError('cancelled'),
      );
    controller.signal.addEventListener('abort', abort, { once: true });
    detachAbort = () => controller.signal.removeEventListener('abort', abort);
  });
  // Subscribers may stop waiting immediately, but the slot belongs to the actual
  // database execution until its transport settles, including ignored aborts.
  const execution = execute(infra, query, controller.signal).finally(() => {
    if (active === flight) active = undefined;
  });
  flight.promise = Promise.race([execution, cancelled])
    .then((result) => {
      if (context.ownerId && !controller.signal.aborted) {
        cache.set(key, { infra, expires: Date.now() + 30_000, result });
        while (cache.size > 32) cache.delete(cache.keys().next().value!);
      }
      return result;
    })
    .catch((error: unknown) => {
      throw safeError(error, controller.signal);
    })
    .finally(() => {
      clearTimeout(timeout);
      detachAbort();
    });
  return subscribe(flight, context.signal);
}
