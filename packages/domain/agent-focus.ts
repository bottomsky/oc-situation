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

const circleNumber = '[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)';
const circleFocusPrefix = /^(?:请(?:帮我)?|帮我)?\s*(?:聚焦|定位|关注|聚集)(?:到)?\s*/;

function circleRequest(goal: string) {
  if (
    !/(?:方圆|半径)\s*[+\-\d.]/.test(goal) &&
    !(
      /方圆|半径/.test(goal) &&
      (circleFocusPrefix.test(goal.trim()) ||
        /坐标|点位|经度|纬度|\d\s*[,，]\s*[+\-\d.]/.test(goal))
    )
  )
    return undefined;
  const radii = [
    ...goal.matchAll(
      new RegExp(`(?:方圆|半径)\\s*(${circleNumber})\\s*(公里|千米|km\\b|米)`, 'gi'),
    ),
  ];
  const pairs = [
    ...goal.matchAll(
      new RegExp(`(?<![\\w.+-])(${circleNumber})\\s*[,，]\\s*(${circleNumber})(?![\\w.+-])`, 'g'),
    ),
  ];
  const longitudes = [
    ...goal.matchAll(
      new RegExp(`(?:经度|lon(?:gitude)?)\\s*[:：]?\\s*(${circleNumber})(?![\\w.+-])`, 'gi'),
    ),
  ];
  const latitudes = [
    ...goal.matchAll(
      new RegExp(`(?:纬度|lat(?:itude)?)\\s*[:：]?\\s*(${circleNumber})(?![\\w.+-])`, 'gi'),
    ),
  ];
  if (
    radii.length !== 1 ||
    (goal.match(/方圆|半径/g)?.length ?? 0) !== 1 ||
    !(
      (pairs.length === 1 && !longitudes.length && !latitudes.length) ||
      (!pairs.length && longitudes.length === 1 && latitudes.length === 1)
    ) ||
    new RegExp(`${circleNumber}\\s*[,，]\\s*${circleNumber}\\s*[,，]\\s*${circleNumber}`).test(goal)
  )
    throw new Error('circle_requires_one_center_and_radius');
  const pair = pairs[0],
    radius = radii[0]!;
  const region = CircleRegionSchema.parse({
    kind: 'circle',
    center: pair
      ? [Number(pair[1]), Number(pair[2])]
      : [Number(longitudes[0]![1]), Number(latitudes[0]![1])],
    radiusMeters: Number(radius[1]) * (radius[2] === '米' ? 1 : 1000),
  });
  let remaining = goal;
  for (const match of [radius, ...pairs, ...longitudes, ...latitudes])
    remaining = remaining.replace(match[0], '');
  return { region, remaining };
}

/** A single explicit longitude/latitude pair and radius; malformed requests never inherit the viewport. */
export function parseCircleRegion(goal: string): CircleRegion | undefined {
  return circleRequest(goal)?.region;
}

/** Only the standalone focus command accepts 聚集 as a common typo; analysis retains its own intent. */
export function isCircleFocusRequest(goal: string): boolean {
  if (!circleFocusPrefix.test(goal.trim())) return false;
  try {
    const parsed = circleRequest(goal);
    return (
      !!parsed &&
      parsed.remaining
        .trim()
        .replace(circleFocusPrefix, '')
        .replace(/坐标|点位|为中心|中心|区域|范围|周围|以|的|内|到/g, '')
        .replace(/[\s[\]()（）,，:：。.!！]/g, '') === ''
    );
  } catch {
    return false;
  }
}
