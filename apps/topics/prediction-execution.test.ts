import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import type { TopicLease } from '../../packages/infrastructure/topics';
import type { IntelligenceEvent } from '../../packages/contracts/intelligence';
import { AnalysisResultSchema, TopicConfigSchema } from '../../packages/contracts/topics';
import { predictVesselReachability } from '../../packages/domain/reachability';
import type { PredictionWorkerInput } from './prediction-worker-client';

const mocks = vi.hoisted(() => ({
  dataset: vi.fn(),
  query: vi.fn(),
  training: vi.fn(),
  land: vi.fn(),
  save: vi.fn(),
  worker: vi.fn(),
}));
vi.mock('../../packages/infrastructure/fusion-data', () => ({ queryFusionDataset: mocks.dataset }));
vi.mock('../../packages/infrastructure/predictions-history', () => ({
  readPredictionTrainingHistory: mocks.training,
}));
vi.mock('../../packages/infrastructure/predictions-land', () => ({
  predictionQuery: mocks.query,
  activePredictionLandDataset: mocks.land,
  checkPredictionPaths: vi.fn(),
}));
vi.mock('../../packages/infrastructure/topics', () => ({ saveTopicInput: mocks.save }));
vi.mock('./prediction-worker-client', () => ({ executePredictionWorker: mocks.worker }));
import { executePredictionTopic } from './prediction-execution';

const asOf = '2026-10-25T00:00:00.000Z';
const mmsi = '574700544';
const infra = {} as Infrastructure;
const lease = {
  token: 'lease',
  instance: {
    id: 'instance',
    definitionId: 'vessel-reachability',
    config: TopicConfigSchema.parse({ bbox: [-180, -90, 180, 90], mmsi }),
  },
  run: { id: 'run', trigger: 'manual' },
} as TopicLease;
function document(index: number, changes: Partial<IntelligenceEvent> = {}): IntelligenceEvent {
  return {
    id: `document-${String(index).padStart(4, '0')}`,
    sourceId: 'source',
    externalId: `warning-${index}`,
    version: 1,
    status: 'active',
    category: 'navigation-warning',
    reviewStatus: 'confirmed',
    title: `航警 ${index}`,
    summary: '公告原文',
    publishedAt: asOf,
    effectiveFrom: asOf,
    effectiveTo: '2026-10-25T02:00:00.000Z',
    vesselTypes: [],
    mmsis: [],
    paragraphs: [{ id: 'p', text: '公告原文' }],
    raw: { applicabilityConfirmed: true },
    archiveKey: 'archive',
    checksum: 'checksum',
    recordedAt: asOf,
    ...changes,
  };
}
function relation(doc: IntelligenceEvent, index = 0) {
  return {
    id: `${doc.id}-relation-${String(index).padStart(4, '0')}`,
    eventId: doc.id,
    revision: 1,
    reviewStatus: 'confirmed',
    origin: 'manual',
    kind: 'applies-to',
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
}
async function fixture(
  documents: IntelligenceEvent[],
  relations = documents.map((doc) => relation(doc)),
) {
  mocks.dataset.mockResolvedValue({
    from: asOf,
    to: asOf,
    queriedAt: asOf,
    ais: [],
    intelligence: documents,
  });
  mocks.training.mockResolvedValue({
    from: asOf,
    to: asOf,
    selection: 'fixture',
    observations: [],
  });
  mocks.land.mockResolvedValue(null);
  mocks.save.mockResolvedValue(undefined);
  mocks.query.mockImplementation(async (_infra: Infrastructure, sql: string, values: unknown[]) => {
    if (sql.includes('intelligence_relations')) {
      const ids = values[0] as string[];
      const after = typeof values[1] === 'string' ? values[1] : '';
      return {
        rows: relations
          .filter((item) => ids.includes(item.eventId) && item.id > after)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, sql.includes('LIMIT 1001') ? 1001 : 1000)
          .map((item) => ({ id: item.id, relation: item })),
      };
    }
    return { rows: [] };
  });
  const prediction = await predictVesselReachability({ mmsi, asOf, observations: [] });
  mocks.worker.mockImplementation(async (request: PredictionWorkerInput) => ({
    prediction,
    impacts: request.warnings.map((warning, index) => ({
      warningId: warning.id,
      documentId: request.warningReferences?.[index]?.documentId,
      relationId: request.warningReferences?.[index]?.relationId,
      relationRevision: request.warningReferences?.[index]?.revision,
      probability: index === request.warnings.length - 1 ? 1 : 0,
      hitPaths: index === request.warnings.length - 1 ? 1 : 0,
      totalPaths: 1,
      confidenceInterval: [0, 1],
      firstEntry: null,
      calibration: 'uncalibrated',
      probabilityCondition: 'survives_land_check_through_120min',
    })),
    skipped: [],
  }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(asOf);
});
afterEach(() => vi.useRealTimers());

it('超过100条无关情报和历史修订保留完整审计，预测只查询最新已审核航警关联', async () => {
  const warning = document(1);
  const documents = [
    ...Array.from({ length: 130 }, (_, index) => document(index + 2, { category: 'environment' })),
    document(0),
    document(0, { id: 'withdrawn', version: 2, status: 'withdrawn' }),
    document(200, { reviewStatus: 'candidate' }),
    warning,
  ];
  await fixture(documents);
  const output = await executePredictionTopic(infra, lease, new AbortController().signal);
  expect(
    mocks.query.mock.calls.filter((call) =>
      String(call[1]).includes('intelligence_relations'),
    )[0]?.[2][0],
  ).toEqual([warning.id]);
  expect(mocks.save.mock.calls[0]?.[2].intelligence).toHaveLength(documents.length);
  expect(output.results[0]!.evidence.documents.map((item) => item.id)).toEqual([warning.id]);
  expect(mocks.worker.mock.calls[0]?.[0].warnings).toHaveLength(1);
  expect(AnalysisResultSchema.safeParse(output.results[0]).success).toBe(true);
});

it('101个真实航警全部评估并保存固定引用，嵌入证据优先保留第101个命中公告且明确展示上限', async () => {
  const documents = Array.from({ length: 101 }, (_, index) => document(index));
  await fixture(documents);
  const output = await executePredictionTopic(infra, lease, new AbortController().signal);
  expect(mocks.worker.mock.calls[0]?.[0].warnings).toHaveLength(101);
  expect(Object.values(output.artifacts)[0]!.impacts).toHaveLength(101);
  expect(output.results[0]!.evidence.documents).toHaveLength(100);
  expect(output.results[0]!.evidence.documents[0]!.id).toBe(documents[100]!.id);
  expect(
    output.results[0]!.evidence.steps.find((step) => step.id === 'warning-impact')!.references,
  ).toHaveLength(101);
  expect(output.results[0]!.evidence.limitations.join('\n')).toMatch(/101.*100.*运行.*run/);
  expect(mocks.save.mock.calls[0]?.[2].intelligence).toHaveLength(101);
  expect(AnalysisResultSchema.safeParse(output.results[0]).success).toBe(true);
});

it('超过1000个关系按稳定ID分页，完整保留末页而不再被旧关联展示预算阻断', async () => {
  const warning = document(1);
  await fixture(
    [warning],
    Array.from({ length: 1001 }, (_, index) => relation(warning, index)),
  );
  const output = await executePredictionTopic(infra, lease, new AbortController().signal);
  expect(mocks.worker.mock.calls[0]?.[0].warnings).toHaveLength(1001);
  expect(Object.values(output.artifacts)[0]!.impacts).toHaveLength(1001);
  const pages = mocks.query.mock.calls.filter((call) =>
    String(call[1]).includes('intelligence_relations'),
  );
  expect(pages).toHaveLength(2);
  expect(pages[1]?.[2][1]).toBe(`${warning.id}-relation-0999`);
  expect(pages[1]?.[2][2]).toBe(asOf);
});

it('关系总字节超限时明确失败并保持计算尚未开始，不静默截掉影响证据', async () => {
  const warning = document(1);
  await fixture([warning], [{ ...relation(warning), payload: 'x'.repeat(32 * 1024 * 1024) }]);
  await expect(executePredictionTopic(infra, lease, new AbortController().signal)).rejects.toThrow(
    '32 MiB',
  );
  expect(mocks.worker).not.toHaveBeenCalled();
});

it('初始证据超过总字节预算时，无航警候选也明确拒绝', async () => {
  await fixture([document(1, { category: 'environment', raw: 'x'.repeat(32 * 1024 * 1024) })]);
  await expect(executePredictionTopic(infra, lease, new AbortController().signal)).rejects.toThrow(
    '32 MiB',
  );
  expect(mocks.worker).not.toHaveBeenCalled();
});

it('数据库页字节保护返回空载荷时中止，保持容量失败可见', async () => {
  await fixture([document(1)]);
  mocks.query.mockResolvedValueOnce({ rows: [{ id: 'large-relation', relation: null }] });
  await expect(executePredictionTopic(infra, lease, new AbortController().signal)).rejects.toThrow(
    '32 MiB',
  );
  expect(mocks.worker).not.toHaveBeenCalled();
});

it('无航警候选的任务仍遵守已取消和已到期的运行预算', async () => {
  await fixture([]);
  const controller = new AbortController();
  controller.abort();
  await expect(executePredictionTopic(infra, lease, controller.signal)).rejects.toThrow();
  await expect(
    executePredictionTopic(infra, lease, new AbortController().signal, Date.now() - 1),
  ).rejects.toThrow('deadline');
  expect(mocks.worker).not.toHaveBeenCalled();
});

it('分页期间取消立即停止，全部查询继承同一deadline和signal', async () => {
  const warning = document(1);
  await fixture(
    [warning],
    Array.from({ length: 1001 }, (_, index) => relation(warning, index)),
  );
  const controller = new AbortController();
  const query = mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async (...args: unknown[]) => {
    const result = await query(...args);
    if (String(args[1]).includes('intelligence_relations')) controller.abort();
    return result;
  });
  const deadline = Date.now() + 30_000;
  await expect(executePredictionTopic(infra, lease, controller.signal, deadline)).rejects.toThrow();
  const pages = mocks.query.mock.calls.filter((call) =>
    String(call[1]).includes('intelligence_relations'),
  );
  expect(pages).toHaveLength(1);
  expect(pages[0]?.[3]).toBe(controller.signal);
  expect(pages[0]?.[4]).toBe(deadline);
  expect(mocks.worker).not.toHaveBeenCalled();
});
