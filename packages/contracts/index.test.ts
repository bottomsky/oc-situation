import { describe, expect, it } from 'vitest';
import {
  RawEnvelopeSchema,
  UtcTimestampSchema,
  NormalizedObservationSchema,
  SourceConfigSchema,
} from './index';

describe('shared boundary schemas', () => {
  it('keeps source secrets outside config and bounds crawler settings', () => {
    const source = {
      sourceId: 'f',
      sourceKind: 'fixture-http',
      name: 'Fixture',
      status: 'enabled',
      secretRef: null,
      priority: 100,
      settings: { allowedHosts: ['localhost'] },
    };
    expect(SourceConfigSchema.parse(source).settings?.requestsPerMinute).toBe(30);
    expect(SourceConfigSchema.safeParse({ ...source, apiKey: 'secret' }).success).toBe(false);
    expect(
      SourceConfigSchema.safeParse({ ...source, settings: { apiKey: 'secret' } }).success,
    ).toBe(false);
    expect(
      SourceConfigSchema.safeParse({ ...source, settings: { allowedHosts: ['*.example.com'] } })
        .success,
    ).toBe(false);
    expect(
      SourceConfigSchema.safeParse({ ...source, settings: { browserConcurrency: 3 } }).success,
    ).toBe(false);
  });
  it('requires a complete valid UTC timestamp', () => {
    for (const value of [
      '2026-02-30T01:00:00Z',
      '2026-09-29',
      '2026-09-29T06:42:00',
      '2026-09-29T06:42:00+08:00',
    ]) {
      expect(UtcTimestampSchema.safeParse(value).success).toBe(false);
    }
    expect(UtcTimestampSchema.safeParse('2026-09-29T06:42:00.000Z').success).toBe(true);
  });
  it('bounds inline payload and rejects unexpected secret-bearing fields', () => {
    const raw = {
      schemaVersion: 1,
      captureId: 'capture',
      sourceId: 'fixture',
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      runId: null,
      receivedAt: '2026-09-29T06:42:00Z',
      sourcePriority: 100,
      payload: { kind: 'inline', value: {} },
    };
    expect(RawEnvelopeSchema.safeParse(raw).success).toBe(true);
    expect(RawEnvelopeSchema.safeParse({ ...raw, apiKey: 'secret' }).success).toBe(false);
    expect(
      RawEnvelopeSchema.safeParse({
        ...raw,
        payload: { kind: 'inline', value: 'x'.repeat(1_048_577) },
      }).success,
    ).toBe(false);
  });
  it('allows a quarantine record without a usable MMSI', () => {
    expect(
      NormalizedObservationSchema.safeParse({
        schemaVersion: 1,
        cleaningVersion: 1,
        kind: 'quarantine',
        eventId: 'e',
        captureId: 'c',
        sourceId: 'f',
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        runId: null,
        observedAt: null,
        receivedAt: '2026-09-29T06:42:00Z',
        quality: [],
        mmsi: null,
        reasons: ['invalid_mmsi'],
      }).success,
    ).toBe(true);
  });
});
