import { z } from 'zod';

export const REACHABILITY_MODEL_VERSION = 'recent-motion-residual-mc-v1.1';
export const REACHABILITY_PATH_COUNT = 2048;
export const REACHABILITY_HORIZONS = [15, 30, 60, 120] as const;
export const ReachabilityQuerySchema = z.strictObject({
  mmsi: z.string().regex(/^[1-9]\d{8}$/),
  asOf: z.iso.datetime().optional(),
  seed: z.number().int().min(0).max(4294967295).default(20261024),
});
export type ReachabilityQuery = z.infer<typeof ReachabilityQuerySchema>;
export type PredictionCoordinate = [number, number];
export interface PredictionPolygon {
  type: 'Polygon';
  coordinates: PredictionCoordinate[][];
}
export interface PredictionMultiPolygon {
  type: 'MultiPolygon';
  coordinates: PredictionCoordinate[][][];
}
export type PredictionArea = PredictionPolygon | PredictionMultiPolygon;
export interface PredictionObservation {
  observedAt: string;
  longitude: number;
  latitude: number;
  speedOverGround?: number | null;
  courseOverGround?: number | null;
  heading?: number | null;
}
export interface MotionResidual {
  speedKnots: number;
  turnDegreesPerMinute: number;
}
export interface ReachabilityInput {
  mmsi: string;
  asOf: string;
  observations: PredictionObservation[];
  seed?: number;
  /** Only residuals from voyages completed before asOf belong here. */
  historicalResiduals?: MotionResidual[];
}
export interface PredictionPath {
  id: number;
  /** Includes latest observation before asOf when stale; select future points by at, not array index. */
  points: { at: string; coordinate: PredictionCoordinate }[];
}
export interface ProbabilityCell {
  id: string;
  probability: number;
  geometry: PredictionPolygon;
}
export interface ReachabilityHorizon {
  minutes: (typeof REACHABILITY_HORIZONS)[number];
  at: string;
  gridSizeMeters: number;
  positionCells: ProbabilityCell[];
  /** Each path contributes at most once to a visited cell over [asOf, at]. */
  passageCells: ProbabilityCell[];
  coverage: { level: 0.5 | 0.8 | 0.95; probability: number; geometry: PredictionMultiPolygon }[];
}
export interface ReachabilityResult {
  mmsi: string;
  asOf: string;
  status: 'ready' | 'insufficient_data' | 'model_not_applicable';
  reason: string | null;
  seed: number;
  modelVersion: string;
  inputWindow: { from: string | null; to: string | null; latestAgeMinutes: number | null };
  calibration: { state: 'uncalibrated'; note: string };
  probabilityCondition: 'survives_land_check_through_120min';
  landConstraint: 'checked' | 'unavailable';
  residuals: { source: 'historical' | 'recent_track'; samples: number };
  limitations: string[];
  quality: {
    acceptedObservations: number;
    rejectedObservations: number;
    directionSource: 'cog' | 'track' | 'none';
    motionState: 'moving' | 'stopped' | 'unknown';
  };
  rejection: { proposed: number; accepted: number; land: number };
  monteCarlo: { effectivePaths: number; maxStandardError: number | null; confidenceLevel: 0.95 };
  horizons: ReachabilityHorizon[];
}
/** Internal algorithm output: persist or pass paths to impact/backtest, return summary to web. */
export interface ReachabilityPrediction {
  summary: ReachabilityResult;
  paths: PredictionPath[];
}
export interface ReachabilityDependencies {
  /** One asynchronous batch. True means every complete segment of the path is navigable. */
  checkPaths?: (paths: PredictionPath[]) => Promise<boolean[]>;
}

const CoordinateSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const RingSchema = z
  .array(CoordinateSchema)
  .min(4)
  .refine((ring) => {
    const a = ring[0]!,
      b = ring.at(-1)!;
    return a[0] === b[0] && a[1] === b[1];
  }, 'A polygon ring must be closed');
const PolygonCoordinatesSchema = z.array(RingSchema).min(1);
export const NavigationWarningSchema = z
  .strictObject({
    id: z.string().min(1),
    reviewStatus: z.literal('confirmed'),
    effectiveFrom: z.iso.datetime(),
    effectiveTo: z.iso.datetime(),
    geometry: z.discriminatedUnion('type', [
      z.strictObject({ type: z.literal('Polygon'), coordinates: PolygonCoordinatesSchema }),
      z.strictObject({
        type: z.literal('MultiPolygon'),
        coordinates: z.array(PolygonCoordinatesSchema).min(1),
      }),
    ]),
    applicability: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('all') }),
      z.strictObject({
        kind: z.literal('mmsis'),
        mmsis: z.array(z.string().regex(/^[1-9]\d{8}$/)).min(1),
      }),
      z.strictObject({
        kind: z.literal('ship_types'),
        shipTypes: z.array(z.number().int().min(1).max(99)).min(1),
      }),
    ]),
  })
  .refine(
    (w) => Date.parse(w.effectiveFrom) < Date.parse(w.effectiveTo),
    'Warning lifetime must be positive',
  );
export type NavigationWarning = z.infer<typeof NavigationWarningSchema>;
export interface NavigationWarningImpact {
  geometry?: PredictionArea;
  documentId?: string;
  relationId?: string;
  relationRevision?: number;
  warningId: string;
  probability: number;
  hitPaths: number;
  totalPaths: number;
  confidenceInterval: [number, number];
  firstEntry: { from: string; to: string } | null;
  calibration: 'uncalibrated';
  probabilityCondition: ReachabilityResult['probabilityCondition'];
}
