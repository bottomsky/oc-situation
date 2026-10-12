import { describe, expect, it, vi } from 'vitest';
import { AckPolicy, DeliverPolicy, DiscardPolicy, StorageType } from '@nats-io/jetstream';
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
