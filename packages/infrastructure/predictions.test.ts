import { describe, expect, it, vi } from 'vitest';
import { predictionIsStale, buildPredictionWarnings, listPredictions } from './predictions';
import type { Infrastructure } from './clients';

describe('prediction freshness and warning evidence', () => {
  it('binds a reused completed run without changing the original model clock', async () => {
    const at = new Date().toISOString();
    const metadata = {
      runId: 'original',
      inputFingerprint: 'same',
      asOf: at,
      computedAt: at,
      latestObservedAt: at,
      status: 'ready',
    };
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            payload: {
              id: 'result',
              instanceId: 'instance',
              revision: 1,
              mmsi: '413000001',
              prediction: metadata,
            },
            reuse_run_id: 'scheduled',
            reuse_fingerprint: 'same',
          },
        ],
      });
    const result = await listPredictions({ pool: { query } } as unknown as Infrastructure, 'alice');
    expect(result.items[0]).toMatchObject({
      runId: 'scheduled',
      sourceRunId: 'original',
      reused: true,
      metadata,
    });
    expect(result.items[0]).not.toHaveProperty('evidence');
  });
  it('expires after five minutes or when the latest AIS is over ten minutes old', () => {
    const now = Date.parse('2026-10-24T00:00:00.000Z');
    expect(
      predictionIsStale(
        {
          asOf: new Date(now - 301000).toISOString(),
          latestObservedAt: new Date(now - 100000).toISOString(),
          computedAt: new Date(now).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      predictionIsStale(
        {
          asOf: new Date(now).toISOString(),
          latestObservedAt: new Date(now - 601000).toISOString(),
          computedAt: new Date(now).toISOString(),
        },
        now,
      ),
    ).toBe(true);
    expect(
      predictionIsStale(
        {
          asOf: new Date(now).toISOString(),
          latestObservedAt: new Date(now - 60000).toISOString(),
          computedAt: new Date(now).toISOString(),
        },
        now,
      ),
    ).toBe(false);
  });
  it('only admits reviewed exact geometry with confirmed applicability and finite lifetime', () => {
    const document = {
      id: 'doc',
      version: 1,
      sourceId: 's',
      externalId: 'x',
      title: '航警',
      status: 'active',
      category: 'navigation-warning',
      reviewStatus: 'confirmed',
      effectiveFrom: '2026-10-24T00:00:00.000Z',
      effectiveTo: '2026-10-24T02:00:00.000Z',
      vesselTypes: [],
      mmsis: [],
      raw: { applicabilityConfirmed: true },
      paragraphs: [],
    };
    const relation = {
      id: 'rel',
      eventId: 'doc',
      revision: 1,
      kind: 'applies-to',
      reviewStatus: 'confirmed',
      origin: 'manual',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [120, 20],
            [121, 20],
            [121, 21],
            [120, 20],
          ],
        ],
      },
    };
    expect(buildPredictionWarnings([document], [relation]).warnings).toHaveLength(1);
    expect(
      buildPredictionWarnings([document], [{ ...relation, origin: 'legacy' }]).warnings,
    ).toHaveLength(0);
    expect(
      buildPredictionWarnings([document], [{ ...relation, kind: 'occurs-at' }]).warnings,
    ).toHaveLength(0);
    expect(
      buildPredictionWarnings([document], [{ ...relation, reviewStatus: 'candidate' }]).warnings,
    ).toHaveLength(0);
    expect(buildPredictionWarnings([document], []).skipped).toContainEqual({
      warningId: 'doc',
      reason: 'confirmed_exact_applicability_geometry_required',
    });
    const bounded = buildPredictionWarnings(
      [document],
      [
        {
          ...relation,
          effectiveFrom: '2026-10-23T23:00:00.000Z',
          effectiveTo: '2026-10-24T03:00:00.000Z',
        },
      ],
    ).warnings[0];
    expect(bounded).toMatchObject({
      effectiveFrom: document.effectiveFrom,
      effectiveTo: document.effectiveTo,
    });
    expect(
      buildPredictionWarnings(
        [document, { ...document, id: 'revision', version: 2, status: 'withdrawn' }],
        [relation],
      ).warnings,
    ).toHaveLength(0);
    expect(
      buildPredictionWarnings([{ ...document, effectiveTo: null }], [relation]).warnings,
    ).toHaveLength(0);
    expect(buildPredictionWarnings([{ ...document, raw: {} }], [relation]).warnings).toHaveLength(
      0,
    );
    expect(
      buildPredictionWarnings([{ ...document, status: 'withdrawn' }], [relation]).warnings,
    ).toHaveLength(0);
  });
});
