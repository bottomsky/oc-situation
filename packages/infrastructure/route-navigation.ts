import type { RouteInfrastructure } from './routes';
const canalGates = [
  [32.1, 29.5, 32.7, 31.5],
  [-80.2, 8.7, -79.3, 9.6],
  [9, 53.8, 10.3, 54.6],
  [22.8, 37.8, 23.2, 38.1],
];
export function routePassageTest(expression: string) {
  return `(${canalGates.map((b) => `ST_Intersects(${expression},ST_MakeEnvelope(${b.join(',')},4326)::geography)`).join(' OR ')} OR ST_YMax(ST_Segmentize(${expression},10000)::geometry)>66.5)`;
}
/** $1 is the immutable dataset version. Always re-used by connectors and final validation. */
export function routeBaseObstacleTest(expression: string) {
  return `(${routePassageTest(expression)} OR EXISTS(SELECT 1 FROM route_land l WHERE l.dataset_version=$1 AND ST_Intersects(l.geog,${expression})))`;
}
/** Explicit, resumable dataset preparation. Requests consume only ready datasets. */
export async function prepareRouteDataset(
  infra: RouteInfrastructure,
  version: string,
  options: { batchSize?: number; onProgress?: (checked: number) => void } = {},
) {
  const client = await infra.pool.connect();
  let locked = false;
  const lock = `route-prepare:${version}`;
  try {
    locked = (
      await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked', [lock])
    ).rows[0].locked;
    if (!locked) throw new Error('dataset_preparation_in_progress');
    const dataset = (await client.query('SELECT * FROM route_datasets WHERE version=$1', [version]))
      .rows[0];
    if (!dataset) throw new Error('dataset_unavailable');
    if (dataset.navigation_status === 'ready') {
      return (
        await client.query(
          `SELECT count(*)::int AS edges,count(*) FILTER(WHERE base_navigable)::int AS navigable FROM route_edges WHERE dataset_version=$1`,
          [version],
        )
      ).rows[0] as { edges: number; navigable: number };
    }
    const counts = (
      await client.query(
        `SELECT
      (SELECT count(*) FROM route_edges WHERE dataset_version=$1) edges,
      (SELECT count(*) FROM route_land WHERE dataset_version=$1) land`,
        [version],
      )
    ).rows[0];
    if (!Number(counts.edges) || !Number(counts.land)) throw new Error('dataset_unavailable');
    await client.query(
      "UPDATE route_datasets SET navigation_status='preparing',navigation_error=NULL WHERE version=$1",
      [version],
    );
    const batchSize = options.batchSize ?? 1000;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10000)
      throw new Error('invalid_batch_size');
    for (;;) {
      await client.query('BEGIN');
      try {
        const updated = await client.query(
          `UPDATE route_edges e SET base_navigable = channel='open' AND NOT ${routeBaseObstacleTest('e.geog')}
          WHERE e.id IN (SELECT id FROM route_edges WHERE dataset_version=$1 AND base_navigable IS NULL ORDER BY id LIMIT $2)`,
          [version, batchSize],
        );
        const progress = (
          await client.query(
            `UPDATE route_datasets SET navigation_checked_edges=(SELECT count(*) FROM route_edges WHERE dataset_version=$1 AND base_navigable IS NOT NULL) WHERE version=$1 RETURNING navigation_checked_edges`,
            [version],
          )
        ).rows[0];
        await client.query('COMMIT');
        options.onProgress?.(Number(progress.navigation_checked_edges));
        if (!updated.rowCount) break;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    await client.query(
      "UPDATE route_datasets SET navigation_status='ready',navigation_prepared_at=now(),navigation_error=NULL WHERE version=$1",
      [version],
    );
    return (
      await client.query(
        `SELECT count(*)::int AS edges,count(*) FILTER(WHERE base_navigable)::int AS navigable FROM route_edges WHERE dataset_version=$1`,
        [version],
      )
    ).rows[0] as { edges: number; navigable: number };
  } catch (error) {
    if (locked)
      await client.query(
        "UPDATE route_datasets SET navigation_status='failed',navigation_error=$2 WHERE version=$1",
        [version, String(error).slice(0, 2000)],
      );
    throw error;
  } finally {
    let destroy = false;
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [lock]);
    } catch {
      destroy = true;
    }
    client.release(destroy);
  }
}
