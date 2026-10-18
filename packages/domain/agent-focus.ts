import { CircleRegionSchema, SpatialBboxSchema, type CircleRegion } from '../contracts/spatial';
import type { IntelligenceGeometry } from '../contracts/intelligence-spatial';
export function focusCoordinates(geometry: IntelligenceGeometry): [number, number][][] {
  switch (geometry.type) {
    case 'Point':
      return [[geometry.coordinates]];
    case 'MultiPoint':
      return geometry.coordinates.map((p) => [p]);
    case 'LineString':
      return [geometry.coordinates];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates;
    case 'MultiPolygon':
      return geometry.coordinates.flat();
  }
}
const wrap = (x: number) => ((((x + 180) % 360) + 360) % 360) - 180;
type LongitudeInterval = [number, number];
const COVERAGE_EPSILON = 1e-10;
/** Exclude only an uncovered longitude gap: continuous edges contribute intervals, points do not. */
export function focusBounds(
  geometries: IntelligenceGeometry[],
): [number, number, number, number] | null {
  const intervals: LongitudeInterval[] = [];
  let south = 90,
    north = -90;
  for (const geometry of geometries) {
    for (const line of focusCoordinates(geometry)) {
      for (let i = 0; i < line.length; i++) {
        const point = line[i]!;
        south = Math.min(south, point[1]);
        north = Math.max(north, point[1]);
        const start = wrap(point[0]) + 180;
        intervals.push([start, start]);
        if (i === 0) continue;
        const delta = wrap(line[i - 1]![0] - point[0]);
        const end = start + delta;
        const lo = Math.min(start, end),
          hi = Math.max(start, end);
        if (lo < 0) intervals.push([0, hi], [lo + 360, 360]);
        else if (hi > 360) intervals.push([lo, 360], [0, hi - 360]);
        else intervals.push([lo, hi]);
      }
    }
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: LongitudeInterval[] = [];
  for (const interval of intervals) {
    const previous = merged.at(-1);
    if (previous && interval[0] <= previous[1] + COVERAGE_EPSILON)
      previous[1] = Math.max(previous[1], interval[1]);
    else merged.push([...interval]);
  }
  let largestGap = -1,
    west = 0,
    east = 0;
  for (let i = 0; i < merged.length; i++) {
    const current = merged[i]!,
      next = merged[(i + 1) % merged.length]!;
    const gap = next[0] + (i === merged.length - 1 ? 360 : 0) - current[1];
    if (gap > largestGap) {
      largestGap = gap;
      west = next[0];
      east = current[1];
    }
  }
  if (largestGap <= COVERAGE_EPSILON) return [-180, south, 180, north];
  return [wrap(west - 180), south, wrap(east - 180), north];
}

/** Densify explicit bbox edges in their stated direction, preserving wide and full-world areas. */
export function bboxFocusGeometry(input: [number, number, number, number]): IntelligenceGeometry {
  const [west, south, east, north] = SpatialBboxSchema.parse(input);
  const unwrappedEast = east < west ? east + 360 : east;
  const corners: [number, number][] = [
    [west, south],
    [unwrappedEast, south],
    [unwrappedEast, north],
    [west, north],
    [west, south],
  ];
  const ring: [number, number][] = [];
  const canonical = (longitude: number) => {
    const value = wrap(longitude);
    return value === -180 && longitude > 0 ? 180 : value;
  };
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1]!,
      to = corners[i]!;
    const steps = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1])) / 5),
    );
    for (let j = 0; j < steps; j++)
      ring.push([
        canonical(from[0] + ((to[0] - from[0]) * j) / steps),
        from[1] + ((to[1] - from[1]) * j) / steps,
      ]);
  }
  ring.push([...ring[0]!]);
  return { type: 'Polygon', coordinates: [ring] };
}

/** Explicit coordinate + radius only; captured viewport never supplies the center. */
export function parseCircleRegion(goal: string): CircleRegion | undefined {
  const radius = goal.match(/(?:方圆|半径)\s*(\d+(?:\.\d+)?)\s*(公里|千米|km|米)/i);
  if (!radius) return undefined;
  const pair = goal.match(
    /(?:坐标|点位)\s*[:：]?\s*[（(]?\s*(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)/,
  );
  const lon = goal.match(/(?:经度|lon(?:gitude)?)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i);
  const lat = goal.match(/(?:纬度|lat(?:itude)?)\s*[:：]?\s*(-?\d+(?:\.\d+)?)/i);
  if (!pair && !(lon && lat)) return undefined;
  return CircleRegionSchema.parse({
    kind: 'circle',
    center: pair ? [Number(pair[1]), Number(pair[2])] : [Number(lon![1]), Number(lat![1])],
    radiusMeters: Number(radius[1]) * (radius[2] === '米' ? 1 : 1000),
  });
}
