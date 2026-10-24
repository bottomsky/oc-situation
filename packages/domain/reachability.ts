import {
  REACHABILITY_HORIZONS,
  REACHABILITY_MODEL_VERSION,
  REACHABILITY_PATH_COUNT,
  type PredictionCoordinate,
  type PredictionObservation,
  type PredictionPath,
  type ProbabilityCell,
  type ReachabilityDependencies,
  type ReachabilityInput,
  type ReachabilityPrediction,
  type ReachabilityResult,
} from '../contracts/reachability';
import { routeDistance } from './route-planning';

const RAD = Math.PI / 180;
const EARTH = 6371008.8;
const wrap = (n: number) => ((n + 540) % 360) - 180;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const coordinate = (p: PredictionObservation): PredictionCoordinate => [p.longitude, p.latitude];
export function predictionDistance(a: PredictionCoordinate, b: PredictionCoordinate): number {
  return routeDistance([a, b]);
}
export function predictionBearing(a: PredictionCoordinate, b: PredictionCoordinate): number {
  const dl = wrap(b[0] - a[0]) * RAD;
  return (
    (Math.atan2(
      Math.sin(dl) * Math.cos(b[1] * RAD),
      Math.cos(a[1] * RAD) * Math.sin(b[1] * RAD) -
        Math.sin(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos(dl),
    ) /
      RAD +
      360) %
    360
  );
}
export function predictionDestination(
  a: PredictionCoordinate,
  bearing: number,
  meters: number,
): PredictionCoordinate {
  const d = meters / EARTH,
    b = bearing * RAD,
    lat = a[1] * RAD;
  const phi = Math.asin(
    clamp(Math.sin(lat) * Math.cos(d) + Math.cos(lat) * Math.sin(d) * Math.cos(b), -1, 1),
  );
  const lon =
    a[0] * RAD +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat),
      Math.cos(d) - Math.sin(lat) * Math.sin(phi),
    );
  return [wrap(lon / RAD), phi / RAD];
}
function randomSource(seed: number) {
  let n = seed >>> 0;
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Shared forecast-window, timestamp and implied-speed validation for model and baselines. */
export function cleanPredictionObservations(
  input: Pick<ReachabilityInput, 'asOf' | 'observations'>,
) {
  const now = Date.parse(input.asOf);
  if (!Number.isFinite(now)) throw new Error('Invalid prediction clock');
  const sorted = input.observations
    .filter(
      (p) =>
        Number.isFinite(Date.parse(p.observedAt)) &&
        Date.parse(p.observedAt) >= now - 3600000 &&
        Date.parse(p.observedAt) <= now &&
        Number.isFinite(p.longitude) &&
        Math.abs(p.longitude) <= 180 &&
        Number.isFinite(p.latitude) &&
        Math.abs(p.latitude) <= 90,
    )
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const accepted: PredictionObservation[] = [];
  for (const point of sorted) {
    const previous = accepted.at(-1);
    if (previous) {
      const elapsed = (Date.parse(point.observedAt) - Date.parse(previous.observedAt)) / 3600000;
      if (
        elapsed <= 0 ||
        predictionDistance(coordinate(previous), coordinate(point)) / 1852 / elapsed > 80
      )
        continue;
    }
    accepted.push(point);
  }
  return accepted;
}
function grid(paths: PredictionPath[], minutes: number, size: number, originLat: number) {
  const latStep = size / 111195,
    cols = Math.ceil(360 / (size / (111195 * Math.max(0.05, Math.cos(originLat * RAD))))),
    lonStep = 360 / cols;
  const key = (p: PredictionCoordinate) =>
    `${clamp(Math.floor((wrap(p[0]) + 180) / lonStep), 0, cols - 1)}:${Math.floor((p[1] + 90) / latStep)}`;
  const positions = new Map<string, number>(),
    visits = new Map<string, number>();
  const add = (map: Map<string, number>, id: string) => map.set(id, (map.get(id) ?? 0) + 1);
  for (const path of paths) {
    // Generated paths have 121 minute points plus at most one stale source point.
    const offset = path.points.length - 121;
    const points = path.points.slice(offset, offset + minutes + 1);
    add(positions, key(points.at(-1)!.coordinate));
    const seen = new Set<string>();
    for (let i = 0; i < points.length; i++) {
      const b = points[i]!.coordinate,
        a = points[Math.max(0, i - 1)]!.coordinate;
      if (a[0] === b[0] && a[1] === b[1]) {
        seen.add(key(a));
        continue;
      }
      const x0 = (a[0] + 180) / lonStep,
        x1 = x0 + wrap(b[0] - a[0]) / lonStep,
        y0 = (a[1] + 90) / latStep,
        y1 = (b[1] + 90) / latStep;
      const fractions = [0, 1];
      for (const [v0, v1] of [
        [x0, x1],
        [y0, y1],
      ] as [number, number][]) {
        if (Math.abs(v1 - v0) < 1e-12) continue;
        for (let boundary = Math.ceil(Math.min(v0, v1)); boundary < Math.max(v0, v1); boundary++)
          fractions.push((boundary - v0) / (v1 - v0));
      }
      fractions.sort((a, b) => a - b);
      for (let j = 0; j < fractions.length; j++) {
        const t = fractions[j]!,
          mid = (t + (fractions[j + 1] ?? t)) / 2;
        for (const f of [t, mid])
          seen.add(key([wrap(a[0] + wrap(b[0] - a[0]) * f), a[1] + (b[1] - a[1]) * f]));
      }
    }
    for (const id of seen) add(visits, id);
  }
  const cells = (map: Map<string, number>): ProbabilityCell[] =>
    [...map]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([id, count]) => {
        const [x, y] = id.split(':').map(Number) as [number, number],
          west = -180 + x * lonStep,
          east = Math.min(180, west + lonStep),
          south = Math.max(-90, -90 + y * latStep),
          north = Math.min(90, south + latStep);
        return {
          id,
          probability: count / paths.length,
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [west, south],
                [east, south],
                [east, north],
                [west, north],
                [west, south],
              ],
            ],
          },
        };
      });
  const positionCells = cells(positions);
  const coverage = ([0.5, 0.8, 0.95] as const).map((level) => {
    let cumulative = 0;
    const selected: ProbabilityCell[] = [];
    for (const cell of positionCells) {
      selected.push(cell);
      cumulative += cell.probability;
      if (cumulative + 1e-12 >= level) break;
    }
    return {
      level,
      probability: cumulative,
      geometry: {
        type: 'MultiPolygon' as const,
        coordinates: selected.map((c) => c.geometry.coordinates),
      },
    };
  });
  return { positionCells, passageCells: cells(visits), coverage };
}
export async function predictVesselReachability(
  input: ReachabilityInput,
  dependencies: ReachabilityDependencies = {},
): Promise<ReachabilityPrediction> {
  if (!Number.isFinite(Date.parse(input.asOf))) throw new Error('Invalid prediction clock');
  const seed = input.seed ?? 20261024;
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) throw new Error('Invalid seed');
  const points = cleanPredictionObservations(input),
    latest = points.at(-1),
    age = latest ? (Date.parse(input.asOf) - Date.parse(latest.observedAt)) / 60000 : null;
  const summary: ReachabilityResult = {
    mmsi: input.mmsi,
    asOf: input.asOf,
    status: 'insufficient_data',
    reason: null,
    seed,
    modelVersion: REACHABILITY_MODEL_VERSION,
    inputWindow: {
      from: points[0]?.observedAt ?? null,
      to: latest?.observedAt ?? null,
      latestAgeMinutes: age,
    },
    calibration: { state: 'uncalibrated', note: '模型概率尚未经过独立历史航次校准' },
    probabilityCondition: 'survives_land_check_through_120min',
    landConstraint: dependencies.checkPaths ? 'checked' : 'unavailable',
    residuals: { source: 'recent_track', samples: 0 },
    limitations: [
      '概率以完整120分钟路径通过海岸检查为条件',
      '蒙特卡洛区间仅描述抽样误差，实际预测精度须由独立航次回测确定',
    ],
    quality: {
      acceptedObservations: points.length,
      rejectedObservations: input.observations.length - points.length,
      directionSource: 'none',
      motionState: 'unknown',
    },
    rejection: { proposed: 0, accepted: 0, land: 0 },
    monteCarlo: { effectivePaths: 0, maxStandardError: null, confidenceLevel: 0.95 },
    horizons: [],
  };
  if (points.length < 3 || age === null || age > 10) {
    summary.reason = '至少需要最近60分钟内3个有效时刻，末报须在10分钟内';
    return { summary, paths: [] };
  }
  const speeds: number[] = [],
    directions: { bearing: number; observedAt: number; speedIndex: number }[] = [],
    intervals: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      dt = (Date.parse(b.observedAt) - Date.parse(a.observedAt)) / 60000;
    const distance = predictionDistance(coordinate(a), coordinate(b));
    speeds.push(distance / 1852 / (dt / 60));
    intervals.push(dt);
    if (distance >= 5)
      directions.push({
        bearing: predictionBearing(coordinate(a), coordinate(b)),
        observedAt: Date.parse(b.observedAt),
        speedIndex: speeds.length - 1,
      });
  }
  const reported = latest!.speedOverGround;
  const speed =
    typeof reported === 'number' && Number.isFinite(reported) && reported >= 0 && reported <= 80
      ? reported
      : mean(speeds.slice(-3));
  const stopped = speed < 0.5 && mean(speeds.slice(-3)) < 0.5;
  const cog = latest!.courseOverGround;
  const validCog = typeof cog === 'number' && Number.isFinite(cog) && cog >= 0 && cog < 360;
  let bearing = validCog ? cog : directions.at(-1)?.bearing;
  summary.quality.motionState = stopped ? 'stopped' : 'moving';
  summary.quality.directionSource = validCog ? 'cog' : directions.length ? 'track' : 'none';
  if (bearing === undefined && !stopped) {
    summary.reason = '运动船舶缺少有效COG及可推导的轨迹方向';
    return { summary, paths: [] };
  }
  bearing ??= 0;
  // A displacement bearing is observed at its segment endpoint. Stationary/short reports
  // carry no direction measurement, so elapsed time comes from the retained samples.
  const turnBySpeedIndex = new Map<number, number>();
  const turns = directions.slice(1).map((sample, i) => {
    const previous = directions[i]!;
    const elapsedMinutes = (sample.observedAt - previous.observedAt) / 60000;
    const rate = wrap(sample.bearing - previous.bearing) / elapsedMinutes;
    turnBySpeedIndex.set(sample.speedIndex, rate);
    return rate;
  });
  const turn = clamp(mean(turns.slice(-3)), -3, 3);
  const speedDrift = clamp(
    mean(speeds.slice(1).map((s, i) => (s - speeds[i]!) / (intervals[i + 1] ?? 1))),
    -0.05,
    0.05,
  );
  const residuals = (input.historicalResiduals ?? []).filter(
    (r) =>
      Number.isFinite(r.speedKnots) &&
      Math.abs(r.speedKnots) <= 20 &&
      Number.isFinite(r.turnDegreesPerMinute) &&
      Math.abs(r.turnDegreesPerMinute) <= 10,
  );
  const recent = speeds.map((s, i) => ({
    speedKnots: clamp(s - mean(speeds), -3, 3),
    turnDegreesPerMinute: clamp((turnBySpeedIndex.get(i) ?? turn) - turn, -2, 2),
  }));
  const pool = residuals.length ? residuals : recent;
  summary.residuals = {
    source: residuals.length ? 'historical' : 'recent_track',
    samples: pool.length,
  };
  if (stopped) summary.limitations.push('停船模型保持当前位置，离泊时机须纳入后续模型评估');
  const random = randomSource(seed),
    all: PredictionPath[] = [];
  for (let id = 0; id < REACHABILITY_PATH_COUNT; id++) {
    let position = predictionDestination(coordinate(latest!), bearing, ((speed * 1852) / 60) * age),
      direction = bearing,
      velocity = speed;
    const path: PredictionPath = { id, points: [{ at: input.asOf, coordinate: position }] };
    if (age > 0) path.points.unshift({ at: latest!.observedAt, coordinate: coordinate(latest!) });
    const bias = pool[Math.floor(random() * pool.length)]!;
    for (let minute = 1; minute <= 120; minute++) {
      const residual = pool[Math.floor(random() * pool.length)]!;
      if (!stopped) {
        velocity = clamp(
          velocity +
            speedDrift * Math.exp(-minute / 20) +
            residual.speedKnots * 0.06 +
            (random() - 0.5) * 0.12,
          0,
          80,
        );
        direction +=
          turn * Math.exp(-minute / 20) +
          bias.turnDegreesPerMinute * 0.15 +
          residual.turnDegreesPerMinute * 0.2 +
          (random() - 0.5) * 1.2;
        position = predictionDestination(position, direction, (velocity * 1852) / 60);
      }
      path.points.push({
        at: new Date(Date.parse(input.asOf) + minute * 60000).toISOString(),
        coordinate: position,
      });
    }
    all.push(path);
  }
  const flags = dependencies.checkPaths ? await dependencies.checkPaths(all) : all.map(() => true);
  if (flags.length !== all.length || flags.some((v) => typeof v !== 'boolean'))
    throw new Error('Land checker must return one boolean for each complete path');
  const paths = all.filter((_, i) => flags[i]);
  summary.rejection = {
    proposed: all.length,
    accepted: paths.length,
    land: all.length - paths.length,
  };
  summary.monteCarlo = {
    effectivePaths: paths.length,
    maxStandardError: paths.length ? Math.sqrt(0.25 / paths.length) : null,
    confidenceLevel: 0.95,
  };
  if (paths.length < REACHABILITY_PATH_COUNT / 2) {
    summary.status = 'model_not_applicable';
    summary.reason = '避陆后有效路径少于一半';
    return { summary, paths };
  }
  summary.status = dependencies.checkPaths ? 'ready' : 'model_not_applicable';
  if (!dependencies.checkPaths) summary.reason = '缺少覆盖完整路径线段的海岸约束，概率仅供诊断';
  const spread = Math.max(
    ...paths.map((p) => predictionDistance(p.points[0]!.coordinate, p.points.at(-1)!.coordinate)),
  );
  const size = clamp(spread / 60, 200, 5000);
  summary.horizons = REACHABILITY_HORIZONS.map((minutes) => ({
    minutes,
    at: new Date(Date.parse(input.asOf) + minutes * 60000).toISOString(),
    gridSizeMeters: size,
    ...grid(paths, minutes, size, latest!.latitude),
  }));
  return { summary, paths };
}
