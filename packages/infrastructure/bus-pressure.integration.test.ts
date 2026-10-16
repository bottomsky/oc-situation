import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  assertCollectionReady,
  acquireLease,
  busHealth,
  createInfrastructure,
  createRawEnvelope,
  invalidateBusHealth,
  publishRaw,
  publishNormalized,
  runMigrations,
  seedDemo,
  type Infrastructure,
} from './index';
import { TaskCommandSchema } from '@ais/contracts';
import { runCrawl } from '../../apps/crawler/src/service';
import { createFixtureServer } from '../../tests/fixture-server/server';

const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;
const sourceId = `pressure-${randomUUID()}`;
const runId = randomUUID();
const fixture = createFixtureServer();
suite('real JetStream command pressure recovery', () => {
  let infra: Infrastructure;
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await seedDemo(infra);
    await new Promise<void>((resolve, reject) => {
      fixture.once('error', reject);
      fixture.listen(13002, '127.0.0.1', resolve);
    });
    const address = fixture.address();
    if (!address || typeof address === 'string') throw new Error('Fixture address missing');
    await infra.pool.query(
      "INSERT INTO sources(id,name,kind,enabled,status,config) VALUES($1,'pressure fixture','fixture-http',true,'enabled',$2::jsonb)",
      [
        sourceId,
        JSON.stringify({
          endpoint: `http://127.0.0.1:${address.port}/ais.json?page=2`,
          settings: { allowedHosts: ['127.0.0.1'], authorizationConfirmed: true },
        }),
      ],
    );
    await infra.pool.query(
      "INSERT INTO runs(id,source_id,status,mode) VALUES($1,$2,'queued','crawl')",
      [runId, sourceId],
    );
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    if (infra) await infra.close();
  });

  it('keeps a real delivered streaming command while rejecting expired ownership and queued work behind it', async () => {
    const streamingSource = `streaming-${randomUUID()}`;
    const streamingJob = randomUUID();
    const streamingRun = randomUUID();
    const blockerRun = randomUUID();
    const requestedAt = new Date().toISOString();
    const key = randomUUID();
    await infra.pool.query(
      "INSERT INTO sources(id,name,kind,enabled,status,config) VALUES($1,'synthetic streaming','aisstream',true,'enabled','{}')",
      [streamingSource],
    );
    await infra.pool.query(
      "INSERT INTO jobs(id,source_id,name,enabled,status,mode) VALUES($1,$2,'synthetic stream job',true,'enabled','collect')",
      [streamingJob, streamingSource],
    );
    await infra.pool.query(
      "INSERT INTO runs(id,job_id,source_id,status,mode,requested_at,idempotency_key) VALUES($1,$2,$3,'running','collect',$4,$5)",
      [streamingRun, streamingJob, streamingSource, requestedAt, key],
    );
    const lease = await acquireLease(infra, `source:${streamingSource}`, randomUUID(), 120);
    expect(lease).not.toBeNull();
    const command = TaskCommandSchema.parse({
      schemaVersion: 1,
      runId: streamingRun,
      jobId: streamingJob,
      sourceId: streamingSource,
      mode: 'collect',
      requestedAt,
      idempotencyKey: key,
    });
    await infra.js.publish('ais.commands.collect', JSON.stringify(command));
    const collector = await infra.js.consumers.get('AIS_COMMANDS', 'collector');
    const message = await collector.next({ expires: 5000 });
    expect(message).not.toBeNull();
    message!.working();
    const stream = await infra.jsm.streams.info('AIS_COMMANDS');
    const age = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(stream.state.first_ts) + 172_800_000);
    let blocker: typeof message = null;
    try {
      const healthy = await busHealth(infra);
      expect(healthy.ready).toBe(true);
      expect(healthy.streams.find((s) => s.name === 'AIS_COMMANDS')).toMatchObject({
        messages: 1,
        pendingAgeMs: 0,
        activeStreamingCommands: 1,
      });
      // The command remains durable; no premature ACK, purge or run cancellation fixes the health check.
      expect((await infra.jsm.streams.info('AIS_COMMANDS')).state.messages).toBe(1);
      await infra.pool.query(
        "INSERT INTO runs(id,source_id,status,mode) VALUES($1,$2,'queued','crawl')",
        [blockerRun, sourceId],
      );
      await infra.js.publish(
        'ais.commands.crawl',
        JSON.stringify({ ...command, runId: blockerRun, sourceId, mode: 'crawl' }),
      );
      expect((await busHealth(infra)).reasons).toContain('pressure:AIS_COMMANDS');
      const crawler = await infra.js.consumers.get('AIS_COMMANDS', 'crawler');
      blocker = await crawler.next({ expires: 5000 });
      expect(blocker).not.toBeNull();
      await infra.pool.query("UPDATE runs SET status='cancelled' WHERE id=$1", [blockerRun]);
      await blocker!.ackAck();
      blocker = null;
      expect((await busHealth(infra)).ready).toBe(true);
      await infra.pool.query(
        "UPDATE leases SET expires_at=now()-interval '1 second' WHERE name=$1",
        [lease!.name],
      );
      expect((await busHealth(infra)).reasons).toContain('pressure:AIS_COMMANDS');
      await acquireLease(infra, lease!.name, randomUUID(), 120);
      await infra.pool.query('UPDATE jobs SET enabled=false WHERE id=$1', [streamingJob]);
      expect((await busHealth(infra)).reasons).toContain('pressure:AIS_COMMANDS');
    } finally {
      age.mockRestore();
      await infra.pool.query("UPDATE runs SET status='cancelled' WHERE id=ANY($1::uuid[])", [
        [streamingRun, blockerRun],
      ]);
      if (blocker) await blocker.ackAck();
      await message?.ackAck();
      await infra.pool.query('DELETE FROM leases WHERE name=$1', [`source:${streamingSource}`]);
      invalidateBusHealth(infra);
    }
  });

  it('completes and acknowledges an aged command through the real crawler without admitting new collection', async () => {
    const command = TaskCommandSchema.parse({
      schemaVersion: 1,
      runId,
      jobId: randomUUID(),
      sourceId,
      idempotencyKey: randomUUID(),
      mode: 'crawl',
      requestedAt: new Date().toISOString(),
    });
    await infra.js.publish('ais.commands.crawl', JSON.stringify(command));
    const consumer = await infra.js.consumers.get('AIS_COMMANDS', 'crawler');
    const message = await consumer.next({ expires: 5000 });
    expect(message).not.toBeNull();
    const stream = await infra.jsm.streams.info('AIS_COMMANDS');
    const age = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(stream.state.first_ts) + 172_800_000);
    invalidateBusHealth(infra);
    await expect(assertCollectionReady(infra)).rejects.toThrow('pressure:AIS_COMMANDS');
    try {
      // Acknowledge only after the same business handler used by the worker persists success.
      const completed = await runCrawl(
        infra,
        TaskCommandSchema.parse(message!.json()),
        new AbortController().signal,
      );
      const run = await infra.pool.query(
        'SELECT status,counters,last_error FROM runs WHERE id=$1',
        [runId],
      );
      expect(run.rows[0]?.status, run.rows[0]?.last_error).toBe('succeeded');
      expect(Number(run.rows[0]?.counters.captures)).toBe(1);
      expect(completed).toBe(true);
      await message!.ackAck();
    } finally {
      age.mockRestore();
      invalidateBusHealth(infra);
    }
    expect((await infra.jsm.streams.info('AIS_COMMANDS')).state.messages).toBe(0);
    expect((await busHealth(infra)).ready).toBe(true);
  });

  it('keeps real retained RAW age pressure blocking further RAW publication', async () => {
    const retained = await createRawEnvelope(infra, {
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      adapterVersion: '1',
      runId,
      payload: { synthetic: true },
    });
    await infra.js.publish('ais.raw.pressure-fixture', JSON.stringify(retained));
    const stream = await infra.jsm.streams.info('AIS_RAW');
    expect(stream.state.messages).toBeGreaterThan(0);
    const age = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(stream.state.first_ts) + 172_800_000);
    invalidateBusHealth(infra);
    try {
      const raw = await createRawEnvelope(infra, {
        sourceId,
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        adapterVersion: '1',
        runId,
        payload: { synthetic: true },
      });
      await expect(publishRaw(infra, raw)).rejects.toThrow('pressure:AIS_RAW');
      expect((await infra.jsm.streams.info('AIS_RAW')).state.messages).toBe(stream.state.messages);
    } finally {
      age.mockRestore();
      invalidateBusHealth(infra);
    }
  });

  it('keeps real retained NORMALIZED age pressure blocking RAW publication', async () => {
    await publishNormalized(infra, {
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'static',
      eventId: randomUUID(),
      captureId: randomUUID(),
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      mmsi: '413793000',
      quality: ['synthetic'],
      fields: { name: 'SYNTHETIC PRESSURE FIXTURE' },
    });
    const stream = await infra.jsm.streams.info('AIS_NORMALIZED');
    const age = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(stream.state.first_ts) + 172_800_000);
    invalidateBusHealth(infra);
    try {
      expect((await busHealth(infra)).reasons).toContain('pressure:AIS_NORMALIZED');
      const raw = await createRawEnvelope(infra, {
        sourceId,
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        adapterVersion: '1',
        runId,
        payload: { synthetic: true },
      });
      await expect(publishRaw(infra, raw)).rejects.toThrow('pressure:AIS_NORMALIZED');
    } finally {
      age.mockRestore();
      invalidateBusHealth(infra);
    }
  });
});
