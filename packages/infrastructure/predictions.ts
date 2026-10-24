import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  TopicConfigSchema,
  type AnalysisResult,
  type PredictionResultMetadata,
} from '../contracts/topics';
import {
  NavigationWarningSchema,
  type NavigationWarning,
  type NavigationWarningImpact,
  type PredictionPath,
  type ReachabilityResult,
} from '../contracts/reachability';
import type { Infrastructure } from './clients';

export interface PredictionArtifact {
  prediction: ReachabilityResult;
  impacts: NavigationWarningImpact[];
  paths: PredictionPath[];
}
export class PredictionTaskError extends Error {
  constructor(
    readonly category: 'unauthorized' | 'not_found' | 'conflict' | 'capacity' | 'invalid_input',
    message: string,
  ) {
    super(message);
  }
}
export function predictionIsStale(
  metadata: Pick<PredictionResultMetadata, 'asOf' | 'latestObservedAt' | 'computedAt'>,
  now = Date.now(),
) {
  return (
    !metadata.latestObservedAt ||
    now - Date.parse(metadata.asOf) > 300_000 ||
    now - Date.parse(metadata.computedAt) > 300_000 ||
    now - Date.parse(metadata.latestObservedAt) > 600_000
  );
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ownerRequired = (id: string) => {
  if (!id) throw new PredictionTaskError('unauthorized', '请登录后管理预测任务。');
};
export async function assertPredictionOwner(
  infra: Infrastructure,
  instanceId: string,
  ownerId: string,
) {
  ownerRequired(ownerId);
  const row = (
    await infra.pool.query('SELECT * FROM prediction_topics WHERE instance_id=$1', [instanceId])
  ).rows[0];
  if (row && row.owner_id !== ownerId)
    throw new PredictionTaskError('not_found', '预测任务不存在。');
  return row;
}
async function transaction<T>(
  infra: Infrastructure,
  ownerId: string,
  action: (client: PoolClient) => Promise<T>,
) {
  ownerRequired(ownerId);
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    // The owner lock makes watch quota and idempotency atomic even across API instances.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `predictions:${ownerId}`,
    ]);
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function assertWatchCapacity(client: PoolClient, ownerId: string) {
  const count = Number(
    (
      await client.query(
        'SELECT count(*) AS count FROM prediction_topics WHERE owner_id=$1 AND watch',
        [ownerId],
      )
    ).rows[0]?.count ?? 0,
  );
  if (count >= 20) throw new PredictionTaskError('capacity', '每个账号最多持续关注20艘船舶。');
}
export async function requestPrediction(
  infra: Infrastructure,
  ownerId: string,
  input: { mmsi: string; watch?: boolean },
  key: string,
) {
  const parsed = z
    .strictObject({ mmsi: z.string().regex(/^[1-9]\d{8}$/), watch: z.boolean().optional() })
    .safeParse(input);
  if (!parsed.success || !z.uuid().safeParse(key).success)
    throw new PredictionTaskError('invalid_input', '预测请求或幂等键无效。');
  const bodyHash = hash(parsed.data);
  return transaction(infra, ownerId, async (client) => {
    const replay = (
      await client.query('SELECT * FROM prediction_requests WHERE owner_id=$1 AND request_key=$2', [
        ownerId,
        key,
      ])
    ).rows[0];
    if (replay) {
      if (replay.body_hash !== bodyHash)
        throw new PredictionTaskError('conflict', '同一幂等键已用于其他预测请求。');
      return { instanceId: String(replay.instance_id), runId: String(replay.run_id) };
    }
    let instance = (
      await client.query(
        "SELECT i.*,p.watch FROM prediction_topics p JOIN topic_instances i ON i.id=p.instance_id WHERE p.owner_id=$1 AND p.mmsi=$2 AND p.definition_id='vessel-reachability' FOR UPDATE OF i,p",
        [ownerId, input.mmsi],
      )
    ).rows[0];
    if (input.watch && !instance?.watch) await assertWatchCapacity(client, ownerId);
    // Serialize global admission before counting, so simultaneous owners cannot overfill the queue.
    await client.query('SELECT pg_advisory_xact_lock(72190313)');
    const pending = Number(
      (
        await client.query(
          "SELECT count(*) count FROM topic_runs r JOIN prediction_topics p ON p.instance_id=r.instance_id WHERE r.status IN ('queued','running')",
        )
      ).rows[0]?.count ?? 0,
    );
    if (pending >= 100) throw new PredictionTaskError('capacity', '预测任务队列已满，请稍后重试。');
    if (!instance) {
      const id = randomUUID();
      const config = TopicConfigSchema.parse({
        bbox: [-180, -90, 180, 90],
        historyHours: 1,
        windowMinutes: 60,
        mmsi: input.mmsi,
        scheduleSeconds: 60,
      });
      instance = (
        await client.query(
          "INSERT INTO topic_instances(id,definition_id,name,config,enabled,status) VALUES($1,'vessel-reachability',$2,$3::jsonb,true,'warming') RETURNING *",
          [id, `船舶可达域 · ${input.mmsi}`, JSON.stringify(config)],
        )
      ).rows[0];
      await client.query(
        'INSERT INTO prediction_topics(instance_id,owner_id,mmsi,watch) VALUES($1,$2,$3,$4)',
        [id, ownerId, input.mmsi, input.watch ?? false],
      );
    } else {
      if (!instance.enabled) {
        instance = (
          await client.query(
            "UPDATE topic_instances SET enabled=true,generation=generation+1,status='warming',next_run_at=now() WHERE id=$1 RETURNING *",
            [instance.id],
          )
        ).rows[0];
      }
      if (input.watch !== undefined)
        await client.query(
          'UPDATE prediction_topics SET watch=$2,updated_at=now() WHERE instance_id=$1',
          [instance.id, input.watch],
        );
    }
    const active = (
      await client.query(
        "SELECT id FROM topic_runs WHERE instance_id=$1 AND generation=$2 AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
        [instance.id, instance.generation],
      )
    ).rows[0];
    const runId = active?.id ?? randomUUID();
    if (!active)
      await client.query(
        "INSERT INTO topic_runs(id,instance_id,generation,trigger,request_key,from_time,to_time) VALUES($1,$2,$3,'manual',$4,now()-interval '60 minutes',now())",
        [runId, instance.id, instance.generation, `prediction:${key}`],
      );
    await client.query(
      'INSERT INTO prediction_requests(owner_id,request_key,body_hash,instance_id,run_id) VALUES($1,$2,$3,$4,$5)',
      [ownerId, key, bodyHash, instance.id, runId],
    );
    return { instanceId: String(instance.id), runId: String(runId) };
  });
}
export async function setPredictionWatch(
  infra: Infrastructure,
  ownerId: string,
  instanceId: string,
  watch: boolean,
) {
  return transaction(infra, ownerId, async (client) => {
    const row = (
      await client.query(
        'SELECT p.* FROM prediction_topics p JOIN topic_instances i ON i.id=p.instance_id WHERE p.instance_id=$1 AND p.owner_id=$2 FOR UPDATE OF i,p',
        [instanceId, ownerId],
      )
    ).rows[0];
    if (!row) throw new PredictionTaskError('not_found', '预测任务不存在。');
    if (watch && !row.watch) await assertWatchCapacity(client, ownerId);
    await client.query(
      'UPDATE prediction_topics SET watch=$2,updated_at=now() WHERE instance_id=$1',
      [instanceId, watch],
    );
    if (watch)
      await client.query(
        "UPDATE topic_instances SET generation=generation+CASE WHEN enabled THEN 0 ELSE 1 END,enabled=true,status=CASE WHEN enabled THEN status ELSE 'warming' END,next_run_at=now() WHERE id=$1",
        [instanceId],
      );
    return { id: instanceId, instanceId, mmsi: String(row.mmsi), watch };
  });
}
export async function cancelPrediction(infra: Infrastructure, ownerId: string, instanceId: string) {
  return transaction(infra, ownerId, async (client) => {
    const row = (
      await client.query(
        'SELECT p.instance_id FROM prediction_topics p JOIN topic_instances i ON i.id=p.instance_id WHERE p.instance_id=$1 AND p.owner_id=$2 FOR UPDATE OF i,p',
        [instanceId, ownerId],
      )
    ).rows[0];
    if (!row) throw new PredictionTaskError('not_found', '预测任务不存在。');
    await client.query(
      "UPDATE topic_instances SET enabled=false,generation=generation+1,status='disabled',last_error=NULL WHERE id=$1",
      [instanceId],
    );
    await client.query(
      'UPDATE prediction_topics SET watch=false,updated_at=now() WHERE instance_id=$1',
      [instanceId],
    );
    await client.query(
      "UPDATE topic_runs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE instance_id=$1 AND status IN ('queued','running')",
      [instanceId],
    );
    return { instanceId, status: 'cancelled' as const };
  });
}
export async function getPredictionArtifact(
  infra: Infrastructure,
  ownerId: string,
  resultId: string,
  revision?: number,
) {
  ownerRequired(ownerId);
  const row = (
    await infra.pool.query(
      `SELECT a.artifact FROM analysis_prediction_artifacts a JOIN analysis_results r ON r.id=a.result_id JOIN prediction_topics p ON p.instance_id=r.instance_id WHERE a.result_id=$1 AND p.owner_id=$2 AND ($3::int IS NULL OR a.revision=$3) ORDER BY a.revision DESC LIMIT 1`,
      [resultId, ownerId, revision ?? null],
    )
  ).rows[0];
  if (!row) throw new PredictionTaskError('not_found', '预测结果修订不存在。');
  return row.artifact as { prediction: ReachabilityResult; impacts: NavigationWarningImpact[] };
}
export async function listPredictions(infra: Infrastructure, ownerId: string, mmsi?: string) {
  ownerRequired(ownerId);
  const instances = (
    await infra.pool.query(
      'SELECT i.*,p.mmsi,p.watch FROM prediction_topics p JOIN topic_instances i ON i.id=p.instance_id WHERE p.owner_id=$1 AND ($2::text IS NULL OR p.mmsi=$2) ORDER BY p.updated_at DESC LIMIT 100',
      [ownerId, mmsi ?? null],
    )
  ).rows;
  const inputChanged = `NOT i.enabled OR EXISTS(SELECT 1 FROM positions_latest l WHERE l.mmsi=p.mmsi AND l.observed_at>coalesce((r.payload->'prediction'->>'latestObservedAt')::timestamptz,'epoch')) OR EXISTS(SELECT 1 FROM intelligence_events e WHERE (e.source_id,e.external_id) IN (SELECT old.source_id,old.external_id FROM intelligence_events old WHERE old.event->>'category'='navigation-warning' AND old.effective_from<=(r.payload->'prediction'->>'asOf')::timestamptz+interval '120 minutes' AND (old.effective_to IS NULL OR old.effective_to>=(r.payload->'prediction'->>'asOf')::timestamptz)) AND (e.created_at>(r.payload->'prediction'->>'computedAt')::timestamptz OR EXISTS(SELECT 1 FROM intelligence_reviews v WHERE v.event_id=e.id AND v.recorded_at>(r.payload->'prediction'->>'computedAt')::timestamptz) OR EXISTS(SELECT 1 FROM intelligence_relations v WHERE v.event_id=e.id AND v.recorded_at>(r.payload->'prediction'->>'computedAt')::timestamptz)))`;
  const rows = (
    await infra.pool.query(
      `SELECT ${mmsi ? 'r.payload' : "r.payload-'evidence' AS payload"},${inputChanged} input_changed,reuse.id AS reuse_run_id,reuse.input_snapshot->'predictionContext'->>'inputFingerprint' reuse_fingerprint,${mmsi ? 'a.artifact' : 'NULL::jsonb artifact'} FROM analysis_results r JOIN prediction_topics p ON p.instance_id=r.instance_id JOIN topic_instances i ON i.id=r.instance_id LEFT JOIN LATERAL(SELECT id,input_snapshot FROM topic_runs WHERE instance_id=r.instance_id AND status='succeeded' ORDER BY finished_at DESC,id DESC LIMIT 1) reuse ON true ${mmsi ? 'JOIN analysis_prediction_artifacts a ON a.result_id=r.id AND a.revision=r.revision' : ''} WHERE p.owner_id=$1 AND ($2::text IS NULL OR p.mmsi=$2) ORDER BY r.updated_at DESC LIMIT 100`,
      [ownerId, mmsi ?? null],
    )
  ).rows;
  return {
    instances: instances.map((row) => ({
      id: String(row.id),
      instanceId: String(row.id),
      mmsi: String(row.mmsi),
      watch: Boolean(row.watch),
      status: String(row.status),
      enabled: Boolean(row.enabled),
      generation: Number(row.generation),
      lastRunAt: row.last_run_at,
      lastError: row.last_error,
    })),
    items: rows.map((row) => {
      const result = row.payload as AnalysisResult;
      const metadata = result.prediction!;
      const stale = predictionIsStale(metadata) || Boolean(row.input_changed);
      const latestRun =
        row.reuse_fingerprint === metadata.inputFingerprint ? row.reuse_run_id : undefined;
      return {
        id: result.id,
        instanceId: result.instanceId,
        revision: result.revision,
        runId: latestRun ?? metadata.runId,
        reused: Boolean(latestRun && latestRun !== metadata.runId),
        sourceRunId: metadata.runId,
        status: metadata.status,
        computedAt: metadata.computedAt,
        mmsi: result.mmsi,
        kind: result.kind,
        stale,
        metadata,
        artifactRef: result.artifactRef,
        ...(mmsi ? { evidence: result.evidence } : {}),
        ...(row.artifact
          ? { prediction: row.artifact.prediction, impacts: stale ? [] : row.artifact.impacts }
          : {}),
      };
    }),
  };
}
/** Poll inputs every minute for watched single-vessel tasks; the worker skips unchanged evidence. */
export async function schedulePredictionRuns(infra: Infrastructure) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(72190313)');
    const count = Number(
      (
        await client.query(
          "SELECT count(*) count FROM topic_runs r JOIN prediction_topics p ON p.instance_id=r.instance_id WHERE r.status IN ('queued','running')",
        )
      ).rows[0]?.count ?? 0,
    );
    const capacity = Math.max(0, 100 - count);
    if (capacity) {
      const rows = (
        await client.query(
          "SELECT i.* FROM topic_instances i JOIN prediction_topics p ON p.instance_id=i.id WHERE i.enabled AND p.watch AND i.next_run_at<=now() AND NOT EXISTS(SELECT 1 FROM topic_runs r WHERE r.instance_id=i.id AND r.generation=i.generation AND r.status IN ('queued','running')) ORDER BY i.next_run_at FOR UPDATE OF i SKIP LOCKED LIMIT $1",
          [capacity],
        )
      ).rows;
      for (const row of rows) {
        await client.query(
          "INSERT INTO topic_runs(id,instance_id,generation,trigger,request_key,from_time,to_time) VALUES($1,$2,$3,'scheduled',$4,now()-interval '60 minutes',now()) ON CONFLICT(instance_id,generation,request_key) DO NOTHING",
          [randomUUID(), row.id, row.generation, `prediction:${Math.floor(Date.now() / 60000)}`],
        );
        await client.query(
          "UPDATE topic_instances SET next_run_at=now()+interval '60 seconds' WHERE id=$1",
          [row.id],
        );
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Accept exact reviewed polygon relations; legacy bounding boxes do not establish an impact area. */
export function buildPredictionWarnings(
  documents: unknown[],
  relations: unknown[],
  vessel?: { mmsi: string; shipType: number | null },
) {
  const latest = new Map<string, Record<string, unknown>>();
  for (const raw of documents) {
    const doc = raw as Record<string, unknown>;
    const key = JSON.stringify([doc.sourceId, doc.externalId]);
    if (Number(latest.get(key)?.version ?? -1) < Number(doc.version)) latest.set(key, doc);
  }
  const warnings: NavigationWarning[] = [];
  const references: {
    warningId: string;
    documentId: string;
    relationId: string;
    revision: number;
    snapshot: unknown;
  }[] = [];
  const skipped: { warningId: string; reason: string }[] = [];
  const latestRelations = new Map<string, Record<string, unknown>>();
  for (const raw of relations) {
    const r = raw as Record<string, unknown>;
    if (Number(latestRelations.get(String(r.id))?.revision ?? -1) < Number(r.revision))
      latestRelations.set(String(r.id), r);
  }
  for (const doc of latest.values()) {
    const raw = (doc.raw ?? {}) as Record<string, unknown>;
    if (
      doc.status === 'withdrawn' ||
      doc.reviewStatus !== 'confirmed' ||
      doc.category !== 'navigation-warning' ||
      ((raw.requiresEffectiveTimeReview || raw.requiresOccurrenceTimeReview) &&
        raw.manualTimeConfirmed !== true)
    )
      continue;
    const mmsis = Array.isArray(doc.mmsis) ? doc.mmsis : [];
    const shipTypes = Array.isArray(doc.vesselTypes) ? doc.vesselTypes : [];
    // Union applicability across independent type/MMSI lists is not silently changed into intersection.
    const applicability =
      mmsis.length && shipTypes.length && vessel
        ? mmsis.includes(vessel.mmsi)
          ? { kind: 'mmsis', mmsis }
          : { kind: 'ship_types', shipTypes }
        : mmsis.length && !shipTypes.length
          ? { kind: 'mmsis', mmsis }
          : shipTypes.length && !mmsis.length
            ? { kind: 'ship_types', shipTypes }
            : !mmsis.length && !shipTypes.length && raw.applicabilityConfirmed === true
              ? { kind: 'all' }
              : null;
    if (!applicability) {
      skipped.push({ warningId: String(doc.id), reason: 'applicability_requires_review' });
      continue;
    }
    for (const r of latestRelations.values()) {
      if (
        r.eventId !== doc.id ||
        r.reviewStatus !== 'confirmed' ||
        r.origin === 'legacy' ||
        !['applies-to', 'impacts'].includes(String(r.kind))
      )
        continue;
      const id = `${String(doc.id)}:${String(r.id)}:${String(r.revision)}`;
      const parsed = NavigationWarningSchema.safeParse({
        id,
        reviewStatus: 'confirmed',
        effectiveFrom: new Date(
          Math.max(
            Date.parse(String(doc.effectiveFrom)),
            r.effectiveFrom ? Date.parse(String(r.effectiveFrom)) : -Infinity,
          ),
        ).toISOString(),
        effectiveTo: (() => {
          const end = Math.min(
            doc.effectiveTo ? Date.parse(String(doc.effectiveTo)) : Infinity,
            r.effectiveTo ? Date.parse(String(r.effectiveTo)) : Infinity,
          );
          return Number.isFinite(end) ? new Date(end).toISOString() : null;
        })(),
        geometry: r.geometry,
        applicability,
      });
      if (!parsed.success) {
        skipped.push({ warningId: id, reason: 'time_or_exact_geometry_requires_review' });
        continue;
      }
      warnings.push(parsed.data);
      references.push({
        warningId: id,
        documentId: String(doc.id),
        relationId: String(r.id),
        revision: Number(r.revision),
        snapshot: r,
      });
    }
    if (!references.some((reference) => reference.documentId === String(doc.id)))
      skipped.push({
        warningId: String(doc.id),
        reason: 'confirmed_exact_applicability_geometry_required',
      });
  }
  return { warnings, references, skipped };
}
