import {
  NavigationWarningSchema,
  type NavigationWarning,
  type NavigationWarningImpact,
  type PredictionArea,
  type PredictionCoordinate,
  type ReachabilityPrediction,
} from '../contracts/reachability';

const wrap = (n: number) => ((n + 540) % 360) - 180;
const EPS = 1e-10;
function unwrapped(ring: PredictionCoordinate[], reference: number): PredictionCoordinate[] {
  let previous = reference;
  return ring.map(([lon, lat]) => {
    const next = previous + wrap(lon - previous);
    previous = next;
    return [next, lat];
  });
}
function ringContains(point: PredictionCoordinate, ring: PredictionCoordinate[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]!,
      b = ring[i]!;
    const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    if (
      Math.abs(cross) < EPS &&
      point[0] >= Math.min(a[0], b[0]) - EPS &&
      point[0] <= Math.max(a[0], b[0]) + EPS &&
      point[1] >= Math.min(a[1], b[1]) - EPS &&
      point[1] <= Math.max(a[1], b[1]) + EPS
    )
      return true;
    if (
      a[1] > point[1] !== b[1] > point[1] &&
      point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}
/** Geographic local segment interpolation; date-line rings are unwrapped around the segment. */
export function segmentAreaEntry(
  a: PredictionCoordinate,
  b: PredictionCoordinate,
  area: PredictionArea,
): number | null {
  const end: PredictionCoordinate = [a[0] + wrap(b[0] - a[0]), b[1]];
  const polygons = (area.type === 'Polygon' ? [area.coordinates] : area.coordinates).map(
    (polygon) => polygon.map((ring) => unwrapped(ring, a[0])),
  );
  const inside = (p: PredictionCoordinate) =>
    polygons.some(
      (polygon) =>
        ringContains(p, polygon[0]!) && !polygon.slice(1).some((ring) => ringContains(p, ring)),
    );
  if (inside(a)) return 0;
  const dx = end[0] - a[0],
    dy = end[1] - a[1],
    fractions = [0, 1];
  for (const polygon of polygons)
    for (const ring of polygon)
      for (let i = 1; i < ring.length; i++) {
        const c = ring[i - 1]!,
          d = ring[i]!,
          ex = d[0] - c[0],
          ey = d[1] - c[1],
          den = dx * ey - dy * ex;
        if (Math.abs(den) < EPS) continue;
        const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den,
          u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den;
        if (t >= -EPS && t <= 1 + EPS && u >= -EPS && u <= 1 + EPS)
          fractions.push(Math.max(0, Math.min(1, t)));
      }
  fractions.sort((x, y) => x - y);
  for (let i = 0; i < fractions.length; i++) {
    const t = fractions[i]!,
      next = fractions[i + 1] ?? t;
    if (
      inside([a[0] + dx * t, a[1] + dy * t]) ||
      inside([a[0] + (dx * (t + next)) / 2, a[1] + (dy * (t + next)) / 2])
    )
      return t;
  }
  return null;
}
/** Wilson 95% interval remains informative for zero hits and all hits. */
export function probabilityInterval(hits: number, total: number): [number, number] {
  if (total <= 0) return [0, 1];
  const z = 1.959963984540054,
    p = hits / total,
    den = 1 + (z * z) / total,
    center = (p + (z * z) / (2 * total)) / den,
    half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / den;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}
function applicable(
  warning: NavigationWarning,
  vessel: { mmsi: string; shipType?: number | null },
) {
  const rule = warning.applicability;
  return (
    rule.kind === 'all' ||
    (rule.kind === 'mmsis'
      ? rule.mmsis.includes(vessel.mmsi)
      : vessel.shipType !== null &&
        vessel.shipType !== undefined &&
        rule.shipTypes.includes(vessel.shipType))
  );
}
export function evaluateNavigationWarningImpact(input: {
  prediction: ReachabilityPrediction;
  warnings: unknown[];
  vessel: { mmsi: string; shipType?: number | null };
}): { impacts: NavigationWarningImpact[]; skipped: { warningId: string; reason: string }[] } {
  if (input.prediction.summary.mmsi !== input.vessel.mmsi)
    throw new Error('Prediction vessel does not match impact vessel');
  const impacts: NavigationWarningImpact[] = [],
    skipped: { warningId: string; reason: string }[] = [];
  for (const raw of input.warnings) {
    const parsed = NavigationWarningSchema.safeParse(raw),
      id = typeof raw === 'object' && raw !== null && 'id' in raw ? String(raw.id) : 'unknown';
    if (!parsed.success) {
      skipped.push({ warningId: id, reason: 'requires_confirmed_time_area_and_applicability' });
      continue;
    }
    const warning = parsed.data;
    if (!applicable(warning, input.vessel)) {
      skipped.push({ warningId: id, reason: 'vessel_not_applicable' });
      continue;
    }
    if (input.prediction.summary.status !== 'ready' || !input.prediction.paths.length) {
      skipped.push({ warningId: id, reason: 'prediction_not_applicable' });
      continue;
    }
    const from = Math.max(
        Date.parse(input.prediction.summary.asOf),
        Date.parse(warning.effectiveFrom),
      ),
      to = Date.parse(warning.effectiveTo),
      entries: number[] = [];
    for (const path of input.prediction.paths) {
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!,
          b = path.points[i]!,
          ta = Date.parse(a.at),
          tb = Date.parse(b.at);
        const start = Math.max(from, ta),
          end = Math.min(to, tb);
        if (start >= end || tb <= ta) continue;
        const interpolate = (time: number): PredictionCoordinate => {
          const f = (time - ta) / (tb - ta);
          return [
            a.coordinate[0] + wrap(b.coordinate[0] - a.coordinate[0]) * f,
            a.coordinate[1] + (b.coordinate[1] - a.coordinate[1]) * f,
          ];
        };
        const fraction = segmentAreaEntry(interpolate(start), interpolate(end), warning.geometry);
        if (fraction !== null && start + (end - start) * fraction < to) {
          entries.push(start + (end - start) * fraction);
          break;
        }
      }
    }
    impacts.push({
      warningId: warning.id,
      probability: entries.length / input.prediction.paths.length,
      hitPaths: entries.length,
      totalPaths: input.prediction.paths.length,
      confidenceInterval: probabilityInterval(entries.length, input.prediction.paths.length),
      firstEntry: entries.length
        ? {
            from: new Date(Math.min(...entries)).toISOString(),
            to: new Date(Math.max(...entries)).toISOString(),
          }
        : null,
      calibration: 'uncalibrated',
      probabilityCondition: input.prediction.summary.probabilityCondition,
    });
  }
  return { impacts, skipped };
}
