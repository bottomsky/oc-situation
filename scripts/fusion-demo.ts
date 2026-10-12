import type { Infrastructure } from '@ais/infrastructure';
import {
  createTopicInstance,
  listTopicInstances,
  saveIntelligenceEvent,
} from '@ais/infrastructure';
import {
  IntelligenceSourceSchema,
  TopicConfigSchema,
  type IntelligenceEvent,
  type TopicDefinitionId,
} from '@ais/contracts';

/** Controlled synthetic evidence uses the same persistence and worker interfaces as live sources. */
export async function seedFusionDemo(infra: Infrastructure, now = Date.now()) {
  if (infra.config.production)
    throw new Error('Synthetic fusion demo is restricted to development');
  const source = IntelligenceSourceSchema.parse({
    sourceId: 'fixture-intelligence',
    name: '演示港口公告（合成数据）',
    kind: 'fixture',
    enabled: false,
  });
  await infra.pool.query(
    'INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb) ON CONFLICT(id) DO NOTHING',
    [source.sourceId, JSON.stringify(source)],
  );
  const previous = (
    await infra.pool.query<{ event: IntelligenceEvent }>(
      'SELECT event FROM intelligence_events WHERE source_id=$1 AND external_id=$2 ORDER BY version DESC LIMIT 1',
      [source.sourceId, 'fusion-demo-port-notice'],
    )
  ).rows[0]?.event;
  const effectiveFrom = new Date(now - 24 * 3600000).toISOString();
  const effectiveTo = new Date(now + 24 * 3600000).toISOString();
  await saveIntelligenceEvent(infra, {
    sourceId: source.sourceId,
    externalId: 'fusion-demo-port-notice',
    version: (previous?.version ?? 0) + 1,
    status: previous ? 'revised' : 'active',
    category: 'port-restriction',
    title: '演示港区通行限制公告（合成数据）',
    summary: '用于验证 AIS、公告、专题推导与海图证据展示的合成公告。',
    publishedAt: new Date(now).toISOString(),
    effectiveFrom,
    effectiveTo,
    bbox: [123, 32, 126, 35],
    vesselTypes: [70],
    mmsis: [],
    commonSourceId: 'synthetic-port-authority',
    paragraphs: [
      {
        id: 'scope',
        text: `合成公告：${effectiveFrom} 至 ${effectiveTo}，示例水域内船型代码为 70 的船舶属于本次通行限制关注对象。`,
      },
    ],
    ...(previous ? { supersedesId: previous.id } : {}),
    raw: {
      synthetic: true,
      publisher: '演示机构',
      effectiveFrom,
      effectiveTo,
      bbox: [123, 32, 126, 35],
      shipType: 70,
    },
  });
  const instances = await listTopicInstances(infra);
  for (const [definitionId, name] of [
    ['port-restriction', '演示：港口限制船舶识别'],
    ['area-low-speed-notice', '演示：区域低速活动与公告关联'],
  ] satisfies [TopicDefinitionId, string][]) {
    if (
      instances.some((instance) => instance.name === name && instance.definitionId === definitionId)
    )
      continue;
    await createTopicInstance(infra, {
      definitionId,
      name,
      enabled: true,
      config: TopicConfigSchema.parse({
        bbox: [123, 32, 126, 35],
        historyHours: 24,
        windowMinutes: 60,
        minPositions: 3,
        lowSpeedKnots: 3,
        scheduleSeconds: 60,
      }),
    });
  }
}
