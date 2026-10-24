import type { Bbox, IntelligenceRelation, IntelligenceRelationInput } from '@ais/contracts';
import { IntelligenceInputSchema } from '@ais/contracts';
export interface IntelligenceForm {
  sourceId: string;
  externalId: string;
  title: string;
  summary: string;
  category: string;
  publishedAt: string;
  effectiveFrom: string;
  effectiveTo: string;
  text: string;
  reviewStatus: string;
  originalUrl: string;
  applicabilityConfirmed?: boolean;
}
export function createIntelligenceInput(
  form: IntelligenceForm,
  previous?: {
    id: string;
    version: number;
    raw?: unknown;
    originalArchiveId?: string;
    bbox?: Bbox;
    mmsis?: string[];
    vesselTypes?: number[];
    commonSourceId?: string;
    paragraphs?: { id: string; text: string }[];
  },
  status = 'active',
  inheritedRelations: IntelligenceRelation[] = [],
) {
  const utc = (value: string) => new Date(value.endsWith('Z') ? value : value + 'Z').toISOString();
  if (
    form.applicabilityConfirmed &&
    ((previous?.mmsis?.length ?? 0) > 0 || (previous?.vesselTypes?.length ?? 0) > 0)
  )
    throw new Error('全船适用确认与限定船舶或船型条件冲突，请核实适用范围');
  if (!form.effectiveFrom) throw new Error('请填写实际有效时间（UTC）');
  const paragraphs = form.text
    .split(/\n\s*\n/)
    .filter((p) => p.trim())
    .map((text, index) => ({ id: 'p' + (index + 1), text: text.trim() }));
  const relations: IntelligenceRelationInput[] =
    status === 'withdrawn'
      ? []
      : inheritedRelations
          .filter((r) => r.reviewStatus !== 'rejected')
          .map((r) => ({
            kind: r.kind,
            objectId: r.objectId,
            geometry: r.geometry,
            basis: `沿用上一版本 ${previous?.id} 关系 ${r.id}，重新核实：${r.basis}`,
            paragraphIds: r.paragraphIds.filter((id) => {
              const old = previous?.paragraphs?.find((p) => p.id === id);
              return !!old && paragraphs.some((p) => p.id === id && p.text === old.text);
            }),
            reviewStatus: 'candidate',
            origin: 'manual',
            impactType: r.impactType,
            effectiveFrom: r.effectiveFrom,
            effectiveTo: r.effectiveTo,
          }));
  return IntelligenceInputSchema.parse({
    sourceId: form.sourceId,
    externalId: form.externalId,
    title: form.title,
    summary: form.summary,
    category: form.category,
    publishedAt: utc(form.publishedAt),
    effectiveFrom: utc(form.effectiveFrom),
    effectiveTo: form.effectiveTo ? utc(form.effectiveTo) : null,
    reviewStatus: form.reviewStatus,
    status,
    version: previous ? previous.version + 1 : 1,
    ...(previous ? { supersedesId: previous.id } : {}),
    ...(form.originalUrl ? { originalUrl: form.originalUrl } : {}),
    paragraphs,
    relations,
    ...(previous?.bbox ? { bbox: previous.bbox } : {}),
    ...(previous?.mmsis ? { mmsis: previous.mmsis } : {}),
    ...(previous?.vesselTypes ? { vesselTypes: previous.vesselTypes } : {}),
    ...(previous?.commonSourceId ? { commonSourceId: previous.commonSourceId } : {}),
    ...(previous?.originalArchiveId ? { originalArchiveId: previous.originalArchiveId } : {}),
    raw: {
      ...(previous?.raw && typeof previous.raw === 'object' ? previous.raw : {}),
      enteredManually: true,
      ...(form.applicabilityConfirmed !== undefined
        ? { applicabilityConfirmed: form.applicabilityConfirmed }
        : {}),
      manualTimeConfirmed: true,
      manualTimeBasis: '操作员填写有效期（UTC）：' + form.effectiveFrom,
      requiresEffectiveTimeReview: false,
      requiresOccurrenceTimeReview: false,
    },
  });
}

export function parseIntelligenceGeoJSON(
  value: unknown,
): ReturnType<typeof createIntelligenceInput>[] {
  const collection = value as {
    type?: string;
    features?: { type: string; properties: unknown; geometry: unknown }[];
  };
  if (
    collection?.type !== 'FeatureCollection' ||
    !Array.isArray(collection.features) ||
    !collection.features.length ||
    collection.features.length > 1000
  )
    throw new Error('需要含 1～1000 条记录的 GeoJSON FeatureCollection');
  return collection.features.map((feature) => {
    if (feature.type !== 'Feature') throw new Error('需要 GeoJSON Feature');
    const input = IntelligenceInputSchema.parse(feature.properties);
    return IntelligenceInputSchema.parse({
      ...input,
      relations: [
        ...(input.relations ?? []),
        {
          kind: 'occurs-at',
          geometry: feature.geometry,
          basis: '从来源 GeoJSON 几何导入，需人工核实',
          paragraphIds: [],
          reviewStatus: 'candidate',
          origin: 'source',
        },
      ],
    });
  });
}

export function intelligenceTimePending(raw: unknown) {
  const value = raw as Record<string, unknown> | null;
  return (
    value?.manualTimeConfirmed !== true &&
    !!(value?.requiresEffectiveTimeReview || value?.requiresOccurrenceTimeReview)
  );
}
