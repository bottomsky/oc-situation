import { describe, expect, it } from 'vitest';
import {
  predictVesselReachability as predict,
  predictionBearing,
  predictionDestination,
} from './reachability';
import type { ReachabilityDependencies, ReachabilityInput } from '../contracts/reachability';

const openSea: ReachabilityDependencies = { checkPaths: async (paths) => paths.map(() => true) };
const predictVesselReachability = (input: ReachabilityInput, dependencies = openSea) =>
  predict(input, dependencies);

export const observations = [0, 10, 20, 30].map((minute) => ({
  observedAt: new Date(Date.parse('2026-10-24T00:00:00Z') + minute * 60000).toISOString(),
  longitude: 120 + minute / 600,
  latitude: 20,
  speedOverGround: 10,
  courseOverGround: 90,
  heading: 0,
}));
const input = { mmsi: '413000001', asOf: '2026-10-24T00:30:00Z', observations };

describe('conditional Monte Carlo reachability', () => {
  it.each([
    { firstMinutes: 10, offsetMeters: 0 },
    { firstMinutes: 10, offsetMeters: 2 },
    { firstMinutes: 5, offsetMeters: 0 },
  ])(
    'binds turn measurements to their timestamps with a short report inserted: %j',
    async ({ firstMinutes, offsetMeters }) => {
      const start: [number, number] = [120, 20];
      const middle = predictionDestination(start, 0, 1000),
        end = predictionDestination(middle, 2, 1000);
      const at = (minutes: number) =>
        new Date(Date.parse('2026-10-24T00:00:00Z') + minutes * 60000).toISOString();
      const sample = (minutes: number, position: [number, number]) => ({
        observedAt: at(minutes),
        longitude: position[0],
        latitude: position[1],
        speedOverGround: 3.24,
        courseOverGround: null,
      });
      const moving = [sample(0, start), sample(firstMinutes, middle), sample(20, end)];
      const withShortReport = [
        ...moving.slice(0, 2),
        sample(firstMinutes + 1 / 60, predictionDestination(middle, 0, offsetMeters)),
        moving[2]!,
      ];
      const forecast = {
        mmsi: input.mmsi,
        asOf: at(20),
        historicalResiduals: [{ speedKnots: 0, turnDegreesPerMinute: 0 }],
      };
      const base = await predictVesselReachability({ ...forecast, observations: moving });
      const updated = await predictVesselReachability({
        ...forecast,
        observations: withShortReport,
      });
      const ensembleBearing = (result: Awaited<ReturnType<typeof predict>>) => {
        const destination: [number, number] = [
          result.paths.reduce((sum, p) => sum + p.points.at(-1)!.coordinate[0], 0) / 2048,
          result.paths.reduce((sum, p) => sum + p.points.at(-1)!.coordinate[1], 0) / 2048,
        ];
        return predictionBearing(end, destination);
      };
      const difference = Math.abs(
        ((ensembleBearing(updated) - ensembleBearing(base) + 540) % 360) - 180,
      );
      expect(difference).toBeLessThan(1);
    },
  );
  it('marks an unavailable coast constraint explicitly', async () => {
    const result = await predict(input);
    expect(result.summary.status).toBe('model_not_applicable');
    expect(result.summary.landConstraint).toBe('unavailable');
  });
  it('passes the latest-observation to forecast-origin segment to the land checker', async () => {
    const result = await predictVesselReachability(
      { ...input, asOf: '2026-10-24T00:35:00Z' },
      {
        checkPaths: async (paths) => {
          expect(paths[0]!.points[0]!.at).toBe('2026-10-24T00:30:00.000Z');
          expect(paths[0]!.points[1]!.at).toBe('2026-10-24T00:35:00Z');
          return paths.map(() => true);
        },
      },
    );
    expect(result.summary.status).toBe('ready');
    expect(result.summary.horizons[0]!.at).toBe('2026-10-24T00:50:00.000Z');
  });
  it('exposes residual provenance and the stopped-vessel departure limitation', async () => {
    const result = await predictVesselReachability({
      ...input,
      observations: observations.map((p) => ({
        ...p,
        longitude: 120,
        speedOverGround: 0,
        courseOverGround: null,
      })),
      historicalResiduals: [{ speedKnots: 1, turnDegreesPerMinute: 0.2 }],
    });
    expect(result.summary.residuals).toEqual({ source: 'historical', samples: 1 });
    expect(result.summary.limitations.some((s) => s.includes('离泊'))).toBe(true);
  });
  it('requires three valid fresh observation times', async () => {
    expect(
      (await predictVesselReachability({ ...input, observations: observations.slice(0, 2) }))
        .summary.status,
    ).toBe('insufficient_data');
    expect(
      (await predictVesselReachability({ ...input, asOf: '2026-10-24T00:41:00Z' })).summary.status,
    ).toBe('insufficient_data');
  });
  it('returns deterministic 2048 real paths and distinct position/passage probabilities', async () => {
    const a = await predictVesselReachability(input);
    const b = await predictVesselReachability(input);
    expect(a.summary).toEqual(b.summary);
    for (const id of [0, 1024, 2047]) expect(a.paths[id]).toEqual(b.paths[id]);
    expect(a.paths).toHaveLength(2048);
    expect(a.paths[0]!.points).toHaveLength(121);
    expect(a.paths[0]!.points[15]!.coordinate[0]).toBeGreaterThan(observations.at(-1)!.longitude);
    expect(a.summary.horizons.map((h) => h.minutes)).toEqual([15, 30, 60, 120]);
    for (const horizon of a.summary.horizons) {
      expect(horizon.positionCells.reduce((s, c) => s + c.probability, 0)).toBeCloseTo(1);
      expect(horizon.passageCells.every((c) => c.probability <= 1)).toBe(true);
      expect(horizon.coverage.map((c) => c.level)).toEqual([0.5, 0.8, 0.95]);
      expect(horizon.coverage[0]!.geometry.coordinates.length).toBeLessThanOrEqual(
        horizon.coverage[1]!.geometry.coordinates.length,
      );
    }
    expect(a.summary.calibration.state).toBe('uncalibrated');
  });
  it('batches full land paths once and suppresses inapplicable probability maps', async () => {
    let calls = 0;
    const result = await predictVesselReachability(input, {
      checkPaths: async (paths) => {
        calls++;
        return paths.map((_, i) => i < 100);
      },
    });
    expect(calls).toBe(1);
    expect(result.paths).toHaveLength(100);
    expect(result.summary.status).toBe('model_not_applicable');
    expect(result.summary.horizons).toEqual([]);
    expect(result.summary.rejection.land).toBe(1948);
  });
  it('derives COG across the date line and keeps geometry within geographic bounds', async () => {
    const result = await predictVesselReachability({
      ...input,
      observations: observations.map((p, i) => ({
        ...p,
        longitude: i < 2 ? 179.97 + i * 0.02 : -179.99 + (i - 2) * 0.02,
        courseOverGround: null,
      })),
    });
    expect(result.summary.status).toBe('ready');
    expect(result.summary.quality.directionSource).toBe('track');
    expect(
      result.summary.horizons
        .flatMap((h) => h.positionCells)
        .every((c) =>
          c.geometry.coordinates
            .flat()
            .every(([lon, lat]) => lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90),
        ),
    ).toBe(true);
  });
  it('keeps a stopped vessel near its latest position without inventing a direction', async () => {
    const result = await predictVesselReachability({
      ...input,
      observations: observations.map((p) => ({
        ...p,
        longitude: 120,
        speedOverGround: 0,
        courseOverGround: null,
      })),
    });
    expect(result.summary.status).toBe('ready');
    expect(result.summary.quality.motionState).toBe('stopped');
    expect(result.paths[0]!.points.at(-1)!.coordinate).toEqual([120, 20]);
  });
  it('filters impossible jumps and reports quality rejections', async () => {
    const result = await predictVesselReachability({
      ...input,
      observations: [
        ...observations.slice(0, 2),
        { ...observations[2]!, longitude: 0 },
        observations[2]!,
        observations[3]!,
      ],
    });
    expect(result.summary.status).toBe('ready');
    expect(result.summary.quality.rejectedObservations).toBeGreaterThan(0);
  });
});
