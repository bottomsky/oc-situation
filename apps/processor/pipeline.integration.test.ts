import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createInfrastructure,
  runMigrations,
  seedDemo,
  createRawEnvelope,
  publishRaw,
  readArchive,
  toCamelRow,
} from '@ais/infrastructure';
import { runProcessor } from './index';
import { runWriter } from '../writer/index';
import { runArchiver } from '../archiver/index';
const integration = process.env.AIS_TEST_SCOPE === 'integration';
const test = integration ? it : it.skip;
async function eventually(check: () => Promise<boolean>, seconds = 20) {
  const limit = Date.now() + seconds * 1000;
  while (Date.now() < limit) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for pipeline persistence');
}
test('transports one raw response through JetStream cleaner and both writers, quarantines bad rows and commits S3 archive', async () => {
  const infra = await createInfrastructure();
  const controller = new AbortController();
  const sourceId = `pipeline-${randomUUID()}`;
  const mmsi = String(980_000_000 + Math.floor(Math.random() * 9_000_000));
  const now = new Date().toISOString();
  await runMigrations(infra);
  await seedDemo(infra);
  const failures: unknown[] = [];
  const workers = [
    runProcessor(infra, controller.signal),
    runWriter(infra, 'postgres', controller.signal),
    runWriter(infra, 'clickhouse', controller.signal),
    runArchiver(infra, controller.signal),
  ].map((worker) =>
    worker.catch((error: unknown) => {
      failures.push(error);
      controller.abort();
    }),
  );
  try {
    const raw = await createRawEnvelope(infra, {
      sourceId,
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      sourcePriority: 100,
      runId: null,
      payload: {
        data: [
          {
            mmsi,
            lat: 24.43,
            lon: 118.12,
            observedAt: now,
            sogKnots: 12,
            fields: { name: '集成样例船' },
          },
          { mmsi: 'invalid', lat: 91, lon: 118, observedAt: now },
        ],
      },
    });
    await publishRaw(infra, raw);
    await eventually(
      async () =>
        (await infra.pool.query('SELECT event_id FROM positions_latest WHERE mmsi=$1', [mmsi]))
          .rowCount === 1,
    );
    await eventually(async () => {
      const response = await infra.clickhouse.query({
        query: 'SELECT count() AS count FROM positions FINAL WHERE sourceId={sourceId:String}',
        query_params: { sourceId },
        format: 'JSONEachRow',
      });
      return Number((await response.json<{ count: number }>())[0]?.count) === 1;
    });
    await eventually(async () => {
      const response = await infra.clickhouse.query({
        query: 'SELECT count() AS count FROM quarantine_v2 FINAL WHERE sourceId={sourceId:String}',
        query_params: { sourceId },
        format: 'JSONEachRow',
      });
      return Number((await response.json<{ count: number }>())[0]?.count) === 1;
    });
    controller.abort();
    await Promise.all(workers);
    expect(failures).toEqual([]);
    await infra.nc.flush();
    const manifests = await infra.pool.query(
      "SELECT * FROM archive_batches WHERE source_id=$1 AND status='committed'",
      [sourceId],
    );
    expect(manifests.rowCount).toBe(1);
    expect(manifests.rows[0]?.count).toBe(1);
    const archived = await readArchive(infra, toCamelRow(manifests.rows[0]));
    expect(archived[0]).toEqual(raw);
    const latest = await infra.pool.query(
      'SELECT observation FROM positions_latest WHERE mmsi=$1',
      [mmsi],
    );
    expect(latest.rows[0]?.observation.quality).toContain('synthetic');
  } finally {
    controller.abort();
    await Promise.allSettled(workers);
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM field_provenance WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
    await infra.close();
  }
}, 60_000);
