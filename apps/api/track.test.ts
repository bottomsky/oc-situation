import { expect, it } from 'vitest';
import type { PositionObservation } from '@ais/contracts';
import { buildTrack } from './src/vessels/track';
const point = (time: string, lon: number, eventId: string, priority = 1): PositionObservation => ({
  schemaVersion: 1,
  cleaningVersion: 1,
  kind: 'position',
  eventId,
  captureId: eventId,
  mmsi: '123456789',
  sourceId: 'test',
  sourceKind: 'fixture-http',
  sourcePriority: priority,
  runId: null,
  receivedAt: time,
  observedAt: time,
  lat: 0,
  lon,
  sogKnots: null,
  cogDegrees: null,
  headingDegrees: null,
  rotDegPerMinute: null,
  navigationStatus: null,
  receptionType: 'TER',
  quality: [],
});
it('selects same-time stable priority, preserves native records, and splits gaps and date line', () => {
  const points = [
    point('2026-10-01T00:00:00Z', 179, 'a'),
    point('2026-10-01T00:00:00Z', 178, 'b', 2),
    point('2026-10-01T00:01:00Z', -179, 'c'),
    point('2026-10-01T01:01:00Z', -178, 'd'),
  ];
  const result = buildTrack(
    '123456789',
    '2026-10-01T00:00:00Z',
    '2026-10-01T02:00:00Z',
    points,
    5000,
  );
  expect(result.segments.map((s) => s.points.map((p) => p.eventId))).toEqual([['b'], ['c'], ['d']]);
  expect(result.total).toBe(3);
});
it('samples long continuous segments while retaining first and last endpoints', () => {
  const points = Array.from({ length: 100 }, (_, i) =>
    point(new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(), i / 100, String(i)),
  );
  const result = buildTrack('123456789', points[0]!.observedAt, points[99]!.observedAt, points, 10);
  expect(result.sampled).toBe(true);
  expect(result.segments[0]!.points).toHaveLength(10);
  expect(result.segments[0]!.points[0]!.eventId).toBe('0');
  expect(result.segments[0]!.points.at(-1)!.eventId).toBe('99');
});
