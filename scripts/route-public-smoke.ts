import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createRoutePlan, getRoutePlan } from '../packages/infrastructure/routes';
import { executeRoutePlan } from '../packages/infrastructure/route-planning';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const actor = { id: randomUUID(), role: 'operator' };
const reports: unknown[] = [];
let allValidated = true;
try {
  await pool.query(
    "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','operator')",
    [actor.id, `public-smoke-${actor.id}`],
  );
  for (const [name, waypoints] of [
    [
      'east-china-sea',
      [
        [122, 29],
        [123, 30],
      ],
    ],
    [
      'around-taiwan',
      [
        [119.5, 24],
        [123, 24],
      ],
    ],
    [
      'date-line',
      [
        [179, 20],
        [-179, 20],
      ],
    ],
  ] as const) {
    const start = Date.now();
    const plan = await createRoutePlan({ pool }, actor, { operationId: randomUUID(), waypoints });
    await executeRoutePlan({ pool }, plan.id);
    const result = await getRoutePlan({ pool }, plan.id);
    const planningElapsedMs = Date.now() - start;
    let spatial: unknown = null;
    if (result?.result)
      spatial = (
        await pool.query(
          `SELECT
      EXISTS(SELECT 1 FROM route_land WHERE dataset_version=$1 AND ST_Intersects(geog,ST_GeomFromGeoJSON($5)::geography)) direct_land_intersection,
      EXISTS(SELECT 1 FROM route_land WHERE dataset_version=$1 AND ST_Intersects(geog,ST_GeomFromGeoJSON($2)::geography)) land_intersection,
      EXISTS(SELECT 1 FROM (SELECT DISTINCT ON(id) * FROM route_restrictions WHERE version<=$3 ORDER BY id,revision DESC) r WHERE enabled AND valid_from<=$4 AND (valid_until IS NULL OR valid_until>$4) AND ST_Intersects(geog,ST_GeomFromGeoJSON($2)::geography)) restriction_intersection`,
          [
            result.datasetVersion,
            JSON.stringify(result.result.geometry),
            result.restrictionVersion,
            result.createdAt,
            JSON.stringify({ type: 'LineString', coordinates: waypoints }),
          ],
        )
      ).rows[0];
    const checks = spatial as {
      land_intersection?: boolean;
      restriction_intersection?: boolean;
      direct_land_intersection?: boolean;
    } | null;
    const validated =
      result?.status === 'completed' &&
      checks?.land_intersection === false &&
      checks?.restriction_intersection === false &&
      (name !== 'around-taiwan' || checks?.direct_land_intersection === true);
    allValidated &&= validated;
    const report = {
      validated,
      name,
      planningElapsedMs,
      elapsedMs: Date.now() - start,
      status: result?.status,
      error: result?.error,
      datasetVersion: result?.datasetVersion,
      points: result?.result?.geometry.coordinates.length,
      lengthMeters: result?.result?.lengthMeters,
      spatial,
    };
    if (result?.result)
      await writeFile(
        `.data/routes/public-smoke-${name}.geojson`,
        JSON.stringify(
          { type: 'Feature', geometry: result.result.geometry, properties: report },
          null,
          2,
        ) + '\n',
      );
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  await writeFile('.data/routes/public-smoke-report.json', JSON.stringify(reports, null, 2) + '\n');
  if (!allValidated) throw new Error('Public route smoke failed; inspect public-smoke-report.json');
} finally {
  await pool.query('DELETE FROM route_plans WHERE user_id=$1', [actor.id]);
  await pool.query('DELETE FROM route_operation_receipts WHERE user_id=$1', [actor.id]);
  await pool.query('DELETE FROM audit WHERE user_id=$1', [actor.id]);
  await pool.query('DELETE FROM users WHERE id=$1', [actor.id]);
  await pool.end();
}
