import { createHash } from 'node:crypto';
import type {
  AnalysisResult,
  TopicAisEvidence,
  TopicDataset,
  TopicDefinition,
  TopicInstance,
} from '../contracts/topics';

export const TOPIC_DEFINITIONS: readonly TopicDefinition[] = [
  {
    id: 'port-restriction',
    name: '港口限制船舶识别',
    version: '1.0.0',
    description: '在公告生效时段和限制区域内，将 AIS 船型或 MMSI 与公告限制对象逐项匹配。',
    requiredCapabilities: ['ais.history', 'intelligence.history'],
    available: true,
  },
  {
    id: 'area-low-speed-notice',
    name: '区域低速活动与公告关联',
    version: '1.0.0',
    description: '观察公告区域和生效时段内的多点低速活动，提供共现证据，不推断公告造成船舶行为。',
    requiredCapabilities: ['ais.history', 'intelligence.history'],
    available: true,
  },
];
export const FUSION_CAPABILITIES = {
  'ais.history': true,
  'intelligence.history': true,
  'graph.query': false,
} as const;
export function assertTopicCapabilities(required: readonly string[]) {
  const missing = required.filter(
    (key) => !FUSION_CAPABILITIES[key as keyof typeof FUSION_CAPABILITIES],
  );
  if (missing.length) throw new Error(`Required capabilities unavailable: ${missing.join(', ')}`);
}
export function containsPoint(bbox: readonly number[], point: TopicAisEvidence): boolean {
  const [west, south, east, north] = bbox as [number, number, number, number];
  return (
    point.latitude >= south &&
    point.latitude <= north &&
    (west <= east
      ? point.longitude >= west && point.longitude <= east
      : point.longitude >= west || point.longitude <= east)
  );
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
export function analysisIdentity(
  instance: TopicInstance,
  document: TopicDataset['intelligence'][number],
  vesselId: string,
) {
  return hash(
    JSON.stringify([
      instance.id,
      instance.definitionId,
      document.sourceId,
      document.externalId,
      vesselId,
    ]),
  );
}
function lowSpeedEpisode(points: TopicAisEvidence[], instance: TopicInstance) {
  const slow = points.filter(
    (p) => p.speedOverGround !== null && p.speedOverGround <= instance.config.lowSpeedKnots,
  );
  let left = 0;
  for (let right = 0; right < slow.length; right++) {
    while (
      Date.parse(slow[right]!.occurredAt) - Date.parse(slow[left]!.occurredAt) >
      instance.config.windowMinutes * 60_000
    )
      left++;
    const window = slow.slice(left, right + 1);
    if (new Set(window.map((p) => Date.parse(p.occurredAt))).size >= instance.config.minPositions)
      return window;
  }
  return [];
}
export function evaluateTopic(instance: TopicInstance, dataset: TopicDataset): AnalysisResult[] {
  if (dataset.truncated) throw new Error('Truncated dataset cannot support a complete analysis');
  const definition = TOPIC_DEFINITIONS.find((d) => d.id === instance.definitionId);
  if (!definition) throw new Error('Unknown topic definition');
  assertTopicCapabilities(definition.requiredCapabilities);
  const positions = [...new Map(dataset.ais.map((p) => [p.recordId, p])).values()]
    .filter(
      (p) =>
        Date.parse(p.occurredAt) >= Date.parse(dataset.from) &&
        Date.parse(p.occurredAt) <= Date.parse(dataset.to) &&
        containsPoint(instance.config.bbox, p),
    )
    .sort(
      (a, b) =>
        Date.parse(a.occurredAt) - Date.parse(b.occurredAt) || a.recordId.localeCompare(b.recordId),
    );
  // A source's latest revision supersedes all older revisions, including a withdrawal.
  const documents = new Map<string, TopicDataset['intelligence'][number]>();
  for (const document of dataset.intelligence) {
    const key = JSON.stringify([document.sourceId, document.externalId]);
    if ((documents.get(key)?.version ?? -1) < document.version) documents.set(key, document);
  }
  const results: AnalysisResult[] = [];
  for (const document of documents.values()) {
    const raw = document.raw as Record<string, unknown>;
    if (
      raw &&
      (raw.requiresEffectiveTimeReview === true || raw.requiresOccurrenceTimeReview === true) &&
      raw.manualTimeConfirmed !== true
    )
      continue;
    if (
      !document.bbox ||
      document.status === 'withdrawn' ||
      (document.reviewStatus ?? 'confirmed') !== 'confirmed'
    )
      continue;
    if (
      instance.definitionId === 'area-low-speed-notice' &&
      !['notice', 'navigation-warning', 'port-restriction'].includes(document.kind)
    )
      continue;
    if (instance.definitionId === 'port-restriction' && document.kind !== 'port-restriction')
      continue;
    const vessels = new Map<string, TopicAisEvidence[]>();
    for (const point of positions) {
      if (
        Date.parse(point.occurredAt) < Date.parse(document.effectiveFrom) ||
        (document.effectiveTo && Date.parse(point.occurredAt) > Date.parse(document.effectiveTo)) ||
        !containsPoint(document.bbox, point)
      )
        continue;
      if (
        instance.definitionId === 'port-restriction' &&
        (document.mmsis.length > 0 || document.vesselTypes.length > 0) &&
        !document.mmsis.includes(point.mmsi) &&
        (point.shipType === null || !document.vesselTypes.includes(point.shipType))
      )
        continue;
      const vesselKey = point.vesselId ?? point.mmsi;
      const group = vessels.get(vesselKey) ?? [];
      group.push(point);
      vessels.set(vesselKey, group);
    }
    for (const [vesselKey, matches] of vessels) {
      const points =
        instance.definitionId === 'area-low-speed-notice'
          ? lowSpeedEpisode(matches, instance)
          : matches;
      if (!points.length) continue;
      const mmsi = points[0]!.mmsi;
      const id = analysisIdentity(instance, document, vesselKey);
      results.push({
        id,
        instanceId: instance.id,
        definitionId: definition.id,
        definitionVersion: definition.version,
        revision: 1,
        status: 'active',
        title: `${definition.name} · ${mmsi}`,
        summary:
          instance.definitionId === 'port-restriction'
            ? `船舶 ${mmsi} 的 ${points.length} 个 AIS 点位满足《${document.title}》的生效时间、区域和限制对象规则，需结合原文人工核验。`
            : `船舶 ${mmsi} 在《${document.title}》覆盖时空范围内存在 ${points.length} 个低速观测点。这是时空共现观察，不能推断因果关系。`,
        mmsi,
        vesselId: points[0]!.vesselId,
        documentId: document.id,
        from: points[0]!.occurredAt,
        to: points.at(-1)!.occurredAt,
        bbox: structuredClone(document.bbox),
        confidence: instance.definitionId === 'port-restriction' ? 'rule-match' : 'observation',
        evidence: {
          ais: structuredClone(points),
          documents: [structuredClone(document)],
          steps: [
            {
              id: 'time',
              rule: 'AIS时间位于公告生效时段与查询窗口交集',
              outcome: `${points.length} 个点位满足时间约束`,
              references: points.map((p) => p.recordId),
            },
            {
              id: 'space',
              rule: 'AIS点位位于专题区域与公告边界框交集',
              outcome: '经纬度逐点匹配通过；边界框为近似区域',
              references: [document.id, ...points.map((p) => p.recordId)],
            },
            {
              id: 'behavior',
              rule:
                instance.definitionId === 'port-restriction'
                  ? document.mmsis.length || document.vesselTypes.length
                    ? 'MMSI 或公告列明的船型匹配'
                    : '公告未限定船型或 MMSI，适用于区域内全部船舶'
                  : `至少 ${instance.config.minPositions} 个不同时间观测，速度 ≤ ${instance.config.lowSpeedKnots} 节，窗口 ≤ ${instance.config.windowMinutes} 分钟`,
              outcome:
                instance.definitionId === 'port-restriction'
                  ? '限制对象规则命中，待人工核验'
                  : '低速时空共现观察成立',
              references: [
                document.id,
                ...document.paragraphs.map((p) => p.id),
                ...points.map((p) => p.recordId),
              ],
            },
          ],
          limitations: [
            'AIS 可能存在延迟、缺失或标识误报。',
            '公告空间范围使用边界框近似，需要结合原文核验。',
            ...(instance.definitionId === 'area-low-speed-notice'
              ? ['共现观察不能确定因果、违法事实或船舶意图。']
              : ['规则匹配需要人工核验，不能单独认定违规。']),
          ],
          parameters: structuredClone(instance.config),
          queriedAt: dataset.queriedAt,
        },
        createdAt: dataset.queriedAt,
        updatedAt: dataset.queriedAt,
      });
    }
  }
  return results;
}
