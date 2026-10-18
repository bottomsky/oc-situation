import pg from 'pg';
import { prepareRouteDataset } from '../packages/infrastructure/route-navigation';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
try {
  const explicit = process.argv
    .find((arg) => arg.startsWith('--version='))
    ?.slice('--version='.length);
  const version =
    explicit ??
    (await pool.query('SELECT version FROM route_datasets WHERE active')).rows[0]?.version;
  if (!version) throw new Error('dataset_unavailable');
  console.log(
    JSON.stringify({
      version,
      ...(await prepareRouteDataset({ pool }, version, {
        onProgress: (checked) => console.log(JSON.stringify({ version, checked })),
      })),
    }),
  );
  if (process.argv.includes('--activate')) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('route-data-import'))");
      const state = (
        await c.query('SELECT navigation_status FROM route_datasets WHERE version=$1 FOR UPDATE', [
          version,
        ])
      ).rows[0];
      if (state?.navigation_status !== 'ready') throw new Error('dataset_unprepared');
      await c.query('UPDATE route_datasets SET active=false WHERE active');
      await c.query(
        "UPDATE route_datasets SET active=true WHERE version=$1 AND navigation_status='ready'",
        [version],
      );
      await c.query('COMMIT');
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
} finally {
  await pool.end();
}
