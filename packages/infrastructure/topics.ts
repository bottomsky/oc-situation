import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { z } from 'zod';
import type {
  AnalysisFeedItem,
  AnalysisResult,
  CreateTopicInstanceSchema,
  TopicConfig,
  TopicDataset,
  TopicDefinitionId,
  TopicInstance,
  TopicRun,
} from '../contracts/topics';
import { TOPIC_DEFINITIONS, assertTopicCapabilities } from '../domain/topics';
import type { Infrastructure } from './clients';

const iso = (value: Date | string | null) =>
  value === null ? null : new Date(value).toISOString();
type Row = Record<string, unknown>;
function instanceRow(row: Row): TopicInstance {
  return {
    id: String(row.id),
    definitionId: row.definition_id as TopicDefinitionId,
    name: String(row.name),
    config: row.config as TopicInstance['config'],
    enabled: Boolean(row.enabled),
    generation: Number(row.generation),
    status: row.status as TopicInstance['status'],
    checkpoint: iso(row.checkpoint as Date | null),
    lastRunAt: iso(row.last_run_at as Date | null),
    lastError: row.last_error as string | null,
    createdAt: iso(row.created_at as Date)!,
  };
}
function runRow(row: Row): TopicRun {
  return {
    id: String(row.id),
    instanceId: String(row.instance_id),
    generation: Number(row.generation),
    trigger: row.trigger as TopicRun['trigger'],
    status: row.status as TopicRun['status'],
    from: iso(row.from_time as Date)!,
    to: iso(row.to_time as Date)!,
    attempts: Number(row.attempts),
    error: row.error as string | null,
    createdAt: iso(row.created_at as Date)!,
    finishedAt: iso(row.finished_at as Date | null),
  };
}
export function retryDelaySeconds(attempt: number) {
  return Math.min(300, 2 ** Math.min(attempt, 9));
}
export function analysisFingerprint(result: AnalysisResult) {
  const {
    revision: _revision,
    createdAt: _created,
    updatedAt: _updated,
    status: _status,
    evidence,
    ...content
  } = result;
  const { queriedAt: _queried, ...facts } = evidence;
  return createHash('sha256')
    .update(
      JSON.stringify({ ...content, evidence: facts, withdrawn: result.status === 'withdrawn' }),
    )
    .digest('hex');
}
export async function listTopicInstances(infra: Infrastructure): Promise<TopicInstance[]> {
  return (await infra.pool.query('SELECT * FROM topic_instances ORDER BY created_at,id')).rows.map(
    instanceRow,
  );
}
export async function createTopicInstance(
  infra: Infrastructure,
  value: z.infer<typeof CreateTopicInstanceSchema>,
) {
  const definition = TOPIC_DEFINITIONS.find((d) => d.id === value.definitionId);
  if (!definition) throw new Error('Unknown topic definition');
  assertTopicCapabilities(definition.requiredCapabilities);
  const row = await infra.pool.query(
    'INSERT INTO topic_instances(id,definition_id,name,config,enabled,status) VALUES($1,$2,$3,$4::jsonb,$5,$6) RETURNING *',
    [
      randomUUID(),
      value.definitionId,
      value.name,
      JSON.stringify(value.config),
      value.enabled,
      value.enabled ? 'warming' : 'disabled',
    ],
  );
  return instanceRow(row.rows[0]);
}
export async function setTopicState(infra: Infrastructure, id: string, enabled: boolean) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT * FROM topic_instances WHERE id=$1 FOR UPDATE', [
      id,
    ]);
    if (!current.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    if (current.rows[0].enabled === enabled) {
      await client.query('COMMIT');
      return instanceRow(current.rows[0]);
    }
    const row = await client.query(
      `UPDATE topic_instances SET enabled=$2,generation=generation+1,status=$3,
      last_error=NULL,next_run_at=now() WHERE id=$1 RETURNING *`,
      [id, enabled, enabled ? 'warming' : 'disabled'],
    );
    await client.query(
      "UPDATE topic_runs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE instance_id=$1 AND status IN ('queued','running')",
      [id],
    );
    await client.query('COMMIT');
    return instanceRow(row.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function updateTopicConfig(infra: Infrastructure, id: string, config: TopicConfig) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query(
      `UPDATE topic_instances SET config=$2::jsonb,generation=generation+1,checkpoint=NULL,
      status=CASE WHEN enabled THEN 'warming' ELSE 'disabled' END,last_error=NULL,next_run_at=now() WHERE id=$1 RETURNING *`,
      [id, JSON.stringify(config)],
    );
    if (!row.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(
      "UPDATE topic_runs SET status='cancelled',finished_at=now(),lease_token=NULL,lease_until=NULL WHERE instance_id=$1 AND status IN ('queued','running')",
      [id],
    );
    await client.query('COMMIT');
    return instanceRow(row.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function enqueue(
  client: PoolClient,
  instance: TopicInstance,
  trigger: TopicRun['trigger'],
  key: string,
  at: Date,
  range?: { from: string; to: string },
) {
  const catchup = Boolean(instance.checkpoint && (trigger === 'scheduled' || trigger === 'warmup'));
  const end = catchup
    ? Math.min(
        at.getTime(),
        Date.parse(instance.checkpoint!) + instance.config.historyHours * 3_600_000,
      )
    : at.getTime();
  const to = new Date(end).toISOString();
  const from = new Date(
    catchup
      ? Date.parse(instance.checkpoint!) - instance.config.windowMinutes * 60_000
      : end - instance.config.historyHours * 3_600_000,
  ).toISOString();
  const row = await client.query(
    `INSERT INTO topic_runs(id,instance_id,generation,trigger,request_key,from_time,to_time)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(instance_id,generation,request_key) DO UPDATE SET request_key=excluded.request_key RETURNING *`,
    [
      randomUUID(),
      instance.id,
      instance.generation,
      trigger,
      key,
      range?.from ?? from,
      range?.to ?? to,
    ],
  );
  return runRow(row.rows[0]);
}
export async function recordTopicReady(
  infra: Infrastructure,
  id: string,
  event: { id: string; from: string; to: string },
) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM topic_instances WHERE id=$1 FOR UPDATE', [id]))
      .rows[0];
    if (!row?.enabled) {
      await client.query('COMMIT');
      return;
    }
    const receipt = await client.query(
      'INSERT INTO topic_event_receipts(instance_id,generation,event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',
      [id, row.generation, event.id],
    );
    if (receipt.rowCount) {
      // A late point can complete an episode with observations on either side of its timestamp.
      const end = new Date(
        Math.min(Date.now(), Date.parse(event.to) + Number(row.config.windowMinutes) * 60_000),
      ).toISOString();
      const monitoringStart =
        new Date(row.created_at).getTime() - Number(row.config.historyHours) * 3_600_000;
      const start = new Date(
        Math.max(
          monitoringStart,
          Math.min(Date.parse(end), Date.parse(event.from)) -
            Number(row.config.windowMinutes) * 60_000,
        ),
      ).toISOString();
      if (Date.parse(end) < monitoringStart) {
        await client.query('COMMIT');
        return;
      }
      await client.query(
        `UPDATE topic_instances SET pending_from=least(coalesce(pending_from,$2::timestamptz),$2::timestamptz),
        pending_to=greatest(coalesce(pending_to,$3::timestamptz),$3::timestamptz),next_run_at=least(next_run_at,now()) WHERE id=$1`,
        [id, start, end],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function queueTopicRun(
  infra: Infrastructure,
  id: string,
  key: string,
  trigger: TopicRun['trigger'] = 'manual',
  at = new Date(),
) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT * FROM topic_instances WHERE id=$1 FOR UPDATE', [id]);
    if (!row.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const instance = instanceRow(row.rows[0]);
    if (!instance.enabled) throw new Error('Topic instance is disabled');
    const run = await enqueue(client, instance, trigger, key, at);
    await client.query('COMMIT');
    return run;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function scheduleTopicRuns(infra: Infrastructure, definitionId?: TopicDefinitionId) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT * FROM topic_instances i WHERE enabled AND status<>'degraded' AND (next_run_at<=now() OR pending_from IS NOT NULL)
      AND ($1::text IS NULL OR definition_id=$1) AND NOT EXISTS(SELECT 1 FROM topic_runs r WHERE r.instance_id=i.id AND r.generation=i.generation AND r.status IN ('queued','running'))
      ORDER BY next_run_at FOR UPDATE SKIP LOCKED LIMIT 50`,
      [definitionId ?? null],
    );
    for (const row of rows.rows) {
      const instance = instanceRow(row);
      const at = new Date();
      if (row.pending_from && instance.checkpoint && instance.status === 'ready') {
        const start = iso(row.pending_from)!;
        const end = new Date(
          Math.min(
            new Date(row.pending_to).getTime(),
            new Date(row.pending_from).getTime() +
              instance.config.historyHours * 3_600_000 +
              instance.config.windowMinutes * 60_000,
          ),
        ).toISOString();
        await enqueue(client, instance, 'incremental', `pending:${start}:${end}`, at, {
          from: start,
          to: end,
        });
        const finished = Date.parse(end) >= new Date(row.pending_to).getTime();
        await client.query(
          'UPDATE topic_instances SET pending_from=$2,pending_to=CASE WHEN $3 THEN NULL ELSE pending_to END WHERE id=$1',
          [
            instance.id,
            finished
              ? null
              : new Date(Date.parse(end) - instance.config.windowMinutes * 60_000).toISOString(),
            finished,
          ],
        );
      } else {
        await enqueue(
          client,
          instance,
          instance.checkpoint ? 'scheduled' : 'warmup',
          `schedule:${at.toISOString()}`,
          at,
        );
      }
      await client.query(
        "UPDATE topic_instances SET next_run_at=now()+($2*interval '1 second') WHERE id=$1",
        [instance.id, instance.config.scheduleSeconds],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export interface TopicLease {
  run: TopicRun;
  instance: TopicInstance;
  token: string;
}
export async function claimTopicRun(
  infra: Infrastructure,
  definitionId?: TopicDefinitionId,
  instanceId?: string,
): Promise<TopicLease | null> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    // An instance lock serializes its runs and state transition; expired leases are reclaimable.
    const candidates = await client.query(
      `SELECT i.* FROM topic_instances i
      JOIN LATERAL(SELECT r.created_at FROM topic_runs r WHERE r.instance_id=i.id AND r.generation=i.generation
        AND r.attempts<5 AND r.available_at<=now() AND (r.status='queued' OR (r.status='running' AND r.lease_until<now()))
        ORDER BY r.created_at,r.id LIMIT 1) ready ON true
      WHERE enabled
      AND ($1::text IS NULL OR definition_id=$1)
      AND ($2::uuid IS NULL OR i.id=$2)
      AND NOT EXISTS(SELECT 1 FROM topic_runs r WHERE r.instance_id=i.id AND r.status='running' AND r.lease_until>=now())
      ORDER BY ready.created_at,i.last_run_at NULLS FIRST,i.id FOR UPDATE OF i SKIP LOCKED LIMIT 1`,
      [definitionId ?? null, instanceId ?? null],
    );
    if (!candidates.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const instance = instanceRow(candidates.rows[0]);
    const token = randomUUID();
    const claimed = await client.query(
      `UPDATE topic_runs SET status='running',attempts=attempts+1,lease_token=$2,lease_until=now()+interval '120 seconds'
      WHERE id=(SELECT id FROM topic_runs WHERE instance_id=$1 AND generation=$3 AND attempts<5 AND available_at<=now()
        AND (status='queued' OR (status='running' AND lease_until<now())) ORDER BY created_at LIMIT 1 FOR UPDATE) RETURNING *`,
      [instance.id, token, instance.generation],
    );
    await client.query('COMMIT');
    return claimed.rows[0] ? { run: runRow(claimed.rows[0]), instance, token } : null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function renewTopicLease(infra: Infrastructure, lease: TopicLease) {
  const result = await infra.pool.query(
    "UPDATE topic_runs SET lease_until=now()+interval '120 seconds' WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()",
    [lease.run.id, lease.token],
  );
  return result.rowCount === 1;
}
export async function saveTopicInput(
  infra: Infrastructure,
  lease: TopicLease,
  input: TopicDataset,
) {
  const version = TOPIC_DEFINITIONS.find((d) => d.id === lease.instance.definitionId)!.version;
  const row = await infra.pool.query(
    `UPDATE topic_runs SET input_snapshot=$3::jsonb,definition_version=$4,config_snapshot=$5::jsonb
    WHERE id=$1 AND lease_token=$2 AND status='running' AND lease_until>now()`,
    [
      lease.run.id,
      lease.token,
      JSON.stringify(input),
      version,
      JSON.stringify(lease.instance.config),
    ],
  );
  if (!row.rowCount) throw new Error('Topic lease lost before input snapshot persisted');
}
export async function getTopicRun(infra: Infrastructure, id: string) {
  const row = (await infra.pool.query('SELECT * FROM topic_runs WHERE id=$1', [id])).rows[0];
  return row
    ? {
        ...runRow(row),
        inputSnapshot: row.input_snapshot,
        definitionVersion: row.definition_version,
        configSnapshot: row.config_snapshot,
      }
    : null;
}
export async function failTopicRun(infra: Infrastructure, lease: TopicLease, error: unknown) {
  const message = (error instanceof Error ? error.message : 'Topic execution failed').slice(
    0,
    2000,
  );
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const instance = await client.query(
      'SELECT id FROM topic_instances WHERE id=$1 AND enabled AND generation=$2 FOR UPDATE',
      [lease.instance.id, lease.instance.generation],
    );
    if (!instance.rowCount) {
      await client.query('COMMIT');
      return;
    }
    const updated = await client.query(
      `UPDATE topic_runs SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'queued' END,
      error=$3,lease_token=NULL,lease_until=NULL,available_at=now()+($4*interval '1 second'),finished_at=CASE WHEN attempts>=5 THEN now() ELSE NULL END
      WHERE id=$1 AND lease_token=$2 AND status='running' RETURNING id`,
      [lease.run.id, lease.token, message, retryDelaySeconds(lease.run.attempts)],
    );
    if (updated.rowCount)
      await client.query("UPDATE topic_instances SET status='degraded',last_error=$2 WHERE id=$1", [
        lease.instance.id,
        message,
      ]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export async function expireExhaustedTopicRuns(infra: Infrastructure) {
  // Handles a process dying on its final attempt before it can persist failure.
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      `SELECT i.id FROM topic_instances i WHERE i.enabled AND EXISTS(SELECT 1 FROM topic_runs r WHERE r.instance_id=i.id AND r.generation=i.generation AND r.status='running' AND r.lease_until<now() AND r.attempts>=5) FOR UPDATE SKIP LOCKED`,
    );
    for (const row of rows.rows) {
      await client.query(
        "UPDATE topic_runs SET status='failed',finished_at=now(),error='Lease expired after maximum attempts',lease_token=NULL WHERE instance_id=$1 AND status='running' AND lease_until<now() AND attempts>=5",
        [row.id],
      );
      await client.query(
        "UPDATE topic_instances SET status='degraded',last_error='Lease expired after maximum attempts' WHERE id=$1",
        [row.id],
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function persistResult(
  client: PoolClient,
  lease: TopicLease,
  result: AnalysisResult,
  previous?: AnalysisResult,
  fingerprint?: string,
) {
  const value = {
    ...result,
    revision: (previous?.revision ?? 0) + 1,
    status: result.status === 'withdrawn' ? 'withdrawn' : previous ? 'revised' : 'active',
    createdAt: previous?.createdAt ?? result.createdAt,
    updatedAt: new Date().toISOString(),
  } as AnalysisResult;
  const payload = JSON.stringify(value);
  await client.query(
    `INSERT INTO analysis_results(id,instance_id,revision,fingerprint,payload) VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,fingerprint=excluded.fingerprint,payload=excluded.payload,updated_at=now()`,
    [
      value.id,
      value.instanceId,
      value.revision,
      fingerprint ?? analysisFingerprint(value),
      payload,
    ],
  );
  await client.query(
    'INSERT INTO analysis_revisions(result_id,revision,run_id,payload) VALUES($1,$2,$3,$4::jsonb)',
    [value.id, value.revision, lease.run.id, payload],
  );
  await client.query(
    'INSERT INTO analysis_feed(result_id,instance_id,generation,revision,status) VALUES($1,$2,$3,$4,$5)',
    [value.id, value.instanceId, lease.instance.generation, value.revision, value.status],
  );
}
export async function completeTopicRun(
  infra: Infrastructure,
  lease: TopicLease,
  results: AnalysisResult[],
): Promise<boolean> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const row = await client.query('SELECT * FROM topic_instances WHERE id=$1 FOR UPDATE', [
      lease.instance.id,
    ]);
    if (!row.rows[0]?.enabled || row.rows[0].generation !== lease.instance.generation) {
      await client.query('ROLLBACK');
      return false;
    }
    const owned = await client.query(
      "SELECT id,input_snapshot FROM topic_runs WHERE id=$1 AND status='running' AND lease_token=$2 AND lease_until>now() FOR UPDATE",
      [lease.run.id, lease.token],
    );
    if (!owned.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    const input = owned.rows[0].input_snapshot as TopicDataset | null;
    if (!input) throw new Error('A durable input snapshot is required before completion');
    // Sequence allocation and commit order are serialized so a feed cursor cannot skip a late commit.
    await client.query('SELECT pg_advisory_xact_lock(72190311)');
    const previous = await client.query(
      'SELECT id,payload,fingerprint FROM analysis_results WHERE instance_id=$1',
      [lease.instance.id],
    );
    const old = new Map(
      previous.rows.map((r) => [
        String(r.id),
        { value: r.payload as AnalysisResult, fingerprint: String(r.fingerprint) },
      ]),
    );
    const found = new Set(results.map((r) => r.id));
    for (const result of results) {
      const before = old.get(result.id);
      const fingerprint = analysisFingerprint(result);
      if (before?.fingerprint === fingerprint) continue;
      await persistResult(client, lease, result, before?.value, fingerprint);
    }
    for (const { value } of old.values()) {
      // Retain observations that aged out of this complete rolling history query.
      if (
        found.has(value.id) ||
        value.status === 'withdrawn' ||
        Date.parse(value.from) < Date.parse(lease.run.from) ||
        Date.parse(value.to) > Date.parse(lease.run.to)
      )
        continue;
      const newDocuments = input.intelligence.filter(
        (d) =>
          value.evidence.documents.some(
            (old) => old.sourceId === d.sourceId && old.externalId === d.externalId,
          ) && !value.evidence.documents.some((old) => old.id === d.id),
      );
      const withdrawn: AnalysisResult = {
        ...value,
        status: 'withdrawn',
        summary: '最新完整窗口复算未再满足规则，原结果撤回；历史证据和本次复算输入保留供追溯。',
        evidence: {
          ...value.evidence,
          documents: [...value.evidence.documents, ...newDocuments],
          parameters: lease.instance.config,
          queriedAt: input.queriedAt,
          steps: [
            ...value.evidence.steps,
            {
              id: 'withdrawal',
              rule: '完整历史窗口重新计算',
              outcome:
                '当前公告版本、有效状态或点位条件不再支持原结果；运行输入快照可通过专题运行详情查询',
              references: [lease.run.id, ...newDocuments.map((d) => d.id)],
            },
          ],
        },
      };
      await persistResult(client, lease, withdrawn, value);
    }
    await client.query(
      "UPDATE topic_runs SET status='succeeded',finished_at=now(),lease_token=NULL,lease_until=NULL,error=NULL WHERE id=$1",
      [lease.run.id],
    );
    const priorCheckpoint = iso(row.rows[0].checkpoint);
    const canAdvance =
      lease.run.trigger === 'warmup' || lease.run.trigger === 'scheduled' || !priorCheckpoint;
    const checkpoint = canAdvance
      ? new Date(
          Math.max(Date.parse(priorCheckpoint ?? lease.run.to), Date.parse(lease.run.to)),
        ).toISOString()
      : priorCheckpoint;
    await client.query(
      `UPDATE topic_instances SET checkpoint=$2::timestamptz,last_run_at=now(),
      status=CASE WHEN $2::timestamptz<now()-($3*interval '1 second') THEN 'warming' ELSE 'ready' END,
      next_run_at=CASE WHEN $2::timestamptz<now()-($3*interval '1 second') THEN now() ELSE next_run_at END,last_error=NULL WHERE id=$1`,
      [lease.instance.id, checkpoint, lease.instance.config.scheduleSeconds],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export async function listAnalysisResults(infra: Infrastructure, instanceId?: string, limit = 100) {
  return (
    await infra.pool.query(
      'SELECT payload FROM analysis_results WHERE ($1::uuid IS NULL OR instance_id=$1) ORDER BY updated_at DESC,id LIMIT $2',
      [instanceId ?? null, limit],
    )
  ).rows.map((r) => r.payload as AnalysisResult);
}
export async function getAnalysisResult(infra: Infrastructure, id: string) {
  return (await infra.pool.query('SELECT payload FROM analysis_results WHERE id=$1', [id])).rows[0]
    ?.payload as AnalysisResult | undefined;
}
export async function getAnalysisRevisions(infra: Infrastructure, id: string) {
  return (
    await infra.pool.query(
      'SELECT payload FROM analysis_revisions WHERE result_id=$1 ORDER BY revision DESC LIMIT 100',
      [id],
    )
  ).rows.map((r) => r.payload as AnalysisResult);
}
export async function listTopicRuns(infra: Infrastructure, id: string) {
  return (
    await infra.pool.query(
      'SELECT * FROM topic_runs WHERE instance_id=$1 ORDER BY created_at DESC LIMIT 100',
      [id],
    )
  ).rows.map(runRow);
}
function feedRow(row: Row): AnalysisFeedItem {
  return {
    cursor: String(row.sequence),
    type: 'analysis.updated',
    resultId: String(row.result_id),
    instanceId: String(row.instance_id),
    revision: Number(row.revision),
    status: row.status as AnalysisFeedItem['status'],
    createdAt: iso(row.created_at as Date)!,
  };
}
export async function readAnalysisFeed(infra: Infrastructure, cursor = '0', limit = 100) {
  const rows = await infra.pool.query(
    'SELECT * FROM analysis_feed WHERE sequence>$1::bigint ORDER BY sequence LIMIT $2',
    [cursor, limit],
  );
  const items = rows.rows.map(feedRow);
  return { items, nextCursor: items.at(-1)?.cursor ?? cursor };
}
export async function readLiveAnalysisFeed(infra: Infrastructure, cursor = '0', limit = 100) {
  const rows = await infra.pool.query(
    `SELECT f.*,i.enabled,i.generation AS current_generation FROM analysis_feed f
    JOIN topic_instances i ON i.id=f.instance_id WHERE f.sequence>$1::bigint ORDER BY f.sequence LIMIT $2`,
    [cursor, limit],
  );
  return {
    items: rows.rows
      .filter((r) => r.enabled && r.generation === r.current_generation && !r.suppressed_at)
      .map(feedRow),
    nextCursor: rows.rows.at(-1)?.sequence?.toString() ?? cursor,
  };
}
export async function flushAnalysisOutbox(infra: Infrastructure) {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    // Hold the same instance lock as disable through publish: no notification can race a completed disable.
    const rows =
      await client.query(`SELECT f.*,i.enabled,i.generation AS current_generation FROM analysis_feed f JOIN topic_instances i ON i.id=f.instance_id
      WHERE f.published_at IS NULL AND f.suppressed_at IS NULL AND f.available_at<=now() AND f.attempts<10 ORDER BY f.sequence FOR UPDATE OF i,f SKIP LOCKED LIMIT 20`);
    for (const row of rows.rows) {
      if (!row.enabled || row.generation !== row.current_generation) {
        await client.query('UPDATE analysis_feed SET suppressed_at=now() WHERE sequence=$1', [
          row.sequence,
        ]);
        continue;
      }
      try {
        await infra.js.publish('fusion.analysis.updated', JSON.stringify(feedRow(row)), {
          msgID: `analysis:${row.sequence}`,
        });
        await client.query(
          'UPDATE analysis_feed SET published_at=now(),attempts=attempts+1,last_error=NULL WHERE sequence=$1',
          [row.sequence],
        );
      } catch (error) {
        await client.query(
          "UPDATE analysis_feed SET attempts=attempts+1,last_error=$2,available_at=now()+($3*interval '1 second') WHERE sequence=$1",
          [
            row.sequence,
            (error instanceof Error ? error.message : 'Publication failed').slice(0, 2000),
            retryDelaySeconds(Number(row.attempts) + 1),
          ],
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
