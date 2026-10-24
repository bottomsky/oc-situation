import type { PredictionCoordinate } from '../../packages/contracts/reachability';

/** The complement of the largest longitude gap is the smallest circular bounding interval. */
export function predictionResultBbox(
  points: Iterable<PredictionCoordinate>,
  fallback: [number, number, number, number],
): [number, number, number, number] {
  const longitudes: number[] = [];
  let south = 90,
    north = -90;
  for (const [lon, lat] of points) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || lat < -90 || lat > 90) continue;
    longitudes.push(((lon + 540) % 360) - 180);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  if (!longitudes.length) return [...fallback];
  longitudes.sort((a, b) => a - b);
  let gap = -1,
    start = 0;
  for (let i = 0; i < longitudes.length; i++) {
    const next = longitudes[(i + 1) % longitudes.length]! + (i === longitudes.length - 1 ? 360 : 0);
    if (next - longitudes[i]! > gap) {
      gap = next - longitudes[i]!;
      start = i;
    }
  }
  return [longitudes[(start + 1) % longitudes.length]!, south, longitudes[start]!, north];
}
