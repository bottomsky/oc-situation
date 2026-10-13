import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  MarineForecastSnapshotSchema,
  IntelligenceSearchSpecSchema,
  type MarineForecastSnapshot,
  type IntelligenceSearchSpec,
} from '../contracts/intelligence-search';
import type { Infrastructure } from './clients';

export async function saveMarineForecasts(
  infra: Infrastructure,
  snapshots: readonly MarineForecastSnapshot[],
) {
  let imported = 0;
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    for (const raw of snapshots) {
      const snapshot = MarineForecastSnapshotSchema.parse(raw);
      const archive = await client.query(
        'SELECT id FROM intelligence_archives WHERE id=$1 AND source_id=$2 FOR KEY SHARE',
        [snapshot.originalArchiveId, snapshot.sourceId],
      );
      if (!archive.rowCount) throw new Error('Marine archive does not belong to registered source');
      const gc = await client.query(
        'SELECT archive_id FROM intelligence_weather_archive_gc WHERE archive_id=$1',
        [snapshot.originalArchiveId],
      );
      if (gc.rowCount) throw new Error('Marine archive is reserved for retention cleanup');
      imported +=
        (
          await client.query(
            `INSERT INTO intelligence_weather_snapshots(id,source_id,point_id,fetched_at,valid_from,valid_to,archive_id,data)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(id) DO NOTHING`,
            [
              snapshot.id,
              snapshot.sourceId,
              snapshot.samplePointId,
              snapshot.fetchedAt,
              snapshot.validFrom,
              snapshot.validTo,
              snapshot.originalArchiveId,
              JSON.stringify(snapshot),
            ],
          )
        ).rowCount ?? 0;
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return { imported, unchanged: snapshots.length - imported };
}

export async function readMarineForecasts(
  infra: Infrastructure,
  input: IntelligenceSearchSpec,
  now = new Date(),
): Promise<MarineForecastSnapshot[]> {
  const spec = IntelligenceSearchSpecSchema.parse(input);
  if (
    spec.kind === 'events' ||
    (spec.category && spec.category !== 'weather') ||
    spec.objectId ||
    spec.mmsis?.length
  )
    return [];
  if (spec.sourceIds && !spec.sourceIds.length) return [];
  const from = Date.parse(spec.forecastFrom ?? now.toISOString());
  const to = Date.parse(spec.forecastTo ?? new Date(from + 72 * 3600_000).toISOString());
  const rows = await infra.pool.query(
    `SELECT DISTINCT ON (w.source_id,w.point_id) w.data,s.config FROM intelligence_weather_snapshots w
    JOIN intelligence_sources s ON s.id=w.source_id WHERE w.fetched_at<=$1
    AND ($2::text[] IS NULL OR w.source_id=ANY($2)) AND ($3::text IS NULL OR w.point_id=$3)
    ORDER BY w.source_id,w.point_id,w.fetched_at DESC,w.id DESC`,
    [now.toISOString(), spec.sourceIds ?? null, spec.samplePointId ?? null],
  );
  const result: MarineForecastSnapshot[] = [];
  for (const row of rows.rows) {
    const snapshot = MarineForecastSnapshotSchema.parse(row.data);
    if (spec.bbox) {
      const [west, south, east, north] = spec.bbox;
      const { lon, lat } = snapshot.point;
      if (
        lat < south ||
        lat > north ||
        (west <= east ? lon < west || lon > east : lon < west && lon > east)
      )
        continue;
    }
    const series = snapshot.series.filter(
      (hour) => Date.parse(hour.validAt) >= from && Date.parse(hour.validAt) < to,
    );
    if (!series.length) continue;
    result.push({
      ...snapshot,
      visibility: row.config.visibility === 'public' ? 'public' : 'internal',
      validFrom: series[0]!.validAt,
      validTo: series.at(-1)!.validAt,
      series,
    });
  }
  return result.slice(0, 20);
}

const unreferenced = `NOT EXISTS(SELECT 1 FROM intelligence_weather_snapshots w WHERE w.archive_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM intelligence_events e WHERE e.event->>'originalArchiveId'=a.id OR e.event->>'archiveKey'=a.object_key)`;
/** S3 deletion is replayable from a durable prepared ledger; collection shares the same source lock. */
export async function cleanupMarineForecasts(
  infra: Infrastructure,
  now = new Date(),
  sourceId?: string,
) {
  const cleanupSignal = AbortSignal.timeout(30_000);
  const cutoff = new Date(now.getTime() - 90 * 86400_000).toISOString();
  const sources = (
    await infra.pool.query(
      "SELECT id FROM intelligence_sources WHERE config->>'adapter'='marine' AND ($1::text IS NULL OR id=$1) ORDER BY id",
      [sourceId ?? null],
    )
  ).rows;
  const stats = { snapshotsDeleted: 0, archivesDeleted: 0, failures: 0 };
  for (const source of sources) {
    const client = await infra.pool.connect();
    let locked = false;
    try {
      locked = Boolean(
        (
          await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired', [
            `intelligence:${source.id}`,
          ])
        ).rows[0].acquired,
      );
      if (!locked) continue;
      await client.query('BEGIN');
      try {
        stats.snapshotsDeleted +=
          (
            await client.query(
              `DELETE FROM intelligence_weather_snapshots w WHERE source_id=$1 AND fetched_at<$2
          AND NOT EXISTS(SELECT 1 FROM intelligence_weather_pins p WHERE p.snapshot_id=w.id)`,
              [source.id, cutoff],
            )
          ).rowCount ?? 0;
        // The event trigger and snapshot inserts take a shared archive lock. This
        // separate statement establishes a fresh reference snapshot after waiting.
        await client.query(
          'SELECT id FROM intelligence_archives WHERE source_id=$1 AND created_at<$2 ORDER BY id FOR UPDATE',
          [source.id, cutoff],
        );
        await client.query(
          `INSERT INTO intelligence_weather_archive_gc(archive_id,source_id,object_key,status)
          SELECT a.id,a.source_id,a.object_key,'prepared' FROM intelligence_archives a WHERE a.source_id=$1 AND a.created_at<$2 AND ${unreferenced}
          ON CONFLICT(archive_id) DO NOTHING`,
          [source.id, cutoff],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      const candidates = (
        await client.query(
          "SELECT * FROM intelligence_weather_archive_gc WHERE source_id=$1 AND status='prepared' ORDER BY prepared_at LIMIT 100",
          [source.id],
        )
      ).rows;
      for (const candidate of candidates) {
        if (cleanupSignal.aborted) break;
        const safe = await client.query(
          `SELECT a.id FROM intelligence_archives a WHERE a.id=$1 AND ${unreferenced}`,
          [candidate.archive_id],
        );
        const existing = await client.query('SELECT id FROM intelligence_archives WHERE id=$1', [
          candidate.archive_id,
        ]);
        if (existing.rowCount && !safe.rowCount) {
          await client.query('DELETE FROM intelligence_weather_archive_gc WHERE archive_id=$1', [
            candidate.archive_id,
          ]);
          continue;
        }
        await client.query(
          'UPDATE intelligence_weather_archive_gc SET attempts=attempts+1 WHERE archive_id=$1',
          [candidate.archive_id],
        );
        try {
          await infra.s3.send(
            new DeleteObjectCommand({ Bucket: infra.config.s3Bucket, Key: candidate.object_key }),
            { abortSignal: cleanupSignal },
          );
          await client.query('BEGIN');
          try {
            await client.query('DELETE FROM intelligence_archives WHERE id=$1', [
              candidate.archive_id,
            ]);
            await client.query(
              "UPDATE intelligence_weather_archive_gc SET status='deleted',deleted_at=now(),last_error=NULL WHERE archive_id=$1",
              [candidate.archive_id],
            );
            await client.query('COMMIT');
          } catch (error) {
            await client.query('ROLLBACK');
            throw error;
          }
          stats.archivesDeleted++;
        } catch {
          stats.failures++;
          await client.query(
            "UPDATE intelligence_weather_archive_gc SET last_error='archive_cleanup_failed' WHERE archive_id=$1",
            [candidate.archive_id],
          );
        }
      }
    } finally {
      if (locked)
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          `intelligence:${source.id}`,
        ]);
      client.release();
    }
  }
  return stats;
}
