import { describe, expect, it } from 'vitest';
import { evaluateTopic } from './topics';
import type { TopicDataset, TopicInstance } from '../contracts/topics';

const instance: TopicInstance = {
  id: 'test',
  definitionId: 'port-restriction',
  name: '试验',
  enabled: true,
  generation: 1,
  status: 'ready',
  checkpoint: null,
  lastRunAt: null,
  lastError: null,
  createdAt: '2026-10-01T00:00:00.000Z',
  config: {
    bbox: [120, 20, 123, 24],
    historyHours: 24,
    windowMinutes: 60,
    lowSpeedKnots: 3,
    minPositions: 3,
    scheduleSeconds: 60,
  },
};
const data: TopicDataset = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-02T00:00:00.000Z',
  queriedAt: '2026-10-02T00:00:00.000Z',
  ais: [0, 1, 2].map((i) => ({
    recordId: `point-${i}`,
    mmsi: '413123456',
    occurredAt: `2026-10-01T12:${i}0:00.000Z`,
    longitude: 121,
    latitude: 22,
    speedOverGround: 2,
    shipType: 70,
    raw: { message: i },
  })),
  intelligence: [
    {
      id: 'notice-1',
      sourceId: 'authority',
      externalId: 'a1',
      version: 1,
      status: 'active',
      kind: 'port-restriction',
      title: '港口限制',
      effectiveFrom: '2026-10-01T00:00:00.000Z',
      effectiveTo: '2026-10-02T00:00:00.000Z',
      bbox: [120.5, 21, 121.5, 23],
      vesselTypes: [70],
      mmsis: [],
      paragraphs: [{ id: 'p1', text: '货船限制通行' }],
      raw: { original: '货船限制通行' },
    },
  ],
};
describe('topic rules', () => {
  it('matches actual time, area, vessel rule and freezes original evidence', () => {
    const [result] = evaluateTopic(instance, data);
    expect(result?.mmsi).toBe('413123456');
    expect(result?.evidence.ais).toHaveLength(3);
    expect(result?.evidence.documents[0]?.raw).toEqual({ original: '货船限制通行' });
    expect(result?.evidence.steps).toHaveLength(3);
    expect(evaluateTopic(instance, structuredClone(data))[0]?.id).toBe(result?.id);
  });
  it('does not treat unrelated documents or missing coordinates as a match', () => {
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({ ...d, bbox: null })),
      }),
    ).toEqual([]);
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({ ...d, vesselTypes: [80] })),
      }),
    ).toEqual([]);
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({
          ...d,
          effectiveFrom: '2026-10-03T00:00:00.000Z',
        })),
      }),
    ).toEqual([]);
  });
  it('excludes withdrawn notices and rejects truncated input', () => {
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({ ...d, status: 'withdrawn' })),
      }),
    ).toEqual([]);
    expect(() => evaluateTopic(instance, { ...data, truncated: true })).toThrow(/truncat/i);
  });
  it('requires independent low-speed samples within a bounded window and labels observation', () => {
    const low = { ...instance, definitionId: 'area-low-speed-notice' as const };
    expect(evaluateTopic(low, data)[0]?.confidence).toBe('observation');
    expect(evaluateTopic(low, data)[0]?.summary).toContain('不能推断因果');
    expect(
      evaluateTopic(low, { ...data, ais: [data.ais[0]!, data.ais[0]!, data.ais[0]!] }),
    ).toEqual([]);
    expect(
      evaluateTopic(low, { ...data, ais: data.ais.map((p) => ({ ...p, speedOverGround: 5 })) }),
    ).toEqual([]);
  });
  it('does not infer one sustained low-speed episode from sparse samples outside the window', () => {
    const low = {
      ...instance,
      definitionId: 'area-low-speed-notice' as const,
      config: { ...instance.config, windowMinutes: 5 },
    };
    expect(evaluateTopic(low, data)).toEqual([]);
  });
  it('matches all vessels when the restriction explicitly has no vessel filters', () => {
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({ ...d, vesselTypes: [], mmsis: [] })),
      }),
    ).toHaveLength(1);
  });
  it('separates two stable vessel identities even when they reuse the same MMSI', () => {
    const ais = data.ais.map((p, i) => ({ ...p, vesselId: i === 0 ? 'vessel-a' : 'vessel-b' }));
    expect(new Set(evaluateTopic(instance, { ...data, ais }).map((r) => r.vesselId))).toEqual(
      new Set(['vessel-a', 'vessel-b']),
    );
  });
  it('compares instants rather than timestamp formatting at effective boundaries', () => {
    const single = data.ais[0]!;
    const bounded = {
      ...data,
      ais: [single],
      intelligence: data.intelligence.map((d) => ({
        ...d,
        effectiveFrom: single.occurredAt.replace('.000', ''),
        effectiveTo: single.occurredAt.replace('.000', ''),
      })),
    };
    expect(evaluateTopic(instance, bounded)).toHaveLength(1);
  });
  it('does not count different timestamp precision as independent low-speed observations', () => {
    const point = data.ais[0]!;
    const timestamps = [
      '2026-10-01T12:00:00Z',
      '2026-10-01T12:00:00.000Z',
      '2026-10-01T12:00:00.000000Z',
    ];
    const ais = timestamps.map((occurredAt, i) => ({
      ...point,
      recordId: `source-${i}`,
      occurredAt,
    }));
    expect(
      evaluateTopic({ ...instance, definitionId: 'area-low-speed-notice' }, { ...data, ais }),
    ).toEqual([]);
  });
});
it('excludes unconfirmed evidence and unrelated categories from formal topics', () => {
  for (const reviewStatus of ['candidate', 'rejected']) {
    expect(
      evaluateTopic(instance, {
        ...data,
        intelligence: data.intelligence.map((d) => ({ ...d, reviewStatus })),
      }),
    ).toEqual([]);
  }
  expect(
    evaluateTopic(
      { ...instance, definitionId: 'area-low-speed-notice' },
      { ...data, intelligence: data.intelligence.map((d) => ({ ...d, kind: 'weather' })) },
    ),
  ).toEqual([]);
});

it('requires manual effective time confirmation for publication-only candidates', () => {
  expect(
    evaluateTopic(instance, {
      ...data,
      intelligence: data.intelligence.map((d) => ({
        ...d,
        reviewStatus: 'confirmed',
        raw: { requiresEffectiveTimeReview: true },
      })),
    }),
  ).toEqual([]);
  expect(
    evaluateTopic(instance, {
      ...data,
      intelligence: data.intelligence.map((d) => ({
        ...d,
        reviewStatus: 'confirmed',
        raw: { requiresEffectiveTimeReview: true, manualTimeConfirmed: true },
      })),
    }),
  ).toHaveLength(1);
});
