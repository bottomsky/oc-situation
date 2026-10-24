import {
  REACHABILITY_MODEL_VERSION,
  type MotionResidual,
  type PredictionArea,
  type PredictionCoordinate,
  type PredictionObservation,
  type ReachabilityDependencies,
} from '../contracts/reachability';
import { evaluateNavigationWarningImpact, segmentAreaEntry } from './navigation-warning-impact';
import {
  predictionBearing,
  predictionDestination,
  predictionDistance,
  predictVesselReachability,
  cleanPredictionObservations,
} from './reachability';

export interface ReachabilityBacktestVoyage {
  voyageId: string;
  mmsi: string;
  shipType?: number | null;
  forecastAt: string;
  observations: PredictionObservation[];
  /** Independently reviewed warnings with a fully observed trajectory in their lifetime. */
  warnings?: unknown[];
}
export interface ReachabilityBacktestSample {
  voyageId: string;
  forecastAt: string;
  inputLatestAt: string;
  minutes: number;
  errorMeters: number;
  baselineErrorMeters: number;
  brierScore: number;
  coverage: { level: number; covered: boolean; areaSquareKm: number }[];
}
const wrap = (n: number) => ((n + 540) % 360) - 180;
function validTime(time: string) {
  const value = Date.parse(time);
  if (!Number.isFinite(value)) throw new Error('Invalid backtest timestamp');
  return value;
}
/** Drop boundary-straddling voyages rather than putting part of one voyage into training. */
export function splitReachabilityVoyages(voyages: ReachabilityBacktestVoyage[], splitAt: string) {
  const split = validTime(splitAt),
    ids = new Set<string>(),
    train: ReachabilityBacktestVoyage[] = [],
    test: ReachabilityBacktestVoyage[] = [],
    excluded: string[] = [];
  for (const voyage of voyages) {
    if (ids.has(voyage.voyageId)) throw new Error('Duplicate voyage id crosses isolation boundary');
    ids.add(voyage.voyageId);
    const times = voyage.observations.map((p) => validTime(p.observedAt));
    if (!times.length) {
      excluded.push(voyage.voyageId);
      continue;
    }
    if (Math.max(...times) < split && validTime(voyage.forecastAt) < split) train.push(voyage);
    else if (Math.min(...times) >= split && validTime(voyage.forecastAt) >= split)
      test.push(voyage);
    else excluded.push(voyage.voyageId);
  }
  return { train, test, excluded };
}
export function trainMotionResiduals(voyages: ReachabilityBacktestVoyage[]): MotionResidual[] {
  const output: MotionResidual[] = [];
  for (const voyage of voyages) {
    const points = [...voyage.observations].sort(
      (a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt),
    );
    let previousSpeed: number | undefined, previousDirection: number | undefined;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!,
        dt = (Date.parse(b.observedAt) - Date.parse(a.observedAt)) / 60000;
      if (dt <= 0 || dt > 30) {
        previousSpeed = undefined;
        previousDirection = undefined;
        continue;
      }
      const ca: PredictionCoordinate = [a.longitude, a.latitude],
        cb: PredictionCoordinate = [b.longitude, b.latitude],
        speed = predictionDistance(ca, cb) / 1852 / (dt / 60),
        direction = predictionBearing(ca, cb);
      if (!Number.isFinite(speed) || speed > 80) {
        previousSpeed = undefined;
        previousDirection = undefined;
        continue;
      }
      if (previousSpeed !== undefined && previousDirection !== undefined)
        output.push({
          speedKnots: speed - previousSpeed,
          turnDegreesPerMinute: wrap(direction - previousDirection) / dt,
        });
      previousSpeed = speed;
      previousDirection = direction;
    }
  }
  return output;
}
function observedAt(points: PredictionObservation[], time: number): PredictionCoordinate | null {
  const sorted = [...points].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  const exact = sorted.find((p) => Date.parse(p.observedAt) === time);
  if (exact) return [exact.longitude, exact.latitude];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1]!,
      b = sorted[i]!,
      ta = Date.parse(a.observedAt),
      tb = Date.parse(b.observedAt);
    if (ta < time && time < tb && tb - ta <= 15 * 60000) {
      const t = (time - ta) / (tb - ta);
      return [
        a.longitude + wrap(b.longitude - a.longitude) * t,
        a.latitude + (b.latitude - a.latitude) * t,
      ];
    }
  }
  return null;
}
function areaSquareKm(area: PredictionArea) {
  const polygons = area.type === 'Polygon' ? [area.coordinates] : area.coordinates;
  return polygons.reduce(
    (total, polygon) =>
      total +
      polygon.reduce((sum, ring, index) => {
        let twiceArea = 0;
        const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
        for (let i = 1; i < ring.length; i++)
          twiceArea += ring[i - 1]![0] * ring[i]![1] - ring[i]![0] * ring[i - 1]![1];
        return (
          sum +
          (((index === 0 ? 1 : -1) * Math.abs(twiceArea)) / 2) *
            111.195 ** 2 *
            Math.cos((lat * Math.PI) / 180)
        );
      }, 0),
    0,
  );
}
/** Executable pure-domain entry point for an offline real-AIS replay script. */
export async function runReachabilityBacktest(input: {
  voyages: ReachabilityBacktestVoyage[];
  splitAt: string;
  dependencies: ReachabilityDependencies;
  seed?: number;
}) {
  const split = splitReachabilityVoyages(input.voyages, input.splitAt),
    historicalResiduals = trainMotionResiduals(split.train),
    samples: ReachabilityBacktestSample[] = [],
    skipped: { voyageId: string; reason: string }[] = [],
    impacts: {
      voyageId: string;
      warningId: string;
      actual: 0 | 1;
      probability: number;
      brierScore: number;
    }[] = [];
  for (const voyage of split.test) {
    const cutoff = validTime(voyage.forecastAt),
      rawHistory = voyage.observations.filter((p) => Date.parse(p.observedAt) <= cutoff),
      history = cleanPredictionObservations({ asOf: voyage.forecastAt, observations: rawHistory });
    if (history.length < 2) {
      skipped.push({
        voyageId: voyage.voyageId,
        reason: 'insufficient_clean_observations_for_baseline',
      });
      continue;
    }
    const prediction = await predictVesselReachability(
      {
        mmsi: voyage.mmsi,
        asOf: voyage.forecastAt,
        observations: rawHistory,
        historicalResiduals,
        seed: input.seed,
      },
      input.dependencies,
    );
    if (prediction.summary.status !== 'ready') {
      skipped.push({
        voyageId: voyage.voyageId,
        reason: prediction.summary.reason ?? prediction.summary.status,
      });
      continue;
    }
    const last = history.at(-1)!,
      previous = history.at(-2)!,
      start: PredictionCoordinate = [last.longitude, last.latitude],
      prior: PredictionCoordinate = [previous.longitude, previous.latitude],
      elapsed = (Date.parse(last.observedAt) - Date.parse(previous.observedAt)) / 3600000;
    const baselineSpeed =
      typeof last.speedOverGround === 'number' &&
      Number.isFinite(last.speedOverGround) &&
      last.speedOverGround >= 0 &&
      last.speedOverGround <= 80
        ? last.speedOverGround
        : predictionDistance(prior, start) / 1852 / elapsed;
    const baselineBearing =
      typeof last.courseOverGround === 'number' &&
      last.courseOverGround >= 0 &&
      last.courseOverGround < 360
        ? last.courseOverGround
        : predictionBearing(prior, start);
    for (const horizon of prediction.summary.horizons) {
      const truth = observedAt(voyage.observations, Date.parse(horizon.at));
      if (!truth) {
        skipped.push({ voyageId: voyage.voyageId, reason: `missing_truth_${horizon.minutes}min` });
        continue;
      }
      const endpoints = prediction.paths.map(
          (p) =>
            p.points.find((point) => Date.parse(point.at) === Date.parse(horizon.at))!.coordinate,
        ),
        center: PredictionCoordinate = [
          start[0] + endpoints.reduce((s, p) => s + wrap(p[0] - start[0]), 0) / endpoints.length,
          endpoints.reduce((s, p) => s + p[1], 0) / endpoints.length,
        ];
      const baseline = predictionDestination(
        start,
        baselineBearing,
        baselineSpeed * 1852 * ((Date.parse(horizon.at) - Date.parse(last.observedAt)) / 3600000),
      );
      const occupied = horizon.positionCells.find(
        (c) => segmentAreaEntry(truth, truth, c.geometry) !== null,
      );
      const brier =
        horizon.positionCells.reduce((s, c) => s + c.probability * c.probability, 0) +
        1 -
        2 * (occupied?.probability ?? 0);
      samples.push({
        voyageId: voyage.voyageId,
        forecastAt: voyage.forecastAt,
        inputLatestAt: last.observedAt,
        minutes: horizon.minutes,
        errorMeters: predictionDistance(center, truth),
        baselineErrorMeters: predictionDistance(baseline, truth),
        brierScore: Math.max(0, brier),
        coverage: horizon.coverage.map((c) => ({
          level: c.level,
          covered: segmentAreaEntry(truth, truth, c.geometry) !== null,
          areaSquareKm: areaSquareKm(c.geometry),
        })),
      });
    }
    if (voyage.warnings?.length) {
      const forecastImpacts = evaluateNavigationWarningImpact({
        prediction,
        warnings: voyage.warnings,
        vessel: { mmsi: voyage.mmsi, shipType: voyage.shipType },
      }).impacts;
      for (const forecast of forecastImpacts) {
        const warning = voyage.warnings.find(
          (w) => typeof w === 'object' && w !== null && 'id' in w && w.id === forecast.warningId,
        );
        if (
          !warning ||
          typeof warning !== 'object' ||
          !('effectiveFrom' in warning) ||
          !('effectiveTo' in warning)
        )
          continue;
        const from = Math.max(cutoff, Date.parse(String(warning.effectiveFrom))),
          to = Math.min(cutoff + 120 * 60000, Date.parse(String(warning.effectiveTo)));
        const startTruth = observedAt(voyage.observations, from),
          endTruth = observedAt(voyage.observations, to);
        if (!startTruth || !endTruth || from >= to) continue;
        const observedPoints = voyage.observations
          .filter((p) => Date.parse(p.observedAt) > from && Date.parse(p.observedAt) < to)
          .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
        const actualPath = {
          id: 0,
          points: [
            { at: new Date(from).toISOString(), coordinate: startTruth },
            ...observedPoints.map((p) => ({
              at: p.observedAt,
              coordinate: [p.longitude, p.latitude] as PredictionCoordinate,
            })),
            { at: new Date(to).toISOString(), coordinate: endTruth },
          ],
        };
        if (
          actualPath.points.some(
            (p, i) =>
              i > 0 && Date.parse(p.at) - Date.parse(actualPath.points[i - 1]!.at) > 15 * 60000,
          )
        )
          continue;
        const actual = evaluateNavigationWarningImpact({
          prediction: { summary: prediction.summary, paths: [actualPath] },
          warnings: [warning],
          vessel: { mmsi: voyage.mmsi, shipType: voyage.shipType },
        }).impacts[0]!.hitPaths as 0 | 1;
        impacts.push({
          voyageId: voyage.voyageId,
          warningId: forecast.warningId,
          actual,
          probability: forecast.probability,
          brierScore: (forecast.probability - actual) ** 2,
        });
      }
    }
  }
  const average = (values: number[]) =>
    values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return {
    modelVersion: REACHABILITY_MODEL_VERSION,
    calibrationState: 'uncalibrated' as const,
    trainingVoyages: split.train.map((v) => v.voyageId),
    testVoyages: split.test.map((v) => v.voyageId),
    excludedVoyages: split.excluded,
    samples,
    impacts,
    skipped,
    metrics: {
      meanErrorMeters: average(samples.map((s) => s.errorMeters)),
      baselineMeanErrorMeters: average(samples.map((s) => s.baselineErrorMeters)),
      meanBrierScore: average(samples.map((s) => s.brierScore)),
      impactBrierScore: average(impacts.map((s) => s.brierScore)),
      positiveImpactSamples: impacts.filter((s) => s.actual === 1).length,
      negativeImpactSamples: impacts.filter((s) => s.actual === 0).length,
      coverage: ([0.5, 0.8, 0.95] as const).map((level) => ({
        level,
        empiricalCoverage: average(
          samples.map((s) => Number(s.coverage.find((c) => c.level === level)!.covered)),
        ),
        meanAreaSquareKm: average(
          samples.map((s) => s.coverage.find((c) => c.level === level)!.areaSquareKm),
        ),
      })),
    },
  };
}
