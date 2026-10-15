import { readFile } from 'node:fs/promises';
import type { Infrastructure } from './clients';

export async function runMigrations(infra: Infrastructure): Promise<void> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ais-migrations'))");
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    for (const version of [
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
      '011',
      '012',
      '013',
      '014',
      '015',
      '016',
      '017',
    ]) {
      const existing = await client.query(
        'SELECT version FROM schema_migrations WHERE version=$1',
        [version],
      );
      if (!existing.rowCount) {
        await client.query(
          await readFile(new URL(`./migrations/${version}_postgres.sql`, import.meta.url), 'utf8'),
        );
        await client.query('INSERT INTO schema_migrations(version) VALUES($1)', [version]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const version of ['001', '002']) {
    const sql = await readFile(
      new URL(`./migrations/${version}_clickhouse.sql`, import.meta.url),
      'utf8',
    );
    for (const query of sql
      .split(';')
      .map((q) => q.trim())
      .filter(Boolean))
      await infra.clickhouse.command({ query });
  }
  // Existing v1 tables contain only pre-upgrade records. One-time insert into stable-key v2 tables
  // preserves those records; repeated migration attempts are safe under ReplacingMergeTree FINAL.
  const migrated = await infra.pool.query(
    "SELECT version FROM schema_migrations WHERE version='ch-002'",
  );
  if (!migrated.rowCount) {
    await infra.clickhouse.command({
      query: `INSERT INTO static_history_v2 SELECT eventId,captureId,mmsi,sourceId,sourceKind,sourcePriority,if(JSONExtractRaw(observation,'observedAt')='null',NULL,observedAt),receivedAt,cleaningVersion,observation FROM static_history FINAL`,
    });
    await infra.clickhouse.command({
      query: `INSERT INTO quarantine_v2 SELECT eventId,captureId,sourceId,receivedAt,cleaningVersion,reasons,observation FROM quarantine FINAL`,
    });
    await infra.clickhouse.command({
      query: `INSERT INTO quality_events_v2 SELECT eventId,sourceId,observedAt,observedAt,cleaningVersion,flags FROM quality_events FINAL`,
    });
    await infra.pool.query(
      "INSERT INTO schema_migrations(version) VALUES('ch-002') ON CONFLICT DO NOTHING",
    );
  }
}
