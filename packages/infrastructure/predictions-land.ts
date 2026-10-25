import type { PredictionPath } from '../contracts/reachability';
import type { Infrastructure } from './clients';
import type { QueryResultRow } from 'pg';
export async function predictionQuery<T extends QueryResultRow = Record<string, unknown>>(
  infra: Infrastructure,
  text: string,
  values: unknown[] = [],
  signal?: AbortSignal,
  deadline = Date.now() + 15000,
) {
  signal?.throwIfAborted();
  const timeout = Math.min(15000, deadline - Date.now());
  if (timeout <= 0) throw new Error('Prediction request deadline exceeded');
  const client = await infra.pool.connect();
  let released = false;
  const abort = () => {
    if (!released) {
      released = true;
      client.release(true);
    }
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','3000ms',true)",
      [`${timeout}ms`],
    );
    const result = await client.query<T>(text, values);
    signal?.throwIfAborted();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (!released) await client.query('ROLLBACK');
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    if (!released) client.release();
  }
}

export async function activePredictionLandDataset(
  infra: Infrastructure,
  signal?: AbortSignal,
  deadline?: number,
): Promise<string | null> {
  const row = (
    await predictionQuery(
      infra,
      "SELECT d.version FROM route_datasets d WHERE d.active AND d.navigation_status='ready' AND EXISTS(SELECT 1 FROM route_land l WHERE l.dataset_version=d.version) LIMIT 1",
      [],
      signal,
      deadline,
    )
  ).rows[0];
  return row ? String(row.version) : null;
}
/** Check every original edge; continuous chunks share endpoints and preserve geodesic segments. */
export async function checkPredictionPaths(
  infra: Infrastructure,
  version: string,
  paths: PredictionPath[],
  signal?: AbortSignal,
  deadline?: number,
): Promise<boolean[]> {
  if (
    paths.length !== 2048 ||
    paths.some(
      (path) =>
        path.points.length < 2 ||
        path.points.some((point) => point.coordinate.some((value) => !Number.isFinite(value))),
    )
  )
    throw new Error('Prediction land validation requires all 2048 complete paths');
  const lines = paths.map((path, index) => {
    const coordinates = path.points.map((point) => point.coordinate);
    return {
      id: index,
      segments: Array.from({ length: Math.ceil((coordinates.length - 1) / 16) }, (_, part) => ({
        type: 'LineString',
        coordinates: coordinates.slice(part * 16, part * 16 + 17),
      })),
    };
  });
  // A crossing in any continuous block rejects its complete path. OFFSET 0 keeps
  // each small geography conversion outside the per-land-candidate intersection.
  const result = await predictionQuery(
    infra,
    `WITH paths AS MATERIALIZED (SELECT id,segments FROM jsonb_to_recordset($2::jsonb) AS x(id integer,segments jsonb)) SELECT p.id,NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p.segments) segment CROSS JOIN LATERAL (SELECT ST_SetSRID(ST_GeomFromGeoJSON(segment::text),4326)::geography line OFFSET 0) c JOIN route_land l ON l.dataset_version=$1 AND ST_Intersects(l.geog,c.line)) navigable FROM paths p ORDER BY p.id`,
    [version, JSON.stringify(lines)],
    signal,
    deadline,
  );
  if (
    result.rows.length !== paths.length ||
    result.rows.some((row, index) => Number(row.id) !== index || typeof row.navigable !== 'boolean')
  )
    throw new Error('Land check did not cover every complete prediction path');
  return result.rows.map((row) => Boolean(row.navigable));
}
