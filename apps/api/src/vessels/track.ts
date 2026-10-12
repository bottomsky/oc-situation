import type { PositionObservation, TrackResponse } from '@ais/contracts';
export function buildTrack(
  mmsi: string,
  from: string,
  to: string,
  points: PositionObservation[],
  max: number,
): TrackResponse {
  const eventIds = new Map<string, PositionObservation>();
  for (const point of points) {
    const prior = eventIds.get(point.eventId);
    if (!prior || point.cleaningVersion > prior.cleaningVersion) eventIds.set(point.eventId, point);
  }
  const byTime = new Map<string, PositionObservation>();
  for (const point of eventIds.values()) {
    const timestamp = new Date(point.observedAt).toISOString();
    const prior = byTime.get(timestamp);
    if (
      !prior ||
      point.sourcePriority > prior.sourcePriority ||
      (point.sourcePriority === prior.sourcePriority && point.eventId > prior.eventId)
    )
      byTime.set(timestamp, point);
  }
  const sorted = [...byTime.values()].sort(
    (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
  );
  const segments: { points: PositionObservation[] }[] = [];
  for (const point of sorted) {
    const previous = segments.at(-1)?.points.at(-1);
    if (
      !previous ||
      Date.parse(point.observedAt) - Date.parse(previous.observedAt) > 30 * 60 * 1000 ||
      Math.abs(point.lon - previous.lon) > 180
    )
      segments.push({ points: [] });
    segments.at(-1)!.points.push(point);
  }
  const total = sorted.length;
  let returned = 0;
  const minimum = segments.reduce((sum, s) => sum + Math.min(2, s.points.length), 0);
  let budget = Math.max(0, max - minimum);
  const interior = total - minimum;
  const result = segments
    .map((segment, index) => {
      if (minimum > max) {
        const room = Math.max(0, max - returned);
        const selected =
          segment.points.length === 1 && room >= 1
            ? segment.points
            : room >= 2
              ? [segment.points[0]!, segment.points.at(-1)!]
              : [];
        returned += selected.length;
        return { points: selected };
      }
      const extra =
        index === segments.length - 1
          ? budget
          : Math.min(
              budget,
              Math.floor(
                ((max - minimum) * Math.max(0, segment.points.length - 2)) / Math.max(1, interior),
              ),
            );
      budget -= extra;
      const size = Math.min(segment.points.length, Math.min(2, segment.points.length) + extra);
      const selected =
        size >= segment.points.length
          ? segment.points
          : Array.from(
              { length: size },
              (_, i) => segment.points[Math.round((i * (segment.points.length - 1)) / (size - 1))]!,
            );
      returned += selected.length;
      return { points: selected };
    })
    .filter((s) => s.points.length);
  return {
    mmsi,
    from,
    to,
    segments: result,
    sampled: returned < total,
    truncated: minimum > max,
    total,
    returned,
  };
}
