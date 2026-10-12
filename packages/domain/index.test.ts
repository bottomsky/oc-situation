import { describe, expect, it } from 'vitest';
import type { PositionObservation, RawEnvelope, StaticObservation } from '@ais/contracts';
import {
  cleanPosition,
  cleanStatic,
  comparePosition,
  isNewerPosition,
  selectLatestPositions,
  mergeStaticFields,
  flagPositionJump,
} from './index';

const raw: RawEnvelope = {
  schemaVersion: 1,
  captureId: 'c1',
  sourceId: 'ais1',
  sourceKind: 'aisstream',
  adapterVersion: '1',
  runId: null,
  receivedAt: '2026-09-29T06:42:13.000Z',
  sourcePriority: 200,
  payload: { kind: 'inline', value: {} },
};
const candidate = {
  mmsi: '413793000',
  observedAt: '2026-09-29T06:42:00.000Z',
  lat: 33.3,
  lon: 124.9,
};
function position(input = candidate, envelope = raw): PositionObservation {
  const result = cleanPosition(envelope, input);
  if (result.kind !== 'position') throw new Error(result.reasons.join(','));
  return result;
}
function stat(
  fields: StaticObservation['fields'],
  observedAt: string | null = candidate.observedAt,
  envelope = raw,
): StaticObservation {
  const result = cleanStatic(envelope, { mmsi: candidate.mmsi, observedAt, fields });
  if (result.kind !== 'static') throw new Error(result.reasons.join(','));
  return result;
}
describe('position cleaning', () => {
  it('marks fixture observations including quarantine as synthetic', () => {
    const fixtureRaw: RawEnvelope = { ...raw, sourceKind: 'fixture-http' };
    expect(cleanPosition(fixtureRaw, candidate).quality).toContain('synthetic');
    expect(cleanPosition(fixtureRaw, { ...candidate, mmsi: 'invalid' }).quality).toContain(
      'synthetic',
    );
  });
  it('produces stable event IDs across delivery captures and runs', () => {
    expect(position().eventId).toBe(
      position(candidate, {
        ...raw,
        captureId: 'c2',
        runId: 'replay',
        receivedAt: '2026-09-30T06:42:13.000Z',
      }).eventId,
    );
  });
  it('keeps independently sourced observations distinct', () => {
    expect(position().eventId).not.toBe(position(candidate, { ...raw, sourceId: 'ais2' }).eventId);
  });
  it('uses provider record ID before native observation content', () => {
    const a = cleanPosition(raw, { ...candidate, providerRecordId: 'provider1' });
    const b = cleanPosition(raw, { ...candidate, lat: 33.5, providerRecordId: 'provider1' });
    expect(a.eventId).toBe(b.eventId);
  });
  it('rejects missing, calendar-invalid, local, and future timestamps', () => {
    for (const observedAt of [
      undefined,
      '2026-02-30T01:00:00Z',
      '2026-09-29T06:42:00',
      '2026-09-29T06:47:14Z',
    ]) {
      expect(cleanPosition(raw, { ...candidate, observedAt }).kind).toBe('quarantine');
    }
  });
  it('accepts exactly five minutes into the future', () => {
    expect(cleanPosition(raw, { ...candidate, observedAt: '2026-09-29T06:47:13Z' }).kind).toBe(
      'position',
    );
  });
  it('flags old positions and null island without changing their timestamps', () => {
    const result = position({ ...candidate, observedAt: '2026-08-01T00:00:00Z', lat: 0, lon: 0 });
    expect(result.quality).toEqual(
      expect.arrayContaining(['outside_online_retention', 'null_island']),
    );
    expect(result.observedAt).toBe('2026-08-01T00:00:00.000Z');
  });
  it('rejects invalid MMSIs, coordinates and nonfinite optional numbers', () => {
    for (const values of [
      { mmsi: '413' },
      { mmsi: '000000000' },
      { lat: 91 },
      { lon: 181 },
      { lat: Infinity },
      { sogKnots: NaN },
    ]) {
      expect(cleanPosition(raw, { ...candidate, ...values }).kind).toBe('quarantine');
    }
  });
  it('normalizes sentinel values to null and preserves zero values', () => {
    const result = cleanPosition(raw, {
      ...candidate,
      sogKnots: 102.3,
      cogDegrees: 360,
      headingDegrees: 511,
      rotDegPerMinute: -128,
      navigationStatus: 15,
    });
    expect(result.kind).toBe('position');
    if (result.kind === 'position')
      expect([
        result.sogKnots,
        result.cogDegrees,
        result.headingDegrees,
        result.rotDegPerMinute,
        result.navigationStatus,
      ]).toEqual([null, null, null, null, null]);
    expect(cleanPosition(raw, { ...candidate, sogKnots: 0, cogDegrees: 0 }).kind).toBe('position');
  });
  it('reduces a batch using time, source priority, then stable event ID', () => {
    const older = position({ ...candidate, observedAt: '2026-09-29T06:41:00Z' });
    const low = position(candidate, { ...raw, sourceId: 'fixture', sourcePriority: 100 });
    const high = position(candidate, { ...raw, sourceId: 'mt', sourcePriority: 300 });
    expect(selectLatestPositions([high, older, low])).toEqual([high]);
    expect(comparePosition(high, low)).toBeGreaterThan(0);
    expect(isNewerPosition(high, high)).toBe(false);
    expect(isNewerPosition(high, low)).toBe(true);
    const tie = position(candidate, { ...raw, sourceId: 'tie' });
    expect(selectLatestPositions([tie, position()])).toEqual(
      selectLatestPositions([position(), tie]),
    );
  });
  it('flags a physical jump without suppressing the observation', () => {
    const first = position();
    const next = position({ ...candidate, observedAt: '2026-09-29T06:43:00Z', lat: 0, lon: 0 });
    expect(flagPositionJump(first, next).quality).toContain('implausible_jump');
    expect(flagPositionJump(first, next).eventId).toBe(next.eventId);
  });
});
describe('static field provenance', () => {
  it('marks static timestamps that are unknown rather than replacing them with receipt time', () => {
    const result = stat({ name: 'UNKNOWN TIME' }, null);
    expect(result.observedAt).toBeNull();
    expect(result.quality).toContain('unknown_observation_time');
  });
  it('cleans padding while retaining ETA with no fabricated year', () => {
    const result = cleanStatic(raw, {
      mmsi: candidate.mmsi,
      observedAt: null,
      fields: {
        name: ' TEST@@@ ',
        destination: ' PORT@@ ',
        imo: '0000000',
        eta: { month: 12, day: 31, hour: 23, minute: 59 },
      },
    });
    expect(result.kind).toBe('static');
    if (result.kind === 'static')
      expect(result.fields).toEqual({
        name: 'TEST',
        destination: 'PORT',
        eta: { month: 12, day: 31, hour: 23, minute: 59 },
      });
  });
  it('rejects invalid partial ETA dates and calendar boundary rollover', () => {
    expect(
      cleanStatic(raw, { mmsi: candidate.mmsi, fields: { eta: { month: 2, day: 30 } } }).kind,
    ).toBe('quarantine');
    expect(
      cleanStatic(raw, { mmsi: candidate.mmsi, fields: { eta: { year: 2025, month: 2, day: 29 } } })
        .kind,
    ).toBe('quarantine');
    expect(stat({ eta: { month: 2, day: 29 } }).fields.eta).toEqual({ month: 2, day: 29 });
  });
  it('preserves known newer fields and adds absent fields from unknown observations', () => {
    const first = mergeStaticFields(
      { fields: {}, provenance: {} },
      stat({ name: 'KNOWN', callsign: 'A' }),
    );
    const unknown = stat({ name: 'UNKNOWN', destination: 'PORT' }, null, {
      ...raw,
      sourcePriority: 300,
    });
    const merged = mergeStaticFields(first, unknown);
    expect(merged.fields).toEqual({ name: 'KNOWN', callsign: 'A', destination: 'PORT' });
    expect(merged.provenance.destination?.observedAt).toBeNull();
    expect(
      mergeStaticFields(merged, stat({ name: 'OLD' }, '2026-09-28T06:42:00Z')).fields.name,
    ).toBe('KNOWN');
  });
  it('uses priority and event ID for equal timestamps and never clears missing fields', () => {
    const a = stat({ name: 'AIS', callsign: 'A' });
    const b = stat({ name: 'MT' }, candidate.observedAt, {
      ...raw,
      sourceId: 'mt',
      sourcePriority: 300,
    });
    const forward = mergeStaticFields(mergeStaticFields({ fields: {}, provenance: {} }, a), b);
    const reverse = mergeStaticFields(mergeStaticFields({ fields: {}, provenance: {} }, b), a);
    expect(forward.fields).toEqual({ name: 'MT', callsign: 'A' });
    expect(forward).toEqual(reverse);
  });
});
