import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { bootstrapS3 } from './seed';
import { archiveIntelligenceRaw } from './fusion-data';
import { IntelligenceSourceSchema } from '../contracts/intelligence';
import { MarineForecastSnapshotSchema } from '../contracts/intelligence-search';
import { registerIntelligenceSources } from './intelligence-ingestion';
import {
  cleanupMarineForecasts,
  readMarineForecasts,
  saveMarineForecasts,
} from './intelligence-weather';

describe('marine snapshots and reference-aware retention', () => {
  let infra: Infrastructure;
  const sources: string[] = [],
    keys: string[] = [];
  const owner = randomUUID(),
    session = randomUUID(),
    task = randomUUID();
  const now = new Date('2026-10-13T00:00:00.000Z');
  const old = '2026-01-01T00:00:00.000Z';
  const make = async () => {
    const id = `marine-${randomUUID()}`;
    sources.push(id);
    await registerIntelligenceSources(infra, [
      IntelligenceSourceSchema.parse({
        sourceId: id,
        name: 'Marine fixture',
        kind: 'fixture',
        adapter: 'marine',
        visibility: 'public',
        enabled: false,
        pollSeconds: 3600,
      }),
    ]);
    return id;
  };
  const snapshot = async (sourceId: string, fetchedAt = old) => {
    const archive = await archiveIntelligenceRaw(
      infra,
      sourceId,
      Buffer.from(randomUUID()),
      'application/json',
    );
    keys.push(archive.archiveKey);
    await infra.pool.query('UPDATE intelligence_archives SET created_at=$2 WHERE id=$1', [
      archive.archiveId,
      fetchedAt,
    ]);
    const data = MarineForecastSnapshotSchema.parse({
      id: randomUUID(),
      sourceId,
      samplePointId: 'bohai',
      pointName: '渤海代表点',
      point: { lon: 120, lat: 39 },
      grid: { lon: 120.05, lat: 39.05 },
      fetchedAt,
      modelPublishedAt: null,
      validFrom: now.toISOString(),
      validTo: '2026-10-13T02:00:00.000Z',
      series: [0, 1, 2].map((hour) => ({
        validAt: new Date(now.getTime() + hour * 3600000).toISOString(),
        waveHeight: 1,
        waveDirection: 90,
        wavePeriod: 5,
      })),
      originalArchiveId: archive.archiveId,
      originalUrl: 'https://marine-api.open-meteo.com/v1/marine',
      visibility: 'public',
    });
    await saveMarineForecasts(infra, [data]);
    return { data, ...archive };
  };
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await bootstrapS3(infra);
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','operator')",
      [owner, `marine-${owner}`],
    );
    await infra.pool.query(
      "INSERT INTO agent_sessions(id,owner_id,title) VALUES($1,$2,'weather retention')",
      [session, owner],
    );
    await infra.pool.query(
      "INSERT INTO agent_tasks(id,session_id,owner_id,idempotency_key,request_hash,status,goal,history_hours,from_time,to_time) VALUES($1,$2,$3,$4,'fixture','completed','marine fixture',1,now()-interval '1 hour',now())",
      [task, session, owner, randomUUID()],
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    if (!infra) return;
    await infra.pool.query('DELETE FROM intelligence_weather_pins WHERE task_id=$1', [task]);
    await infra.pool.query(
      'DELETE FROM intelligence_weather_snapshots WHERE source_id=ANY($1::text[])',
      [sources],
    );
    await infra.pool.query('DELETE FROM intelligence_events WHERE source_id=ANY($1::text[])', [
      sources,
    ]);
    await infra.pool.query('DELETE FROM intelligence_archives WHERE source_id=ANY($1::text[])', [
      sources,
    ]);
    await infra.pool.query(
      'DELETE FROM intelligence_weather_archive_gc WHERE source_id=ANY($1::text[])',
      [sources],
    );
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=ANY($1::text[])', [sources]);
    await infra.pool.query('DELETE FROM agent_tasks WHERE id=$1', [task]);
    await infra.pool.query('DELETE FROM agent_sessions WHERE id=$1', [session]);
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    for (const key of keys)
      await infra.s3.send(new DeleteObjectCommand({ Bucket: infra.config.s3Bucket, Key: key }));
    await infra.close();
  });
  it('returns latest exact-point coverage, crops hours and applies current source visibility', async () => {
    const id = await make();
    await snapshot(id, '2026-10-12T22:00:00.000Z');
    const latest = await snapshot(id, '2026-10-12T23:00:00.000Z');
    const query = {
      sourceIds: [id],
      samplePointId: 'bohai',
      forecastFrom: '2026-10-13T01:00:00.000Z',
      forecastTo: '2026-10-13T02:00:00.000Z',
    };
    expect(await readMarineForecasts(infra, query, now)).toMatchObject([
      { id: latest.data.id, series: [{ validAt: query.forecastFrom }] },
    ]);
    expect((await readMarineForecasts(infra, query, now))[0]?.series).toHaveLength(1);
    expect(
      await readMarineForecasts(infra, { sourceIds: [id], bbox: [119, 37, 121, 38] }, now),
    ).toEqual([]);
    expect(
      await readMarineForecasts(
        infra,
        {
          sourceIds: [id],
          forecastFrom: '2026-10-14T00:00:00Z',
          forecastTo: '2026-10-15T00:00:00Z',
        },
        now,
      ),
    ).toEqual([]);
    await infra.pool.query(
      "UPDATE intelligence_sources SET config=jsonb_set(config,'{visibility}','\"internal\"') WHERE id=$1",
      [id],
    );
    expect((await readMarineForecasts(infra, query, now))[0]?.visibility).toBe('internal');
  });
  it('preserves pinned snapshots and raw archives referenced by a retained event', async () => {
    const id = await make();
    const pinned = await snapshot(id),
      referenced = await snapshot(id),
      expired = await snapshot(id);
    await infra.pool.query(
      'INSERT INTO intelligence_weather_pins(snapshot_id,task_id,input_revision) VALUES($1,$2,0)',
      [pinned.data.id, task],
    );
    await infra.pool.query(
      'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event) VALUES($1,$2,$1,1,now(),now(),$3::jsonb)',
      [
        randomUUID(),
        id,
        JSON.stringify({
          title: 'Retained evidence',
          summary: '',
          paragraphs: [],
          originalArchiveId: referenced.archiveId,
        }),
      ],
    );
    expect(await cleanupMarineForecasts(infra, now, id)).toEqual({
      snapshotsDeleted: 2,
      archivesDeleted: 1,
      failures: 0,
    });
    expect(
      (
        await infra.pool.query('SELECT id FROM intelligence_weather_snapshots WHERE source_id=$1', [
          id,
        ])
      ).rows,
    ).toEqual([{ id: pinned.data.id }]);
    await expect(
      infra.s3.send(
        new HeadObjectCommand({ Bucket: infra.config.s3Bucket, Key: expired.archiveKey }),
      ),
    ).rejects.toThrow();
    await expect(
      infra.s3.send(
        new HeadObjectCommand({ Bucket: infra.config.s3Bucket, Key: pinned.archiveKey }),
      ),
    ).resolves.toBeDefined();
    await expect(
      infra.s3.send(
        new HeadObjectCommand({ Bucket: infra.config.s3Bucket, Key: referenced.archiveKey }),
      ),
    ).resolves.toBeDefined();
  });
  it('resumes prepared GC after object-store failure and forbids late references', async () => {
    const id = await make();
    const expired = await snapshot(id);
    const spy = vi
      .spyOn(infra.s3, 'send')
      .mockRejectedValueOnce(new Error('synthetic delete outage'));
    expect(await cleanupMarineForecasts(infra, now, id)).toEqual({
      snapshotsDeleted: 1,
      archivesDeleted: 0,
      failures: 1,
    });
    spy.mockRestore();
    expect(
      (
        await infra.pool.query(
          'SELECT status,attempts FROM intelligence_weather_archive_gc WHERE archive_id=$1',
          [expired.archiveId],
        )
      ).rows[0],
    ).toEqual({ status: 'prepared', attempts: 1 });
    await expect(saveMarineForecasts(infra, [expired.data])).rejects.toThrow('reserved');
    await expect(
      infra.pool.query(
        'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event) VALUES($1,$2,$1,1,now(),now(),$3::jsonb)',
        [
          randomUUID(),
          id,
          JSON.stringify({ title: 'Late evidence', originalArchiveId: expired.archiveId }),
        ],
      ),
    ).rejects.toThrow();
    expect(await cleanupMarineForecasts(infra, now, id)).toEqual({
      snapshotsDeleted: 0,
      archivesDeleted: 1,
      failures: 0,
    });
    expect(
      (
        await infra.pool.query(
          'SELECT status,attempts FROM intelligence_weather_archive_gc WHERE archive_id=$1',
          [expired.archiveId],
        )
      ).rows[0],
    ).toEqual({ status: 'deleted', attempts: 2 });
  });
  it('does not clean a source while a collector holds its lock', async () => {
    const id = await make();
    await snapshot(id);
    const client = await infra.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [`intelligence:${id}`]);
      expect(await cleanupMarineForecasts(infra, now, id)).toEqual({
        snapshotsDeleted: 0,
        archivesDeleted: 0,
        failures: 0,
      });
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
        `intelligence:${id}`,
      ]);
      client.release();
    }
  });
});
