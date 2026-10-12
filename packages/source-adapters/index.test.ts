import { describe, expect, it } from 'vitest';
import type { RawEnvelope } from '@ais/contracts';
import { parseSourcePayload } from './index';
import { createHash } from 'node:crypto';

const raw = (sourceKind: RawEnvelope['sourceKind'], value: unknown): RawEnvelope => ({
  schemaVersion: 1,
  captureId: 'capture-a',
  sourceId: sourceKind,
  sourceKind,
  adapterVersion: '1',
  runId: null,
  receivedAt: '2026-09-29T07:00:00.000Z',
  sourcePriority: 100,
  payload: { kind: 'inline', value },
  checksum: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
});
const frame = {
  MessageType: 'PositionReport',
  MetaData: { MMSI: 413793000, time_utc: '2026-09-29 06:42:13.318353 +0000 UTC' },
  Message: {
    PositionReport: {
      UserID: 413793000,
      Latitude: 33,
      Longitude: 124,
      Sog: 12.3,
      Cog: 87.5,
      TrueHeading: 91,
      RateOfTurn: -20,
    },
  },
};
describe('source payload boundaries', () => {
  it('treats MT empty DATA as zero records, preserves ETA and accepts unavailable heading', () => {
    expect(parseSourcePayload(raw('marinetraffic', { DATA: [], METADATA: {} }))).toEqual([]);
    const result = parseSourcePayload(raw('marinetraffic', { DATA: [{ MMSI: '413793000', LAT: 33, LON: 124, TIMESTAMP: '2026-09-29T06:42:13Z', HEADING: -1, ETA: '2026-10-02T08:30:00Z', ROT: '12' }] }));
    expect(result[0]).toMatchObject({ kind: 'position', headingDegrees: null, rotDegPerMinute: null, quality: expect.arrayContaining(['unavailable_heading', 'unknown_rot_unit']) });
    expect(result[1]).toMatchObject({ kind: 'static', fields: { eta: { year: 2026, month: 10, day: 2, hour: 8, minute: 30 } } });
    const partial = parseSourcePayload(raw('marinetraffic', { DATA: [{ MMSI: '413793000', LAT: 33, LON: 124, TIMESTAMP: '2026-09-29T06:42:13Z', ETA: '10-02 08:30' }] }));
    expect(partial[1]).toMatchObject({ kind: 'static', fields: { eta: { month: 10, day: 2, hour: 8, minute: 30 } }, quality: expect.arrayContaining(['eta_unknown_year']) });
  });
  it('keeps decoded AIS speed and course and normalizes microsecond UTC metadata', () => {
    const [position] = parseSourcePayload(raw('aisstream', frame));
    expect(position).toMatchObject({
      kind: 'position',
      observedAt: '2026-09-29T06:42:13.318Z',
      sogKnots: 12.3,
      cogDegrees: 87.5,
    });
    if (position?.kind === 'position')
      expect(position.rotDegPerMinute).toBeCloseTo(-((20 / 4.733) ** 2));
  });
  it('quarantines seconds-only position time without capture-based identity', () => {
    const value = {
      ...frame,
      MetaData: { MMSI: 413793000 },
      Message: { PositionReport: { ...frame.Message.PositionReport, Timestamp: 12 } },
    };
    const first = raw('aisstream', value);
    const next = { ...first, captureId: 'capture-b', receivedAt: '2026-09-29T08:00:00.000Z' };
    expect(parseSourcePayload(first)[0]).toMatchObject({
      kind: 'quarantine',
      reasons: ['invalid_observed_at'],
    });
    expect(parseSourcePayload(first)[0]?.eventId).toBe(parseSourcePayload(next)[0]?.eventId);
  });
  it('converts MT v9 speeds and draught and preserves whole-degree courses', () => {
    const result = parseSourcePayload(
      raw('marinetraffic', {
        METADATA: {},
        DATA: [
          {
            MMSI: '413793000',
            LAT: '33',
            LON: '124',
            SPEED: '123',
            COURSE: '87',
            HEADING: '91',
            DRAUGHT: '85',
            SHIPNAME: 'A',
            TIMESTAMP: '2026-09-29T06:42:13Z',
          },
        ],
      }),
    );
    expect(result[0]).toMatchObject({
      kind: 'position',
      sogKnots: 12.3,
      cogDegrees: 87,
      headingDegrees: 91,
    });
    expect(result[1]).toMatchObject({ kind: 'static', fields: { draught: 8.5, name: 'A' } });
  });
  it('supports object payload references without rematerializing inline validation', () => {
    const value = {
      ...raw('aisstream', frame),
      payload: { kind: 'object' as const, bucket: 'raw', key: 'large', sha256: 'a'.repeat(64) },
    };
    expect(parseSourcePayload(value, frame)[0]?.kind).toBe('position');
  });
  it('extracts synthetic fixture JSON from HTML and records challenge quarantine', () => {
    const value = raw(
      'fixture-http',
      '<script id="ais-data" type="application/json">{"synthetic":true,"data":[{"mmsi":"413793000","lat":33,"lon":124,"observedAt":"2026-09-29T06:42:13Z"}]}</script>',
    );
    expect(parseSourcePayload(value)[0]).toMatchObject({
      kind: 'position',
      quality: ['synthetic'],
    });
    expect(
      parseSourcePayload(raw('fixture-http', '<title>Access denied</title>'))[0],
    ).toMatchObject({ kind: 'quarantine', reasons: ['missing_fixture_data'] });
  });
  it('marks encoded ROT special values unavailable and supports Class B static parts', () => {
    const value = {
      ...frame,
      Message: { PositionReport: { ...frame.Message.PositionReport, RateOfTurn: 127 } },
    };
    expect(parseSourcePayload(raw('aisstream', value))[0]).toMatchObject({
      kind: 'position',
      rotDegPerMinute: null,
      quality: ['rot_right_over_range'],
    });
    const staticFrame = {
      MessageType: 'StaticDataReport',
      MetaData: frame.MetaData,
      Message: {
        StaticDataReport: {
          UserID: 413793000,
          PartNumber: 1,
          ReportB: { CallSign: 'ABC@', ShipType: 36, Dimension: { A: 10, B: 5, C: 2, D: 3 } },
        },
      },
    };
    expect(parseSourcePayload(raw('aisstream', staticFrame))[0]).toMatchObject({
      kind: 'static',
      fields: { callsign: 'ABC', length: 15, width: 5 },
    });
  });
});
