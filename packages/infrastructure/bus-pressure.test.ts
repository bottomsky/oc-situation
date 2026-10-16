import { describe, expect, it, vi } from 'vitest';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  StorageType,
  type StoredMsg,
} from '@nats-io/jetstream';
import {
  assertCollectionReady,
  createRawEnvelope,
  publishRaw,
  rawPublicationReady,
  busHealth,
  STREAMS,
  CONSUMERS,
} from './bus';
import type { Infrastructure } from './clients';

function fixture(pressureStream = 'AIS_COMMANDS', pressure = 'age') {
  const streamInfo = Object.fromEntries(
    Object.values(STREAMS).map((stream) => [
      stream.name,
      {
        config: {
          ...stream,
          storage: StorageType.File,
          discard: DiscardPolicy.New,
          max_age: 0,
          max_bytes: stream.maxBytes,
          num_replicas: 1,
        },
        state: {
          messages: stream.name === pressureStream ? 1 : 0,
          bytes: stream.name === pressureStream && pressure === 'bytes' ? stream.maxBytes : 1,
          first_ts: new Date(
            Date.now() - (stream.name === pressureStream && pressure === 'age' ? 172_800_000 : 0),
          ).toISOString(),
        },
      },
    ]),
  );
  const consumerInfo = Object.fromEntries(
    CONSUMERS.map((consumer) => [
      consumer.durable,
      {
        config: {
          filter_subject: consumer.filter,
          ack_policy: AckPolicy.Explicit,
          max_ack_pending: consumer.maxPending,
          durable_name: consumer.durable,
          deliver_policy: DeliverPolicy.All,
          ack_wait: 120_000_000_000,
          max_deliver: -1,
          max_waiting: consumer.maxPending === 1 || consumer.durable === 'collector' ? 1 : 512,
        },
      },
    ]),
  );
  const publish = vi.fn().mockResolvedValue({});
  const infra = {
    js: { publish },
    jsm: {
      streams: { info: async (name: string) => streamInfo[name] },
      consumers: { info: async (_stream: string, name: string) => consumerInfo[name] },
    },
  } as unknown as Infrastructure;
  return { infra, publish, streamInfo, consumerInfo };
}

function streamingFixture() {
  const f = fixture();
  Object.assign(f.streamInfo.AIS_COMMANDS!.state, { first_seq: 1, last_seq: 1 });
  Object.assign(f.consumerInfo.collector!, { num_ack_pending: 1, delivered: { stream_seq: 1 } });
  const command = {
    schemaVersion: 1,
    mode: 'collect',
    sourceId: 'synthetic-stream',
    runId: 'synthetic-run',
    jobId: 'synthetic-job',
    idempotencyKey: 'synthetic-key',
    requestedAt: new Date(Date.now() - 172_800_000).toISOString(),
  };
  const message = (seq: number, subject = 'ais.commands.collect') =>
    ({
      seq,
      subject,
      time: new Date(command.requestedAt),
      json: () => command,
    }) as unknown as StoredMsg;
  const messages = [message(1)];
  const get = vi.fn(
    async (_name: string, query: { seq: number }) =>
      messages.find((m) => m.seq >= query.seq) ?? null,
  );
  const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{ id: command.runId }] });
  f.infra.jsm.streams.getMessage = get;
  Object.assign(f.infra, { pool: { query } });
  return { ...f, get, query, message, messages };
}

async function raw(infra: Infrastructure) {
  return createRawEnvelope(infra, {
    sourceId: 'pressure-fixture',
    sourceKind: 'fixture-http',
    adapterVersion: '1',
    sourcePriority: 100,
    runId: null,
    payload: { synthetic: true },
  });
}

describe('RAW publication pressure boundary', () => {
  it('does not treat a leased and delivered long-lived stream as queued backlog or acknowledge it', async () => {
    const f = streamingFixture();
    Object.assign(f.streamInfo.AIS_COMMANDS!.state, { last_seq: 200 });
    const health = await busHealth(f.infra);
    expect(health.ready).toBe(true);
    expect(health.streams.find((s) => s.name === 'AIS_COMMANDS')).toMatchObject({
      oldestAgeMs: expect.any(Number),
      pendingAgeMs: 0,
      activeStreamingCommands: 1,
      messages: 1,
    });
    expect(f.get).toHaveBeenCalledWith('AIS_COMMANDS', { seq: 1, next_by_subj: 'ais.commands.*' });
    expect(f.publish).not.toHaveBeenCalled();
  });
  it('keeps an aged command behind a healthy stream blocking collection, including sequence holes', async () => {
    const f = streamingFixture();
    Object.assign(f.streamInfo.AIS_COMMANDS!.state, { last_seq: 20, messages: 2 });
    f.messages.push(f.message(20, 'ais.commands.crawl'));
    const health = await busHealth(f.infra);
    expect(health.reasons).toContain('pressure:AIS_COMMANDS');
    expect(health.streams.find((s) => s.name === 'AIS_COMMANDS')?.activeStreamingCommands).toBe(1);
    expect(f.get).toHaveBeenLastCalledWith('AIS_COMMANDS', {
      seq: 2,
      next_by_subj: 'ais.commands.*',
    });
  });
  it('does not exempt an undelivered command even when the source has a lease', async () => {
    const f = streamingFixture();
    Object.assign(f.consumerInfo.collector!, { delivered: { stream_seq: 0 } });
    expect((await busHealth(f.infra)).reasons).toContain('pressure:AIS_COMMANDS');
    expect(f.query).not.toHaveBeenCalled();
  });
  it('keeps invalid or expired run ownership and unavailable metadata fail-closed', async () => {
    const f = streamingFixture();
    f.query.mockResolvedValue({ rowCount: 0, rows: [] });
    expect((await busHealth(f.infra)).reasons).toContain('pressure:AIS_COMMANDS');
    f.query.mockRejectedValue(new Error('Database unavailable'));
    expect((await busHealth(f.infra)).reasons).toContain('pressure:AIS_COMMANDS');
    f.get.mockRejectedValue(new Error('Message metadata unavailable'));
    expect((await busHealth(f.infra)).reasons).toContain('pressure:AIS_COMMANDS');
  });
  it('retains capacity, downstream and topology protection while a streaming command is active', async () => {
    const f = streamingFixture();
    f.streamInfo.AIS_COMMANDS!.state.bytes = STREAMS.commands.maxBytes;
    expect((await busHealth(f.infra)).reasons).toContain('pressure:AIS_COMMANDS');
    expect(f.get).not.toHaveBeenCalled();
    f.streamInfo.AIS_COMMANDS!.state.bytes = 1;
    f.streamInfo.AIS_RAW!.state.bytes = STREAMS.raw.maxBytes;
    delete f.consumerInfo.replay;
    const health = await busHealth(f.infra);
    expect(health.reasons).toContain('pressure:AIS_RAW');
    expect(health.reasons).toContain('missing:consumer:replay');
  });
  it('uses the caller transaction instead of borrowing another pool connection', async () => {
    const f = streamingFixture();
    f.query.mockRejectedValue(new Error('Pool is saturated'));
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [{}] });
    expect(
      (await busHealth(f.infra, { query } as unknown as Parameters<typeof busHealth>[1])).ready,
    ).toBe(true);
    expect(f.query).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
  });
  it('lets an in-flight command publish RAW while new collection stays paused on command age', async () => {
    const f = fixture();
    await expect(assertCollectionReady(f.infra)).rejects.toThrow('pressure:AIS_COMMANDS');
    await expect(publishRaw(f.infra, await raw(f.infra))).resolves.toBeUndefined();
    expect(f.publish).toHaveBeenCalledOnce();
  });

  it.each([
    ['AIS_RAW', 'age'],
    ['AIS_RAW', 'bytes'],
    ['AIS_NORMALIZED', 'age'],
    ['AIS_NORMALIZED', 'bytes'],
  ])('keeps %s %s pressure protection when publishing RAW', async (stream, pressure) => {
    const f = fixture(stream, pressure);
    await expect(publishRaw(f.infra, await raw(f.infra))).rejects.toThrow(`pressure:${stream}`);
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('keeps missing command consumers blocking RAW publication', async () => {
    const f = fixture();
    delete f.consumerInfo.replay;
    await expect(publishRaw(f.infra, await raw(f.infra))).rejects.toThrow(
      'missing:consumer:replay',
    );
    expect(f.publish).not.toHaveBeenCalled();
  });

  it('keeps command stream topology drift blocking RAW publication', async () => {
    const f = fixture();
    f.streamInfo.AIS_COMMANDS!.config.max_age = 1;
    await expect(publishRaw(f.infra, await raw(f.infra))).rejects.toThrow(
      'drift:stream:AIS_COMMANDS',
    );
    expect(f.publish).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'paused', ready: false, reasons: [] },
    { status: 'paused', ready: false, reasons: ['pressure:unknown'] },
    { status: 'unknown', ready: true, reasons: [] },
    { status: 'ready', ready: true, reasons: ['missing:consumer:replay'] },
    { status: 'ready', ready: false, reasons: [] },
    { status: 'paused', ready: true, reasons: ['pressure:AIS_COMMANDS'] },
    { status: 'paused', ready: false, reasons: ['pressure:AIS_COMMANDS', 'unknown:health'] },
  ])('fails closed on unavailable or inconsistent health: $status/$ready/$reasons', (health) => {
    expect(
      rawPublicationReady({ ...health, streams: [] } as Awaited<ReturnType<typeof busHealth>>),
    ).toBe(false);
  });
});
