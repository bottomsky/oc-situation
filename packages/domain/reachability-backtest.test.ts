import { describe, expect, it } from 'vitest';
import {
  runReachabilityBacktest,
  splitReachabilityVoyages,
  trainMotionResiduals,
} from './reachability-backtest';
import type { ReachabilityBacktestVoyage } from './reachability-backtest';
import { predictVesselReachability } from './reachability';

const voyage = (id: string, day: number): ReachabilityBacktestVoyage => ({
  voyageId: id,
  mmsi: '413000001',
  observations: Array.from({ length: 19 }, (_, i) => ({
    observedAt: new Date(Date.UTC(2026, 9, day, 0, i * 10)).toISOString(),
    longitude: 120 + i * 0.02,
    latitude: 20,
    speedOverGround: 6.76,
    courseOverGround: 90,
  })),
  forecastAt: new Date(Date.UTC(2026, 9, day, 1)).toISOString(),
});
describe('temporally isolated reachability backtest', () => {
  it('uses the same accepted last observation for the model and constant-motion baseline', async () => {
    const dirty = voyage('jump', 24);
    dirty.observations = dirty.observations.map((p, i) =>
      i === 6 ? { ...p, longitude: 0, latitude: 0 } : p,
    );
    const model = await predictVesselReachability(
      { mmsi: dirty.mmsi, asOf: dirty.forecastAt, observations: dirty.observations },
      { checkPaths: async (paths) => paths.map(() => false) },
    );
    expect(model.summary.inputWindow.to).toBe('2026-10-24T00:50:00.000Z');
    const report = await runReachabilityBacktest({
      voyages: [dirty],
      splitAt: '2026-10-23T00:00:00Z',
      dependencies: { checkPaths: async (paths) => paths.map(() => true) },
    });
    expect(report.samples).toHaveLength(4);
    for (const sample of report.samples) {
      expect(sample.inputLatestAt).toBe(model.summary.inputWindow.to);
      expect(sample.baselineErrorMeters).toBeLessThan(100);
    }
  });
  it('skips baseline comparison when fewer than two clean historical observations remain', async () => {
    const dirty = voyage('too-few-clean', 24);
    dirty.observations = [
      dirty.observations[0]!,
      { ...dirty.observations[6]!, longitude: 0, latitude: 0 },
      ...dirty.observations.slice(7),
    ];
    const report = await runReachabilityBacktest({
      voyages: [dirty],
      splitAt: '2026-10-23T00:00:00Z',
      dependencies: { checkPaths: async (paths) => paths.map(() => true) },
    });
    expect(report.samples).toEqual([]);
    expect(report.skipped).toEqual([
      { voyageId: 'too-few-clean', reason: 'insufficient_clean_observations_for_baseline' },
    ]);
  });
  it('resets residual state across missing intervals rather than learning a cross-gap turn', () => {
    const input = voyage('training', 22);
    input.observations = [0, 10, 60, 70].map((minute, index) => ({
      observedAt: new Date(Date.UTC(2026, 9, 22, 0, minute)).toISOString(),
      latitude: 20,
      longitude: 120 + index * 0.01,
    }));
    expect(trainMotionResiduals([input])).toEqual([]);
  });
  it('scores positive and negative warning examples against held-out observed segments', async () => {
    const test = voyage('test', 24);
    test.warnings = [
      ['positive', 120.1],
      ['negative', 0],
    ].map(([id, lon]) => ({
      id,
      reviewStatus: 'confirmed',
      effectiveFrom: '2026-10-24T01:00:00Z',
      effectiveTo: '2026-10-24T02:00:00Z',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [Number(lon), 19],
            [Number(lon) + 0.1, 19],
            [Number(lon) + 0.1, 21],
            [Number(lon), 21],
            [Number(lon), 19],
          ],
        ],
      },
      applicability: { kind: 'all' },
    }));
    const result = await runReachabilityBacktest({
      voyages: [voyage('train', 22), test],
      splitAt: '2026-10-23T00:00:00Z',
      dependencies: { checkPaths: async (paths) => paths.map(() => true) },
    });
    expect(result.metrics.positiveImpactSamples).toBe(1);
    expect(result.metrics.negativeImpactSamples).toBe(1);
    expect(result.metrics.impactBrierScore).toBe(0);
  });
  it('isolates complete voyage ids and observation times across train and test', () => {
    const split = splitReachabilityVoyages(
      [voyage('train', 22), voyage('test', 24)],
      '2026-10-23T00:00:00Z',
    );
    expect(split.train.map((v) => v.voyageId)).toEqual(['train']);
    expect(split.test.map((v) => v.voyageId)).toEqual(['test']);
    expect(() =>
      splitReachabilityVoyages([voyage('same', 22), voyage('same', 24)], '2026-10-23T00:00:00Z'),
    ).toThrow('voyage');
  });
  it('executes held out forecasts, evaluates baseline and reports coverage area and Brier outcomes', async () => {
    const report = await runReachabilityBacktest({
      voyages: [voyage('train', 22), voyage('test', 24)],
      splitAt: '2026-10-23T00:00:00Z',
      dependencies: { checkPaths: async (paths) => paths.map(() => true) },
    });
    expect(report.trainingVoyages).toEqual(['train']);
    expect(report.testVoyages).toEqual(['test']);
    expect(report.samples).toHaveLength(4);
    expect(report.samples.map((s) => s.minutes)).toEqual([15, 30, 60, 120]);
    expect(
      report.samples.every(
        (s) => s.errorMeters >= 0 && s.baselineErrorMeters >= 0 && s.brierScore >= 0,
      ),
    ).toBe(true);
    expect(
      report.samples.every(
        (s) => s.coverage.length === 3 && s.coverage.every((c) => c.areaSquareKm > 0),
      ),
    ).toBe(true);
    expect(report.calibrationState).toBe('uncalibrated');
    expect(report.samples[0]!.inputLatestAt).toBe('2026-10-24T01:00:00.000Z');
  });
});
