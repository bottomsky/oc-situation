import { intelligenceSampleLabel } from './app/utils/intelligenceLabels';
import { expect, it } from 'vitest';
import {
  createIntelligenceInput,
  parseIntelligenceGeoJSON,
  intelligenceTimePending,
} from './app/utils/intelligenceForm';
it('修订保留来源链与递增版本，将每个原文段落转为独立证据', () => {
  const input = createIntelligenceInput(
    {
      sourceId: 'manual',
      externalId: 'n1',
      title: '测试',
      summary: '摘要',
      category: 'notice',
      publishedAt: '2026-10-11T08:00',
      effectiveFrom: '2026-10-11T08:00',
      effectiveTo: '',
      text: '第一段\n\n第二段',
      reviewStatus: 'candidate',
      originalUrl: '',
    },
    { id: 'old', version: 2 },
    'withdrawn',
  );
  expect(input.version).toBe(3);
  expect(input.supersedesId).toBe('old');
  expect(input.status).toBe('withdrawn');
  expect(input.paragraphs).toHaveLength(2);
  expect(input.publishedAt).toBe('2026-10-11T08:00:00.000Z');
});

it('修订继承范围与来源归档，关系转待核实；有效时间缺失拒绝人工确认', () => {
  const form = {
    sourceId: 'manual',
    externalId: 'n',
    title: '修订',
    summary: '',
    category: 'notice',
    publishedAt: '2026-10-11T08:00',
    effectiveFrom: '2026-10-11T09:00',
    effectiveTo: '',
    text: '原文',
    reviewStatus: 'candidate',
    originalUrl: '',
  };
  const previous = {
    id: 'old',
    version: 1,
    raw: { requiresEffectiveTimeReview: true },
    originalArchiveId: 'a'.repeat(64),
    bbox: [120, 30, 122, 32] as [number, number, number, number],
    mmsis: ['413793000'],
    vesselTypes: [70],
    paragraphs: [{ id: 'p1', text: '原文' }],
  };
  const relations = [
    {
      id: 'r',
      eventId: 'old',
      revision: 1,
      recordedAt: '2026-10-11T08:00:00Z',
      kind: 'mentions' as const,
      objectId: 'port',
      basis: '原文依据',
      paragraphIds: ['p1'],
      reviewStatus: 'confirmed' as const,
      origin: 'manual' as const,
    },
  ];
  const input = createIntelligenceInput(form, previous, 'revised', relations);
  expect(input.bbox).toEqual(previous.bbox);
  expect(input.mmsis).toEqual(previous.mmsis);
  expect(input.originalArchiveId).toBe(previous.originalArchiveId);
  expect(input.relations[0]?.reviewStatus).toBe('candidate');
  expect(input.relations[0]?.basis).toContain('old');
  expect(input.raw).toMatchObject({
    manualTimeConfirmed: true,
    requiresEffectiveTimeReview: false,
  });
  expect(createIntelligenceInput(form, previous, 'withdrawn', relations).relations).toEqual([]);
  expect(() => createIntelligenceInput({ ...form, effectiveFrom: '' }, previous)).toThrow();
});

it('GeoJSON在归档前校验全部记录，几何在同一公告事务作为候选关联', () => {
  const form = {
    sourceId: 'manual',
    externalId: 'n',
    title: '情报',
    summary: '',
    category: 'notice',
    publishedAt: '2026-10-11T08:00',
    effectiveFrom: '2026-10-11T09:00',
    effectiveTo: '',
    text: '原文',
    reviewStatus: 'candidate',
    originalUrl: '',
  };
  const properties = createIntelligenceInput(form);
  const feature = {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [122, 31] },
  };
  const inputs = parseIntelligenceGeoJSON({ type: 'FeatureCollection', features: [feature] });
  expect(inputs[0]?.relations[0]).toMatchObject({
    kind: 'occurs-at',
    reviewStatus: 'candidate',
    geometry: feature.geometry,
  });
  expect(() =>
    parseIntelligenceGeoJSON({
      type: 'FeatureCollection',
      features: [feature, { ...feature, geometry: { type: 'Point', coordinates: [999, 31] } }],
    }),
  ).toThrow();
});

it('人工明确有效时间后可确认，来源观测时间保持待确认', () => {
  expect(intelligenceTimePending({ requiresOccurrenceTimeReview: true })).toBe(true);
  expect(
    intelligenceTimePending({ requiresOccurrenceTimeReview: true, manualTimeConfirmed: true }),
  ).toBe(false);
});

it('样例标签只接受明确synthetic标志，不将待审核真实情报作为样例', () => {
  expect(intelligenceSampleLabel(true)).toBe('样例数据');
  expect(intelligenceSampleLabel(false)).toBe('');
  expect(intelligenceSampleLabel('candidate')).toBe('');
  expect(intelligenceSampleLabel(undefined)).toBe('');
});
