import { describe, expect, it } from 'vitest';
import { processRaw, type ProcessorPorts } from './process';
import type { QuarantineObservation, RawEnvelope } from '@ais/contracts';
const raw: RawEnvelope = {
  schemaVersion: 1,
  captureId: 'c',
  sourceId: 'f',
  sourceKind: 'fixture-http',
  adapterVersion: '1',
  runId: null,
  receivedAt: '2026-10-01T00:00:00Z',
  sourcePriority: 100,
  payload: { kind: 'inline', value: {} },
};
const q: QuarantineObservation = {
  schemaVersion: 1,
  cleaningVersion: 1,
  eventId: 'e',
  captureId: 'c',
  sourceId: 'f',
  sourceKind: 'fixture-http',
  sourcePriority: 100,
  runId: null,
  receivedAt: raw.receivedAt,
  observedAt: null,
  kind: 'quarantine',
  mmsi: null,
  quality: [],
  reasons: ['invalid_mmsi'],
};
describe('processor acknowledgment boundary', () => {
  it('waits for every normalized publish before acknowledging the raw capture', async () => {
    const events: string[] = [];
    const ports: ProcessorPorts = {
      async load() {
        return {};
      },
      parse() {
        return [q, { ...q, eventId: 'e2' }];
      },
      async publish(o) {
        events.push(o.eventId);
      },
    };
    await processRaw(ports, raw, () => events.push('ack'));
    expect(events).toEqual(['e', 'e2', 'ack']);
  });
  it('leaves raw unacknowledged when normalized publish fails', async () => {
    let ack = false;
    const ports: ProcessorPorts = {
      async load() {
        return {};
      },
      parse() {
        return [q];
      },
      async publish() {
        throw new Error('NATS connection');
      },
    };
    await expect(
      processRaw(ports, raw, () => {
        ack = true;
      }),
    ).rejects.toThrow('NATS connection');
    expect(ack).toBe(false);
  });
  it('quarantines parser failure with a stable ID and retains the raw capture reference', async () => {
    const emitted: QuarantineObservation[] = [];
    const ports: ProcessorPorts = {
      async load() {
        return {};
      },
      parse() {
        throw new Error('shape changed');
      },
      async publish(o) {
        emitted.push(o as QuarantineObservation);
      },
    };
    await processRaw(ports, raw, () => {});
    await processRaw(ports, raw, () => {});
    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.kind).toBe('quarantine');
    expect(emitted[0]?.eventId).toBe(emitted[1]?.eventId);
    expect(emitted[0]?.captureId).toBe(raw.captureId);
  });
  it('retries storage outages rather than treating them as parser errors', async () => {
    const emitted: unknown[] = [];
    let ack = false;
    const ports: ProcessorPorts = {
      async load() {
        throw new Error('S3 outage');
      },
      parse() {
        return [];
      },
      async publish(o) {
        emitted.push(o);
      },
    };
    await expect(
      processRaw(ports, raw, () => {
        ack = true;
      }),
    ).rejects.toThrow('S3 outage');
    expect(emitted).toEqual([]);
    expect(ack).toBe(false);
  });
});
