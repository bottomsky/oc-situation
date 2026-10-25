import { createHash } from 'node:crypto';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import { queryFusionDataset } from '../../packages/infrastructure/fusion-data';
import {
  activePredictionLandDataset,
  checkPredictionPaths,
  predictionQuery,
} from '../../packages/infrastructure/predictions-land';
import {
  buildPredictionWarnings,
  type PredictionArtifact,
} from '../../packages/infrastructure/predictions';
import { saveTopicInput, type TopicLease } from '../../packages/infrastructure/topics';
import type {
  AnalysisResult,
  TopicAisEvidence,
  TopicDataset,
} from '../../packages/contracts/topics';
import { executePredictionWorker } from './prediction-worker-client';
import { readPredictionTrainingHistory } from '../../packages/infrastructure/predictions-history';
import { trainMotionResiduals } from '../../packages/domain/reachability-backtest';
import { predictionResultBbox } from './prediction-bounds';
import type { PredictionCoordinate } from '../../packages/contracts/reachability';
import { REACHABILITY_MODEL_VERSION } from '../../packages/contracts/reachability';
import type { IntelligenceEvent } from '../../packages/contracts/intelligence';

const WARNING_EVIDENCE_BYTES = 32 * 1024 * 1024;
const EMBEDDED_WARNING_DOCUMENTS = 100;

/** Retain revisions until logical latest selection, so a withdrawal cannot revive an older notice. */
function warningDocumentCandidates(documents: IntelligenceEvent[]) {
  const latest = new Map<string, IntelligenceEvent>();
  for (const document of documents) {
    const key = JSON.stringify([document.sourceId, document.externalId]);
    if ((latest.get(key)?.version ?? -1) < document.version) latest.set(key, document);
  }
  return [...latest.values()]
    .filter(
      (document) =>
        document.category === 'navigation-warning' &&
        document.reviewStatus === 'confirmed' &&
        document.status !== 'withdrawn',
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function readWarningRelations(
  infra: Infrastructure,
  documents: IntelligenceEvent[],
  asOf: string,
  signal: AbortSignal,
  deadline: number,
  bytes: number,
) {
  const relations: unknown[] = [];
  signal.throwIfAborted();
  if (deadline <= Date.now()) throw new Error('Prediction request deadline exceeded');
  if (bytes > WARNING_EVIDENCE_BYTES)
    throw new Error('航警证据总量超过32 MiB，请缩小分析范围后重试；本次未生成影响判断。');
  if (!documents.length) return relations;
  let cursor: string | null = null;
  for (;;) {
    signal.throwIfAborted();
    const page: { rows: { id: string; relation: unknown }[] } = await predictionQuery(
      infra,
      `WITH page AS (SELECT id,data || jsonb_build_object('geometry',ST_AsGeoJSON(geom)::jsonb) AS relation FROM (SELECT DISTINCT ON(id) * FROM intelligence_relations WHERE event_id=ANY($1::text[]) AND ($2::text IS NULL OR id>$2) AND recorded_at<=$3::timestamptz ORDER BY id,revision DESC) r ORDER BY id LIMIT 1000) SELECT id,CASE WHEN sum(octet_length(relation::text)) OVER () <= $4 THEN relation ELSE NULL END relation FROM page ORDER BY id`,
      [documents.map((document) => document.id), cursor, asOf, WARNING_EVIDENCE_BYTES - bytes],
      signal,
      deadline,
    );
    for (const row of page.rows) {
      if (row.relation === null)
        throw new Error('航警证据总量超过32 MiB，请缩小分析范围后重试；本次未生成影响判断。');
      bytes += Buffer.byteLength(JSON.stringify(row.relation), 'utf8');
      if (bytes > WARNING_EVIDENCE_BYTES)
        throw new Error('航警证据总量超过32 MiB，请缩小分析范围后重试；本次未生成影响判断。');
      relations.push(row.relation);
    }
    if (page.rows.length < 1000) return relations;
    const next: string = page.rows.at(-1)!.id;
    if (!next || next === cursor) throw new Error('航警关联分页游标未推进，本次未生成影响判断。');
    cursor = next;
  }
}

export async function executePredictionTopic(
  infra: Infrastructure,
  lease: TopicLease,
  signal: AbortSignal,
  deadline = Date.now() + 30000,
): Promise<{ results: AnalysisResult[]; artifacts: Record<string, PredictionArtifact> }> {
  const mmsi = lease.instance.config.mmsi;
  if (!mmsi) throw new Error('Prediction topics require a single configured MMSI');
  const asOf = new Date().toISOString();
  const from = new Date(Date.parse(asOf) - 60 * 60_000).toISOString();
  const future = new Date(Date.parse(asOf) + 120 * 60_000).toISOString();
  const input = await queryFusionDataset(infra, {
    from,
    to: asOf,
    mmsis: [mmsi],
    maxRecords: 10000,
    intelligenceFrom: asOf,
    intelligenceTo: future,
    signal,
    deadline,
  });
  const ais: TopicAisEvidence[] = input.ais.map((point) => ({
    ...point,
    courseOverGround: point.raw.cogDegrees ?? null,
    heading: point.raw.headingDegrees ?? null,
  }));
  const training = await readPredictionTrainingHistory(infra, mmsi, asOf, signal);
  const historicalResiduals = trainMotionResiduals([
    {
      voyageId: `${mmsi}:${training.from}:${training.to}`,
      mmsi,
      forecastAt: training.to,
      observations: training.observations.map((point) => ({
        observedAt: point.observedAt,
        longitude: point.lon,
        latitude: point.lat,
        speedOverGround: point.sogKnots,
        courseOverGround: point.cogDegrees,
        heading: point.headingDegrees,
      })),
    },
  ]);
  const trainingEvidence: TopicAisEvidence[] = training.observations.map((point) => ({
    recordId: point.eventId,
    mmsi: point.mmsi,
    occurredAt: point.observedAt,
    longitude: point.lon,
    latitude: point.lat,
    speedOverGround: point.sogKnots,
    courseOverGround: point.cogDegrees,
    heading: point.headingDegrees,
    shipType: null,
    raw: point,
  }));
  const dataset: TopicDataset = {
    ...input,
    ais,
    intelligence: input.intelligence.map((document) => ({ ...document, kind: document.category })),
  };
  const candidates = warningDocumentCandidates(input.intelligence);
  const relations = await readWarningRelations(
    infra,
    candidates,
    asOf,
    signal,
    deadline,
    Buffer.byteLength(JSON.stringify(input.intelligence), 'utf8'),
  );
  const latest = [...ais]
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .at(-1);
  const warnings = buildPredictionWarnings(input.intelligence, relations, {
    mmsi,
    shipType: latest?.shipType ?? null,
  });
  const landVersion = await activePredictionLandDataset(infra, signal, deadline);
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        modelVersion: REACHABILITY_MODEL_VERSION,
        definitionId: lease.instance.definitionId,
        config: lease.instance.config,
        ais,
        training: training.observations,
        documents: input.intelligence,
        relations,
        landVersion,
      }),
    )
    .digest('hex');
  await saveTopicInput(
    infra,
    lease,
    {
      ...dataset,
      predictionContext: {
        asOf,
        landDatasetVersion: landVersion,
        inputFingerprint: fingerprint,
        relations,
        warnings: warnings.warnings,
        training: { ...training, residualSamples: historicalResiduals.length },
      },
    },
    signal,
    deadline,
  );
  if (signal.aborted) throw new Error('Prediction execution cancelled');
  const current = (
    await predictionQuery(
      infra,
      'SELECT last_input_fingerprint FROM prediction_topics WHERE instance_id=$1',
      [lease.instance.id],
      signal,
      deadline,
    )
  ).rows[0];
  if (lease.run.trigger !== 'manual' && current?.last_input_fingerprint === fingerprint) {
    // Preserve the original asOf and freshness; unchanged observations cannot refresh a probability.
    const old = (
      await predictionQuery(
        infra,
        'SELECT payload FROM analysis_results WHERE instance_id=$1',
        [lease.instance.id],
        signal,
        deadline,
      )
    ).rows.map((row) => row.payload as AnalysisResult);
    if (old.length) return { results: old, artifacts: {} };
  }
  const output = await executePredictionWorker(
    {
      input: {
        mmsi,
        asOf,
        observations: ais.map((point) => ({
          observedAt: point.occurredAt,
          longitude: point.longitude,
          latitude: point.latitude,
          speedOverGround: point.speedOverGround,
          courseOverGround: point.courseOverGround,
          heading: point.heading,
        })),
        historicalResiduals,
      },
      warnings: warnings.warnings,
      warningReferences: warnings.references,
      vessel: { mmsi, shipType: latest?.shipType ?? null },
      landAvailable: Boolean(landVersion),
    },
    landVersion
      ? { checkPaths: (paths) => checkPredictionPaths(infra, landVersion, paths, signal, deadline) }
      : {},
    { signal, timeoutMs: Math.max(1, deadline - Date.now()) },
  );
  const now = new Date().toISOString();
  const summary = output.prediction.summary;
  const impactPriority = new Map<string, { hit: number; probability: number }>();
  for (const impact of output.impacts) {
    if (!impact.documentId) continue;
    const previous = impactPriority.get(impact.documentId);
    impactPriority.set(impact.documentId, {
      hit: Math.max(previous?.hit ?? 0, Number(impact.hitPaths > 0)),
      probability: Math.max(previous?.probability ?? 0, impact.probability),
    });
  }
  const rankedDocuments = [...candidates].sort((a, b) => {
    const x = impactPriority.get(a.id),
      y = impactPriority.get(b.id);
    return (
      (y?.hit ?? 0) - (x?.hit ?? 0) ||
      (y?.probability ?? 0) - (x?.probability ?? 0) ||
      Number(Boolean(y)) - Number(Boolean(x)) ||
      a.id.localeCompare(b.id)
    );
  });
  const documentEvidence = rankedDocuments
    .slice(0, EMBEDDED_WARNING_DOCUMENTS)
    .map((document) => ({ ...document, kind: document.category }));
  const evidenceOmitted = rankedDocuments.length - documentEvidence.length;
  function* geometryCoordinates(): Generator<PredictionCoordinate> {
    if (latest) yield [latest.longitude, latest.latitude];
    for (const path of output.prediction.paths)
      for (const point of path.points) yield point.coordinate;
    for (const horizon of summary.horizons)
      for (const cell of [...horizon.positionCells, ...horizon.passageCells])
        for (const ring of cell.geometry.coordinates)
          for (const coordinate of ring) yield coordinate;
  }
  const id = createHash('sha256')
    .update(JSON.stringify(['prediction', lease.instance.id, mmsi]))
    .digest('hex');
  const result: AnalysisResult = {
    id,
    instanceId: lease.instance.id,
    definitionId: lease.instance.definitionId,
    definitionVersion: '1.0.0',
    revision: 1,
    status: 'active',
    kind: lease.instance.definitionId === 'vessel-reachability' ? 'prediction' : 'impact',
    title: `${lease.instance.definitionId === 'vessel-reachability' ? '船舶可达域' : '航警影响分析'} · ${mmsi}`,
    summary:
      summary.status === 'ready'
        ? `船舶 ${mmsi} 的2048条候选路径经陆地检查保留 ${summary.rejection.accepted} 条；评估 ${output.impacts.length} 个已审核公告区域，概率为陆地约束下尚未校准的模型估计。`
        : (summary.reason ?? '模型当前条件不足。'),
    mmsi,
    vesselId: latest?.vesselId,
    from: asOf,
    to: future,
    bbox: predictionResultBbox(geometryCoordinates(), lease.instance.config.bbox),
    confidence: 'model-estimate',
    prediction: {
      runId: lease.run.id,
      asOf,
      computedAt: now,
      expiresAt: new Date(Date.parse(asOf) + 300000).toISOString(),
      status: summary.status,
      modelVersion: summary.modelVersion,
      latestObservedAt: latest?.occurredAt ?? null,
      inputFingerprint: fingerprint,
      landDatasetVersion: landVersion,
      reason: summary.reason,
      impactsCount: output.impacts.length,
    },
    artifactRef: { resultId: id, revision: 1 },
    evidence: {
      ais: [...ais, ...trainingEvidence],
      documents: documentEvidence,
      steps: [
        {
          id: 'motion-training',
          rule: '使用当前60分钟窗口之前、同船24小时内最近5000条观测训练运动残差；相邻间隔≤30分钟',
          outcome: `训练窗口 ${training.from} 至 ${training.to}，${training.observations.length} 条历史观测形成 ${historicalResiduals.length} 条残差，模型实际来源 ${summary.residuals.source}`,
          references: trainingEvidence.map((point) => point.recordId),
        },
        {
          id: 'motion-input',
          rule: '最近60分钟单船原始AIS运动证据',
          outcome: `保留 ${ais.length} 条观测，末报 ${latest?.occurredAt ?? '缺失'}`,
          references: ais.map((point) => point.recordId),
        },
        {
          id: 'land-constraint',
          rule: '对完整2048条路径的全部连续线段执行陆地相交批量检查',
          outcome: landVersion
            ? `固定陆地数据版本 ${landVersion}，拒绝 ${summary.rejection.land} 条穿陆路径`
            : '陆地数据尚未就绪，输出模型适用性诊断。',
          references: landVersion ? [landVersion] : [],
        },
        {
          id: 'warning-impact',
          rule: '使用最新审核公告修订、精确几何、适用对象和未来120分钟有效时段',
          outcome: `纳入 ${warnings.warnings.length} 个精确区域；待审核或不适用 ${warnings.skipped.length + output.skipped.length} 项`,
          references: warnings.references.map(
            (reference) => `${reference.documentId}:${reference.relationId}:${reference.revision}`,
          ),
        },
        {
          id: 'warning-evidence',
          rule: '完整输入与全部航警引用保存在运行快照；结果嵌入最多100份固定版本原文，优先展示命中及高概率公告',
          outcome: `检索 ${input.intelligence.length} 份情报修订，筛选 ${candidates.length} 份最新已审核航警，评估 ${output.impacts.length} 个适用区域；本结果展示 ${documentEvidence.length} 份原文，其余 ${evidenceOmitted} 份及全部输入可查看运行快照 ${lease.run.id}。`,
          references: [lease.run.id],
        },
      ],
      limitations: [
        ...summary.limitations,
        '单船模型假定近期运动模式继续，结果供研判使用。',
        ...(evidenceOmitted
          ? [
              `本次纳入 ${candidates.length} 份最新审核航警，结果嵌入 ${documentEvidence.length} 份原文，其余 ${evidenceOmitted} 份及完整评估证据保存在运行快照 ${lease.run.id}；评估与固定引用完整保留。`,
            ]
          : []),
        ...warnings.skipped.map((item) => `${item.warningId}：${item.reason}`),
        ...output.skipped.map((item) => `${item.warningId}：${item.reason}`),
      ],
      parameters: lease.instance.config,
      queriedAt: dataset.queriedAt,
    },
    createdAt: now,
    updatedAt: now,
  };
  return {
    results: [result],
    artifacts: {
      [id]: { prediction: summary, impacts: output.impacts, paths: output.prediction.paths },
    },
  };
}
