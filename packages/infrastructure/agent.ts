import {
  AgentIntelligenceResultSchema,
  type AgentIntelligenceResult,
} from '../contracts/intelligence-search';
import { intelligenceSelection } from '../domain/intelligence-intent';
import { heatmapSelection } from '../domain/heatmap-intent';
import { AgentHeatmapResultSchema, type AgentHeatmapResult } from '../contracts/heatmap';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AgentInputRequest,
  AgentInputResponse,
  AgentInputSpec,
  AgentQueryResult,
  AgentSelection,
  AgentEvent,
  AgentMessage,
  AgentMessageInput,
  AgentSession,
  AgentStep,
  AgentTask,
} from '../contracts/agent';
import {
  AgentInputResponseSchema,
  AgentInputSpecSchema,
  AgentQueryResultSchema,
  AgentSelectionSchema,
} from '../contracts/agent';
import type { AnalysisResult, TopicDefinitionId } from '../contracts/topics';
import { classifyConversationIntent } from '../domain/agent-conversation';
import {
  deriveAgentIntent,
  derivePurposeIntent,
  requiredAgentInputFields,
} from '../domain/agent-intents';
import type { Infrastructure } from './clients';
import { resolveIntelligenceObjects } from './intelligence-search';

type Row = Record<string, unknown>;
const iso = (v: unknown) => new Date(v as string | Date).toISOString();
function taskRow(r: Row): AgentTask {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    ownerId: String(r.owner_id),
    status: r.status as AgentTask['status'],
    goal: String(r.goal),
    bbox: r.bbox as AgentTask['bbox'],
    historyHours: Number(r.history_hours),
    from: iso(r.from_time),
    to: iso(r.to_time),
    definitionId: r.definition_id as AgentTask['definitionId'],
    generation: Number(r.generation),
    modelCalls: Number(r.model_calls),
    toolCalls: Number(r.tool_calls),
    resultVersion: Number(r.result_version),
    summaryResultVersion:
      r.summary_result_version === null ? null : Number(r.summary_result_version),
    summary: r.summary as string | null,
    error: r.error as string | null,
    intent: r.intent as AgentTask['intent'],
    selection: (r.selection ?? {}) as AgentSelection,
    inputRevision: Number(r.input_revision ?? 0),
    resultInputRevision: r.result_input_revision == null ? null : Number(r.result_input_revision),
    summaryInputRevision:
      r.summary_input_revision == null ? null : Number(r.summary_input_revision),
    errorCode: (r.error_code ?? null) as string | null,
    retryOfTaskId: (r.retry_of_task_id ?? null) as string | null,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
const sessionRow = (r: Row): AgentSession => ({
  id: String(r.id),
  ownerId: String(r.owner_id),
  title: String(r.title),
  createdAt: iso(r.created_at),
});
const messageRow = (r: Row): AgentMessage => ({
  id: String(r.id),
  sessionId: String(r.session_id),
  role: r.role as AgentMessage['role'],
  content: String(r.content),
  taskId: r.task_id as string | null,
  resultVersion: r.result_version == null ? null : Number(r.result_version),
  inputRevision: r.input_revision == null ? null : Number(r.input_revision),
  createdAt: iso(r.created_at),
});
async function transaction<T>(
  infra: Infrastructure,
  work: (client: PoolClient) => Promise<T>,
  readOnly = false,
): Promise<T> {
  const client = await infra.pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
export class AgentInputError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'conflict' | 'invalid_input',
    message: string,
  ) {
    super(message);
  }
}
function requestRow(r: Row): AgentInputRequest {
  return {
    id: String(r.id),
    sessionId: String(r.session_id),
    taskId: String(r.task_id),
    inputRevision: Number(r.input_revision),
    pauseGeneration: Number(r.pause_generation),
    fields: r.fields as AgentInputRequest['fields'],
    reason: r.reason as AgentInputRequest['reason'],
    prefill: r.prefill as AgentSelection,
    status: r.status as AgentInputRequest['status'],
    response: (r.response ?? null) as AgentSelection | null,
    createdAt: iso(r.created_at),
    answeredAt: r.answered_at ? iso(r.answered_at) : null,
  };
}
async function pendingRequests(client: PoolClient, sessionId: string, taskId?: string) {
  return (
    await client.query(
      "SELECT * FROM agent_input_requests WHERE session_id=$1 AND status='pending' AND ($2::uuid IS NULL OR task_id=$2) ORDER BY created_at,id",
      [sessionId, taskId ?? null],
    )
  ).rows.map(requestRow);
}
async function snapshotCursor(client: PoolClient, sessionId: string) {
  return String(
    (
      await client.query(
        'SELECT coalesce(max(id),0)::text AS cursor FROM agent_events WHERE session_id=$1',
        [sessionId],
      )
    ).rows[0].cursor,
  );
}
const reasonFor = (fields: AgentInputSpec['fields']): AgentInputSpec['reason'] =>
  fields.includes('topic')
    ? 'missing_topic'
    : fields.includes('goal')
      ? 'missing_goal'
      : fields.includes('region')
        ? 'missing_region'
        : fields.includes('vessels')
          ? 'missing_vessels'
          : 'missing_time';
const inputPrompt = (spec: AgentInputSpec, selection: AgentSelection) =>
  spec.fields.includes('topic') &&
  selection.intelligenceQuery?.kind === 'marine' &&
  !selection.intelligenceQuery.samplePointId
    ? '海况仅覆盖六个代表点，无法提供任意港口海况；所选代表点不能替代港口海况。请选择代表点后继续。'
    : {
        missing_topic: '请选择情报主题或海况代表点，确认后将继续本地检索。',
        missing_region: '请选择本次任务的区域，确认后将自动继续。',
        missing_vessels: '请选择需要查询的船舶，确认后将自动继续。',
        missing_time: '请选择本次任务的时间范围，确认后将自动继续。',
        missing_goal: '请选择需要执行的任务，确认后将自动继续。',
        data_limit: '数据量超过上限，请缩小区域、船舶或时间范围。',
        retention: '查询超出在线历史保留范围，请选择近期时间。',
        scope_changed: '请选择本次任务的范围，确认后将自动继续。',
      }[spec.reason];

async function removeObjectKeywords(client: PoolClient, selection: AgentSelection, ids: string[]) {
  if (!selection.intelligenceQuery?.keyword || !ids.length) return;
  const rows = await client.query(
    'SELECT name,data FROM intelligence_objects WHERE id=ANY($1::text[])',
    [ids],
  );
  let keyword = selection.intelligenceQuery.keyword.toLowerCase();
  const names = rows.rows
    .flatMap((row) => [row.name, ...(Array.isArray(row.data.aliases) ? row.data.aliases : [])])
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  for (const name of names) keyword = keyword.replaceAll(name.toLowerCase(), '');
  keyword = keyword.replace(/附近|周边|有关|相关|关于|周围|在|的/g, '').trim();
  if (keyword) selection.intelligenceQuery.keyword = keyword;
  else delete selection.intelligenceQuery.keyword;
}
async function insertInputRequest(client: PoolClient, row: Row, spec: AgentInputSpec) {
  const found = await client.query(
    "SELECT * FROM agent_input_requests WHERE task_id=$1 AND status='pending'",
    [row.id],
  );
  if (found.rowCount) return requestRow(found.rows[0]);
  const result = await client.query(
    `INSERT INTO agent_input_requests(id,task_id,session_id,input_revision,pause_generation,fields,reason,prefill,status)
    VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb,'pending') RETURNING *`,
    [
      randomUUID(),
      row.id,
      row.session_id,
      row.input_revision ?? 0,
      row.generation,
      JSON.stringify(spec.fields),
      spec.reason,
      JSON.stringify(row.selection ?? {}),
    ],
  );
  const request = requestRow(result.rows[0]);
  await client.query(
    "UPDATE agent_tasks SET status='awaiting_input',lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1",
    [row.id],
  );
  await client.query(
    "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'assistant',$4)",
    [randomUUID(), row.session_id, row.id, inputPrompt(spec, row.selection ?? {})],
  );
  await event(client, String(row.session_id), String(row.id), 'input.requested', {
    requestId: request.id,
    inputRevision: request.inputRevision,
  });
  return request;
}
async function event(
  client: PoolClient,
  sessionId: string,
  taskId: string | null,
  type: string,
  data: unknown = {},
) {
  await client.query(
    'INSERT INTO agent_events(session_id,task_id,type,data) VALUES($1,$2,$3,$4::jsonb)',
    [sessionId, taskId, type, JSON.stringify(data)],
  );
}
// Serialize mutations per session before allocating event IDs, making cursor replay commit-safe.
async function lockTask(client: PoolClient, taskId: string): Promise<Row | null> {
  const found = await client.query('SELECT session_id FROM agent_tasks WHERE id=$1', [taskId]);
  if (!found.rowCount) return null;
  await client.query('SELECT id FROM agent_sessions WHERE id=$1 FOR UPDATE', [
    found.rows[0].session_id,
  ]);
  return (
    (
      await client.query(
        'SELECT *,lease_until>now() AS lease_valid FROM agent_tasks WHERE id=$1 FOR UPDATE',
        [taskId],
      )
    ).rows[0] ?? null
  );
}
async function canWrite(client: PoolClient, ownerId: unknown) {
  return Boolean(
    (
      await client.query(
        "SELECT id FROM users WHERE id=$1 AND NOT disabled AND role IN ('operator','admin')",
        [ownerId],
      )
    ).rowCount,
  );
}
/** Called inside the administrative user-change transaction; reopening permissions never revives these requests. */
export async function revokeAgentOwnerExecution(
  client: PoolClient,
  ownerId: string,
): Promise<void> {
  // Acquire every existing owner session in one stable order before any task lock.
  await client.query('SELECT id FROM agent_sessions WHERE owner_id=$1 ORDER BY id FOR UPDATE', [
    ownerId,
  ]);
  const tasks = await client.query(
    `SELECT id,session_id FROM agent_tasks WHERE owner_id=$1
    AND status IN ('awaiting_input','queued','running','waiting_result') ORDER BY session_id,id FOR UPDATE`,
    [ownerId],
  );
  for (const row of tasks.rows) {
    await client.query(
      "UPDATE agent_input_requests SET status='cancelled',answered_at=now() WHERE task_id=$1 AND status='pending'",
      [row.id],
    );
    await client.query(
      "UPDATE agent_tasks SET status='failed',error='用户执行权限已变更',error_code='permission_changed',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [row.id],
    );
    await event(client, String(row.session_id), String(row.id), 'task.failed', {
      reason: 'permission_changed',
    });
  }
}
async function fenced(
  client: PoolClient,
  taskId: string,
  workerId: string,
  generation: number,
): Promise<Row | null> {
  const row = await lockTask(client, taskId);
  if (
    !row ||
    !['running', 'waiting_result'].includes(String(row.status)) ||
    row.worker_id !== workerId ||
    row.generation !== generation ||
    !row.lease_valid ||
    !(await canWrite(client, row.owner_id))
  )
    return null;
  return row;
}
export async function createAgentSession(
  infra: Infrastructure,
  ownerId: string,
  title: string,
): Promise<AgentSession> {
  return transaction(infra, async (client) => {
    // This lock precedes creating a session, so an administrator's revocation cannot
    // miss a new session submitted while the owner update is still uncommitted.
    const owner = await client.query(
      "SELECT id FROM users WHERE id=$1 AND NOT disabled AND role IN ('operator','admin') FOR SHARE",
      [ownerId],
    );
    if (!owner.rowCount) throw new AgentInputError('forbidden', 'Agent write permission required');
    const result = await client.query(
      'INSERT INTO agent_sessions(id,owner_id,title) VALUES($1,$2,$3) RETURNING *',
      [randomUUID(), ownerId, title],
    );
    return sessionRow(result.rows[0]);
  });
}
export async function listAgentSessions(
  infra: Infrastructure,
  ownerId: string,
): Promise<AgentSession[]> {
  return (
    await infra.pool.query(
      'SELECT * FROM agent_sessions WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100',
      [ownerId],
    )
  ).rows.map(sessionRow);
}
export async function getAgentSession(infra: Infrastructure, ownerId: string, sessionId: string) {
  return transaction(
    infra,
    async (client) => {
      const session = (
        await client.query('SELECT * FROM agent_sessions WHERE id=$1 AND owner_id=$2', [
          sessionId,
          ownerId,
        ])
      ).rows[0];
      if (!session) return null;
      const messages = await client.query(
        "SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at,CASE role WHEN 'user' THEN 0 ELSE 1 END,id",
        [sessionId],
      );
      const tasks = await client.query(
        'SELECT * FROM agent_tasks WHERE session_id=$1 ORDER BY created_at,id',
        [sessionId],
      );
      return {
        session: sessionRow(session),
        messages: messages.rows.map(messageRow),
        tasks: tasks.rows.map(taskRow),
        pendingInputRequests: await pendingRequests(client, sessionId),
        snapshotCursor: await snapshotCursor(client, sessionId),
      };
    },
    true,
  );
}
export async function submitAgentMessage(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  key: string,
  input: AgentMessageInput,
) {
  const hash = createHash('sha256')
    .update(
      JSON.stringify({
        sessionId,
        content: input.content,
        bbox: input.bbox ?? null,
        historyHours: input.historyHours,
        mapContext: input.mapContext ?? null,
      }),
    )
    .digest('hex');
  return transaction(infra, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `agent-message:${ownerId}:${key}`,
    ]);
    const session = await client.query(
      'SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [sessionId, ownerId],
    );
    if (!session.rowCount) throw new Error('Agent session not found');
    if (!(await canWrite(client, ownerId))) throw new Error('Agent write permission required');
    const previous = (
      await client.query('SELECT * FROM agent_tasks WHERE owner_id=$1 AND idempotency_key=$2', [
        ownerId,
        key,
      ])
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash)
        throw new Error('Idempotency key reused with different request');
      const message = (
        await client.query(
          "SELECT * FROM agent_messages WHERE task_id=$1 AND role='user' ORDER BY created_at,id LIMIT 1",
          [previous.id],
        )
      ).rows[0];
      return {
        message: messageRow(message),
        task: taskRow(previous),
        pendingInputRequests: await pendingRequests(client, sessionId, String(previous.id)),
      };
    }
    const id = randomUUID();
    const derived = deriveAgentIntent(input.content);
    const now = new Date();
    const selection: AgentSelection = {
      ...(input.bbox ? { bbox: input.bbox } : {}),
      timeRange: {
        from: new Date(now.getTime() - input.historyHours * 3_600_000).toISOString(),
        to: now.toISOString(),
      },
      ...(derived.purpose ? { purpose: derived.purpose } : {}),
    };
    const explicitIntelligenceRegion =
      /当前.*(?:视野|视图|地图|海图)|(?:视野|视图)内|所选区域|这个区域|当前区域/.test(
        input.content,
      );
    if (derived.intent === 'ais_heatmap') {
      delete selection.timeRange;
      Object.assign(selection, heatmapSelection(input.content, now));
      const explicit = input.content.match(/\b[1-9]\d{8}\b/g);
      if (explicit) {
        const mmsis = [...new Set(explicit)];
        if (mmsis.length > 100)
          throw new AgentInputError(
            'invalid_input',
            '热力图一次最多筛选 100 艘船舶，请缩小船舶范围后重试。',
          );
        selection.mmsis = mmsis;
      } else if (
        input.mapContext?.selectedMmsis?.length &&
        /选中|选定|这艘|该船|当前船舶/.test(input.content)
      )
        selection.mmsis = input.mapContext.selectedMmsis;
    }
    if (derived.intent === 'intelligence_search') {
      Object.assign(selection, intelligenceSelection(input.content, now));
      delete selection.bbox;
      if (selection.intelligenceQuery?.bbox) selection.bbox = selection.intelligenceQuery.bbox;
      if (explicitIntelligenceRegion && (input.mapContext?.bbox || input.bbox)) {
        selection.bbox = /所选区域|这个区域|当前区域/.test(input.content)
          ? (input.bbox ?? input.mapContext?.bbox)
          : (input.mapContext?.bbox ?? input.bbox);
        selection.intelligenceQuery = { ...selection.intelligenceQuery, bbox: selection.bbox };
        delete selection.intelligenceQuery.locationKeyword;
      }
      if (!explicitIntelligenceRegion && selection.intelligenceQuery?.kind !== 'marine') {
        const objects = await resolveIntelligenceObjects(infra, input.content, client);
        if (objects.length) {
          delete selection.bbox;
          delete selection.intelligenceQuery!.bbox;
          delete selection.intelligenceQuery!.locationKeyword;
          await removeObjectKeywords(
            client,
            selection,
            objects.map((object) => object.id),
          );
          if (objects.length === 1) selection.intelligenceQuery!.objectId = objects[0]!.id;
          else {
            selection.intelligenceObjectUnclear = true;
            selection.intelligenceObjectCandidates = objects
              .slice(0, 20)
              .map(({ id, name }) => ({ id, name }));
          }
        }
      }
    }
    if (input.mapContext && /当前.*(?:视野|视图|地图|海图)|(?:视野|视图)内/.test(input.content)) {
      if (derived.intent !== 'intelligence_search') selection.bbox = input.mapContext.bbox;
      const { sourceId, shipType, hours } = input.mapContext;
      selection.filters = {
        ...(sourceId ? { sourceId } : {}),
        ...(shipType !== undefined ? { shipType } : {}),
        ...(hours !== undefined ? { hours } : {}),
      };
    }
    if (derived.intent === 'vessel_detail') {
      const explicit = input.content.match(/\b\d{9}\b/g);
      if (explicit) selection.mmsis = [...new Set(explicit)].slice(0, 100);
      else if (
        input.mapContext?.selectedMmsis?.length &&
        /选中|选定|这艘|该船|当前船舶/.test(input.content)
      )
        selection.mmsis = input.mapContext.selectedMmsis;
    }
    // Legacy text continuations still create an independent task and retain their parent chain.
    const legacyContinuation =
      /^(?:已确认区域(?:请执行)?|确认区域|已选择区域请执行|请执行|开始|继续(?:分析)?)$/.test(
        input.content.replace(/[，,。！!\s]/g, ''),
      );
    const fields =
      legacyContinuation && input.bbox ? [] : requiredAgentInputFields(selection, derived.intent);
    const status = fields.length ? 'awaiting_input' : 'queued';
    const parent =
      (
        await client.query(
          `SELECT e.task_id,t.goal FROM agent_events e JOIN agent_tasks t ON t.id=e.task_id AND t.session_id=e.session_id
          WHERE e.session_id=$1 AND e.type='task.created' ORDER BY e.id DESC`,
          [sessionId],
        )
      ).rows.find((row) => classifyConversationIntent(String(row.goal)) === null)?.task_id ?? null;
    const result = await client.query(
      `INSERT INTO agent_tasks(id,session_id,owner_id,idempotency_key,request_hash,status,goal,bbox,history_hours,from_time,to_time,parent_task_id,intent,selection)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
      [
        id,
        sessionId,
        ownerId,
        key,
        hash,
        status,
        input.content,
        JSON.stringify(selection.bbox ?? null),
        input.historyHours,
        selection.timeRange?.from ??
          new Date(now.getTime() - input.historyHours * 3_600_000).toISOString(),
        selection.timeRange?.to ?? now.toISOString(),
        parent,
        derived.intent,
        JSON.stringify(selection),
      ],
    );
    const message = await client.query(
      "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'user',$4) RETURNING *",
      [randomUUID(), sessionId, id, input.content],
    );
    // Partial results remain resumable; cancelled denotes an explicit user cancellation.
    await event(client, sessionId, id, 'task.created', { status });
    const requests = fields.length
      ? [await insertInputRequest(client, result.rows[0], { fields, reason: reasonFor(fields) })]
      : [];
    return {
      message: messageRow(message.rows[0]),
      task: taskRow(result.rows[0]),
      pendingInputRequests: requests,
    };
  });
}
async function readTaskContext(
  client: PoolClient,
  taskId: string,
  ownerId?: string,
  resultVersion?: number,
) {
  const task = (
    await client.query(
      'SELECT * FROM agent_tasks WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2)',
      [taskId, ownerId ?? null],
    )
  ).rows[0];
  if (!task) return null;
  const messages = await client.query(
    "SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at,CASE role WHEN 'user' THEN 0 ELSE 1 END,id",
    [task.session_id],
  );
  const steps = await client.query(
    'SELECT * FROM agent_steps WHERE task_id=$1 AND input_revision=$2 ORDER BY created_at,step_key',
    [taskId, task.input_revision],
  );
  const result = await client.query(
    'SELECT results,query_result,intelligence_result,heatmap_result FROM agent_results WHERE task_id=$1 AND version=$2',
    [taskId, resultVersion ?? task.result_version],
  );
  if (resultVersion !== undefined && !result.rowCount) return null;
  return {
    task: taskRow(task),
    messages: messages.rows.map(messageRow),
    steps: steps.rows.map((r): AgentStep => ({
      key: r.step_key,
      name: r.name,
      input: r.input,
      output: r.output,
      createdAt: iso(r.created_at),
    })),
    results: (result.rows[0]?.results ?? []) as AnalysisResult[],
    queryResult: (result.rows[0]?.query_result ?? null) as AgentQueryResult | null,
    intelligenceResult: (result.rows[0]?.intelligence_result ??
      null) as AgentIntelligenceResult | null,
    heatmapResult: (result.rows[0]?.heatmap_result ?? null) as AgentHeatmapResult | null,
    pendingInputRequests: await pendingRequests(client, String(task.session_id), taskId),
    snapshotCursor: await snapshotCursor(client, String(task.session_id)),
  };
}
export async function getAgentTaskContext(infra: Infrastructure, taskId: string) {
  return transaction(infra, (client) => readTaskContext(client, taskId), true);
}
export async function getOwnedAgentTask(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
  resultVersion?: number,
) {
  return transaction(
    infra,
    (client) => readTaskContext(client, taskId, ownerId, resultVersion),
    true,
  );
}
export async function getPreviousAgentTask(infra: Infrastructure, taskId: string) {
  const previous = await infra.pool.query(
    `SELECT previous.id FROM agent_tasks current_task JOIN agent_tasks previous ON previous.id=current_task.parent_task_id AND previous.session_id=current_task.session_id
    WHERE current_task.id=$1 AND (previous.status='awaiting_input' OR (previous.status IN ('completed','failed') AND previous.result_version>0))`,
    [taskId],
  );
  return previous.rows[0] ? getAgentTaskContext(infra, previous.rows[0].id) : null;
}
export async function reusePreviousAgentTask(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  previousTaskId: string,
): Promise<AgentTask | null> {
  return transaction(infra, async (client) => {
    const current = await fenced(client, taskId, workerId, generation);
    if (!current) return null;
    const previous = (
      await client.query(
        "SELECT * FROM agent_tasks WHERE id=$1 AND id=$3 AND session_id=$2 AND status IN ('completed','failed','awaiting_input')",
        [previousTaskId, current.session_id, current.parent_task_id],
      )
    ).rows[0];
    if (
      !previous ||
      !previous.result_version ||
      previous.result_input_revision !== previous.input_revision
    )
      return null;
    if (
      Number(current.result_version) > 0 &&
      current.result_input_revision === current.input_revision
    )
      return taskRow(current);
    const nextVersion = Number(current.result_version) + 1;
    await client.query(
      "INSERT INTO agent_results(task_id,version,results,input_revision,kind,query_result,intelligence_result,heatmap_result) SELECT $1,$4,results,$5,kind,CASE WHEN query_result IS NULL THEN NULL ELSE query_result || jsonb_build_object('version',$4::int,'inputRevision',$5::int) END,CASE WHEN intelligence_result IS NULL THEN NULL ELSE intelligence_result || jsonb_build_object('version',$4::int,'inputRevision',$5::int) END,CASE WHEN heatmap_result IS NULL THEN NULL ELSE heatmap_result || jsonb_build_object('version',$4::int,'inputRevision',$5::int) END FROM agent_results WHERE task_id=$2 AND version=$3",
      [taskId, previousTaskId, previous.result_version, nextVersion, current.input_revision],
    );
    await client.query(
      `INSERT INTO agent_steps(task_id,input_revision,step_key,name,input,output)
      SELECT $1,$3,step_key,name,input,output FROM agent_steps WHERE task_id=$2 AND input_revision=$4 AND step_key IN ('overview','input_snapshot','input_digest') ON CONFLICT DO NOTHING`,
      [taskId, previousTaskId, current.input_revision, previous.input_revision],
    );
    await copyIntelligencePins(
      client,
      previousTaskId,
      Number(previous.result_version),
      taskId,
      Number(current.input_revision),
    );
    const updated = await client.query(
      'UPDATE agent_tasks SET bbox=$2::jsonb,history_hours=$3,from_time=$4,to_time=$5,definition_id=$6,result_version=$7,result_input_revision=input_revision,selection=$8::jsonb,updated_at=now() WHERE id=$1 RETURNING *',
      [
        taskId,
        JSON.stringify(previous.bbox),
        previous.history_hours,
        previous.from_time,
        previous.to_time,
        previous.definition_id,
        nextVersion,
        JSON.stringify(previous.selection),
      ],
    );
    await event(client, String(current.session_id), taskId, 'results.reused', {
      previousTaskId,
      previousResultVersion: previous.result_version,
      version: nextVersion,
    });
    return taskRow(updated.rows[0]);
  });
}
export async function listRunnableAgentTasks(infra: Infrastructure): Promise<string[]> {
  return (
    await infra.pool.query(
      "SELECT id FROM agent_tasks WHERE status='queued' OR (status IN ('running','waiting_result') AND lease_until<=now()) ORDER BY created_at LIMIT 100",
    )
  ).rows.map((r) => r.id);
}
export async function claimAgentTask(
  infra: Infrastructure,
  workerId: string,
  taskId?: string,
  leaseSeconds = 90,
): Promise<AgentTask | null> {
  const id = taskId ?? (await listRunnableAgentTasks(infra))[0];
  if (!id) return null;
  return transaction(infra, async (client) => {
    const row = await lockTask(client, id);
    if (
      !row ||
      !(
        row.status === 'queued' ||
        (['running', 'waiting_result'].includes(String(row.status)) && !row.lease_valid)
      )
    )
      return null;
    if (!(await canWrite(client, row.owner_id))) {
      await client.query(
        "UPDATE agent_input_requests SET status='cancelled',answered_at=now() WHERE task_id=$1 AND status='pending'",
        [id],
      );
      await client.query(
        "UPDATE agent_tasks SET status='failed',error='用户执行权限已变更',generation=generation+1,updated_at=now() WHERE id=$1",
        [id],
      );
      await event(client, String(row.session_id), id, 'task.failed', {
        reason: 'permission_changed',
      });
      return null;
    }
    const result = await client.query(
      "UPDATE agent_tasks SET status='running',worker_id=$2,lease_until=now()+make_interval(secs=>$3),generation=generation+1,updated_at=now() WHERE id=$1 RETURNING *",
      [id, workerId, leaseSeconds],
    );
    await event(client, String(row.session_id), id, 'task.running');
    return taskRow(result.rows[0]);
  });
}
export async function renewAgentTask(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  leaseSeconds = 90,
): Promise<boolean> {
  return transaction(infra, async (client) => {
    if (!(await fenced(client, taskId, workerId, generation))) return false;
    await client.query(
      'UPDATE agent_tasks SET lease_until=now()+make_interval(secs=>$2) WHERE id=$1',
      [taskId, leaseSeconds],
    );
    return true;
  });
}
export async function reserveAgentCall(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  kind: 'model' | 'tool',
  maxCalls: number,
): Promise<boolean> {
  return transaction(infra, async (client) => {
    if (!(await fenced(client, taskId, workerId, generation))) return false;
    const column = kind === 'model' ? 'model_calls' : 'tool_calls';
    return Boolean(
      (
        await client.query(
          `UPDATE agent_tasks SET ${column}=${column}+1,updated_at=now() WHERE id=$1 AND ${column}<$2`,
          [taskId, maxCalls],
        )
      ).rowCount,
    );
  });
}
export async function setAgentDefinition(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  definitionId: TopicDefinitionId,
): Promise<boolean> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row || (row.definition_id && row.definition_id !== definitionId)) return false;
    await client.query('UPDATE agent_tasks SET definition_id=$2,updated_at=now() WHERE id=$1', [
      taskId,
      definitionId,
    ]);
    return true;
  });
}
export async function saveAgentStep(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  step: Omit<AgentStep, 'createdAt'>,
): Promise<boolean> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row) return false;
    const inserted = await client.query(
      `INSERT INTO agent_steps(task_id,step_key,name,input,output,input_revision) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)
      ${
        step.key === 'clock_snapshot'
          ? 'ON CONFLICT (task_id,input_revision,step_key) DO UPDATE SET name=EXCLUDED.name,input=EXCLUDED.input,output=EXCLUDED.output,created_at=now()'
          : 'ON CONFLICT DO NOTHING'
      }`,
      [
        taskId,
        step.key,
        step.name,
        JSON.stringify(step.input ?? null),
        JSON.stringify(step.output ?? null),
        row.input_revision,
      ],
    );
    if (inserted.rowCount)
      await event(client, String(row.session_id), taskId, 'tool.completed', {
        name: step.name,
        key: step.key,
      });
    return true;
  });
}
export async function saveAgentResults(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  results: AnalysisResult[],
): Promise<number | null> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row) {
      // Retain late computation in local audit without moving task state or exposing it to the model.
      const late = await client.query('SELECT session_id FROM agent_tasks WHERE id=$1', [taskId]);
      if (late.rowCount)
        await event(client, late.rows[0].session_id, taskId, 'results.discarded', {
          generation,
          results,
        });
      return null;
    }
    if (Number(row.result_version) > 0 && row.result_input_revision === row.input_revision)
      return Number(row.result_version);
    const version = Number(row.result_version) + 1;
    await client.query(
      'INSERT INTO agent_results(task_id,version,results,input_revision) VALUES($1,$2,$3::jsonb,$4)',
      [taskId, version, JSON.stringify(results), row.input_revision],
    );
    await client.query(
      'UPDATE agent_tasks SET result_version=$2,result_input_revision=input_revision,updated_at=now() WHERE id=$1',
      [taskId, version],
    );
    await event(client, String(row.session_id), taskId, 'results.saved', {
      version,
      count: results.length,
    });
    return version;
  });
}
export async function finishAgentTask(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  outcome: {
    status: 'completed' | 'failed' | 'awaiting_input';
    summary?: string;
    summaryResultVersion?: number;
    error?: string;
    errorCode?: string;
  },
): Promise<boolean> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (
      !row ||
      (outcome.summaryResultVersion !== undefined &&
        (outcome.summaryResultVersion !== Number(row.result_version) ||
          (outcome.summaryResultVersion > 0 && row.result_input_revision !== row.input_revision)))
    )
      return false;
    if (
      outcome.status === 'completed' &&
      ['analysis', 'vessel_list', 'vessel_detail', 'intelligence_search', 'ais_heatmap'].includes(
        String(row.intent),
      ) &&
      (!Number(row.result_version) || row.result_input_revision !== row.input_revision)
    )
      return false;
    await client.query(
      'UPDATE agent_tasks SET status=$2,summary=$3,error=$4,summary_result_version=$5,summary_input_revision=CASE WHEN $3::text IS NOT NULL THEN input_revision ELSE NULL END,error_code=$6,lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1',
      [
        taskId,
        outcome.status,
        outcome.summary ?? null,
        outcome.error ?? null,
        outcome.summary ? (outcome.summaryResultVersion ?? Number(row.result_version)) : null,
        outcome.errorCode ?? null,
      ],
    );
    if (outcome.summary)
      await client.query(
        "INSERT INTO agent_messages(id,session_id,task_id,role,content,result_version,input_revision) VALUES($1,$2,$3,'assistant',$4,$5,$6)",
        [
          randomUUID(),
          row.session_id,
          taskId,
          outcome.summary,
          Number(row.result_version) || null,
          row.input_revision,
        ],
      );
    await event(client, String(row.session_id), taskId, `task.${outcome.status}`, {
      status: outcome.status,
    });
    return true;
  });
}
export async function cancelAgentTask(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
): Promise<AgentTask | null> {
  return transaction(infra, async (client) => {
    const row = await lockTask(client, taskId);
    if (!row || row.owner_id !== ownerId) return null;
    if (['completed', 'failed', 'cancelled'].includes(String(row.status))) return taskRow(row);
    await client.query(
      "UPDATE agent_input_requests SET status='cancelled',answered_at=now() WHERE task_id=$1 AND status='pending'",
      [taskId],
    );
    const updated = await client.query(
      "UPDATE agent_tasks SET status='cancelled',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [taskId],
    );
    await event(client, String(row.session_id), taskId, 'task.cancelled');
    return taskRow(updated.rows[0]);
  });
}

/** Suspend without holding a worker or a network request while the user chooses conditions. */
export async function requestAgentInput(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  spec: AgentInputSpec,
): Promise<boolean> {
  const parsed = AgentInputSpecSchema.parse(spec);
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row) return false;
    await insertInputRequest(client, row, parsed);
    await event(client, String(row.session_id), taskId, 'task.awaiting_input');
    return true;
  });
}

export async function saveAgentHeatmapResult(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  result: AgentHeatmapResult,
): Promise<number | null> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row || result.inputRevision !== Number(row.input_revision)) return null;
    if (Number(row.result_version) > 0 && row.result_input_revision === row.input_revision)
      return Number(row.result_version);
    const version = Number(row.result_version) + 1;
    const stored = AgentHeatmapResultSchema.parse({
      ...result,
      version,
      inputRevision: Number(row.input_revision),
    });
    await client.query(
      "INSERT INTO agent_results(task_id,version,results,input_revision,kind,heatmap_result) VALUES($1,$2,'[]',$3,'ais_heatmap',$4::jsonb)",
      [taskId, version, row.input_revision, JSON.stringify(stored)],
    );
    await client.query(
      'UPDATE agent_tasks SET result_version=$2,result_input_revision=input_revision,updated_at=now() WHERE id=$1',
      [taskId, version],
    );
    await event(client, String(row.session_id), taskId, 'results.saved', {
      version,
      inputRevision: row.input_revision,
      kind: stored.kind,
      count: stored.totalVessels,
    });
    return version;
  });
}

export async function saveAgentQueryResult(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  result: AgentQueryResult,
): Promise<number | null> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row) return null;
    if (Number(row.result_version) > 0 && row.result_input_revision === row.input_revision)
      return Number(row.result_version);
    const version = Number(row.result_version) + 1;
    const stored = AgentQueryResultSchema.parse({
      ...result,
      version,
      inputRevision: Number(row.input_revision),
    });
    await client.query(
      "INSERT INTO agent_results(task_id,version,results,input_revision,kind,query_result) VALUES($1,$2,'[]',$3,$4,$5::jsonb)",
      [taskId, version, row.input_revision, stored.kind, JSON.stringify(stored)],
    );
    await client.query(
      'UPDATE agent_tasks SET result_version=$2,result_input_revision=input_revision,updated_at=now() WHERE id=$1',
      [taskId, version],
    );
    await event(client, String(row.session_id), taskId, 'results.saved', {
      version,
      inputRevision: row.input_revision,
      kind: stored.kind,
      count: stored.total,
    });
    return version;
  });
}

async function pinIntelligence(
  client: PoolClient,
  taskId: string,
  revision: number,
  result: AgentIntelligenceResult,
) {
  const ids = [
    ...new Set(
      result.evidence.flatMap((entry) => (entry.kind === 'marine' ? [entry.forecast.id] : [])),
    ),
  ];
  if (!ids.length) return;
  // The FK and row lock make a concurrent retention cleanup either wait or reject this save.
  const available = await client.query(
    'SELECT id FROM intelligence_weather_snapshots WHERE id=ANY($1::text[]) FOR KEY SHARE',
    [ids],
  );
  if (available.rowCount !== ids.length)
    throw new AgentInputError('conflict', '海况归档已失效，请重新查询');
  await client.query(
    'INSERT INTO intelligence_weather_pins(snapshot_id,task_id,input_revision) SELECT unnest($1::text[]),$2,$3 ON CONFLICT DO NOTHING',
    [ids, taskId, revision],
  );
}
async function copyIntelligencePins(
  client: PoolClient,
  sourceId: string,
  version: number,
  taskId: string,
  revision: number,
) {
  const row = (
    await client.query(
      'SELECT intelligence_result FROM agent_results WHERE task_id=$1 AND version=$2',
      [sourceId, version],
    )
  ).rows[0];
  if (row?.intelligence_result)
    await pinIntelligence(
      client,
      taskId,
      revision,
      AgentIntelligenceResultSchema.parse(row.intelligence_result),
    );
}
export async function saveAgentIntelligenceResult(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  result: AgentIntelligenceResult,
): Promise<number | null> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (!row) return null;
    if (Number(row.result_version) > 0 && row.result_input_revision === row.input_revision)
      return Number(row.result_version);
    const version = Number(row.result_version) + 1;
    const stored = AgentIntelligenceResultSchema.parse({
      ...result,
      version,
      inputRevision: Number(row.input_revision),
    });
    await pinIntelligence(client, taskId, Number(row.input_revision), stored);
    await client.query(
      "INSERT INTO agent_results(task_id,version,results,input_revision,kind,intelligence_result) VALUES($1,$2,'[]',$3,'intelligence_search',$4::jsonb)",
      [taskId, version, row.input_revision, JSON.stringify(stored)],
    );
    await client.query(
      'UPDATE agent_tasks SET result_version=$2,result_input_revision=input_revision,updated_at=now() WHERE id=$1',
      [taskId, version],
    );
    await event(client, String(row.session_id), taskId, 'results.saved', {
      version,
      inputRevision: row.input_revision,
      kind: stored.kind,
      count: stored.total,
    });
    return version;
  });
}

function canonicalSelection(value: AgentSelection): AgentSelection {
  const selection = AgentSelectionSchema.parse(value);
  if (selection.mmsis) selection.mmsis.sort();
  if (selection.timeRange)
    selection.timeRange = { from: iso(selection.timeRange.from), to: iso(selection.timeRange.to) };
  return selection;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export async function respondAgentInput(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
  requestId: string,
  key: string,
  response: AgentInputResponse,
): Promise<{ task: AgentTask; request: AgentInputRequest }> {
  const input = AgentInputResponseSchema.parse(response);
  const hash = createHash('sha256').update(stableJson({ taskId, requestId, input })).digest('hex');
  return transaction(infra, async (client) => {
    // The owner-key lock precedes the shared session/task/request order for idempotent mutations.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `agent-input:${ownerId}:${key}`,
    ]);
    const task = await lockTask(client, taskId);
    if (!task || task.owner_id !== ownerId)
      throw new AgentInputError('not_found', 'Task not found');
    if (!(await canWrite(client, ownerId)))
      throw new AgentInputError('forbidden', 'Agent write permission required');
    const previous = (
      await client.query(
        'SELECT * FROM agent_input_responses WHERE owner_id=$1 AND idempotency_key=$2',
        [ownerId, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash)
        throw new AgentInputError('conflict', 'Idempotency key reused with different request');
      return previous.response as { task: AgentTask; request: AgentInputRequest };
    }
    const row = (
      await client.query(
        'SELECT * FROM agent_input_requests WHERE id=$1 AND task_id=$2 FOR UPDATE',
        [requestId, taskId],
      )
    ).rows[0];
    if (!row) throw new AgentInputError('not_found', 'Input request not found');
    if (
      row.status !== 'pending' ||
      task.status !== 'awaiting_input' ||
      row.input_revision !== input.inputRevision ||
      task.input_revision !== input.inputRevision ||
      row.pause_generation !== task.generation
    )
      throw new AgentInputError('conflict', 'Input request is no longer current');
    let request: AgentInputRequest;
    let updated: Row;
    if (input.action === 'decline') {
      request = requestRow(
        (
          await client.query(
            "UPDATE agent_input_requests SET status='cancelled',answered_at=now() WHERE id=$1 RETURNING *",
            [requestId],
          )
        ).rows[0],
      );
      updated = (
        await client.query(
          "UPDATE agent_tasks SET status='cancelled',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
          [taskId],
        )
      ).rows[0];
      await event(client, String(task.session_id), taskId, 'task.cancelled', { requestId });
    } else {
      const { historyHours, ...values } = input.values;
      let selection = { ...(task.selection as AgentSelection), ...values };
      if (historyHours !== undefined) {
        const now = new Date();
        selection.timeRange = {
          from: new Date(now.getTime() - historyHours * 3_600_000).toISOString(),
          to: now.toISOString(),
        };
      }
      if (selection.purpose === 'ais_heatmap') {
        if (values.timeRange || historyHours !== undefined) delete selection.heatmapTimeUnclear;
        else if ((task.selection as AgentSelection).heatmapTimeUnclear)
          selection.heatmapTimeUnclear = true;
      }
      if (selection.purpose === 'intelligence_search') {
        const query = values.intelligenceQuery;
        const persisted = task.selection as AgentSelection;
        if (persisted.intelligenceObjectUnclear) {
          // Candidate authority comes from the persisted request, never from client flags/lists.
          selection.intelligenceObjectUnclear = true;
          selection.intelligenceObjectCandidates = persisted.intelligenceObjectCandidates;
          if (
            query?.objectId &&
            !persisted.intelligenceObjectCandidates?.some((object) => object.id === query.objectId)
          )
            throw new AgentInputError('invalid_input', '请选择本任务提供的对象候选');
        }
        if (selection.intelligenceQuery?.objectId) {
          const objectId = selection.intelligenceQuery.objectId;
          const object = await client.query(
            "SELECT id FROM intelligence_objects WHERE id=$1 AND kind<>'vessel'",
            [objectId],
          );
          if (!object.rowCount)
            throw new AgentInputError('invalid_input', '所选对象已不可用，请重新选择');
          if (!persisted.intelligenceObjectUnclear || query?.objectId) {
            delete selection.intelligenceObjectUnclear;
            delete selection.intelligenceObjectCandidates;
            await removeObjectKeywords(client, selection, [objectId]);
          }
        }
        const kind =
          query?.kind ??
          selection.intelligenceQuery?.kind ??
          (query?.forecastFrom && query.forecastTo ? 'marine' : 'events');
        const marine = kind === 'marine';
        const explicitRange =
          values.intelligenceTimeRange ??
          (marine && query?.forecastFrom && query.forecastTo
            ? { from: query.forecastFrom, to: query.forecastTo }
            : !marine && query?.from && query.to
              ? { from: query.from, to: query.to }
              : undefined);
        if (explicitRange) {
          delete selection.intelligenceTimeUnclear;
          selection.intelligenceTimeRange = explicitRange;
          selection.intelligenceQuery = {
            ...selection.intelligenceQuery,
            kind,
            ...(marine
              ? {
                  forecastFrom: explicitRange.from,
                  forecastTo: explicitRange.to,
                }
              : { from: explicitRange.from, to: explicitRange.to }),
          };
        } else if (persisted.intelligenceTimeUnclear) selection.intelligenceTimeUnclear = true;
        if (selection.intelligenceQuery && kind === 'events') {
          delete selection.intelligenceQuery.forecastFrom;
          delete selection.intelligenceQuery.forecastTo;
        } else if (selection.intelligenceQuery && marine) {
          delete selection.intelligenceQuery.from;
          delete selection.intelligenceQuery.to;
        }
        if (values.bbox) {
          selection.intelligenceQuery = { ...selection.intelligenceQuery, bbox: values.bbox };
          delete selection.intelligenceQuery.locationKeyword;
        } else if (values.intelligenceQuery?.bbox) selection.bbox = values.intelligenceQuery.bbox;
      }
      selection = canonicalSelection(selection);
      if (selection.mmsis?.length) {
        const found = await client.query('SELECT mmsi FROM vessels WHERE mmsi=ANY($1::text[])', [
          selection.mmsis,
        ]);
        if (found.rows.length !== selection.mmsis.length)
          throw new AgentInputError('invalid_input', '部分船舶已不可用，请重新选择');
      }
      const intent = selection.purpose
        ? derivePurposeIntent(selection.purpose)
        : (task.intent as NonNullable<AgentTask['intent']>);
      if (
        (intent === 'analysis' || intent === 'ais_heatmap') &&
        selection.timeRange &&
        (Date.parse(selection.timeRange.from) < Date.now() - 30 * 86400_000 ||
          Date.parse(selection.timeRange.to) > Date.now() + (intent === 'ais_heatmap' ? 0 : 60_000))
      )
        throw new AgentInputError('invalid_input', '请选择最近 30 天内的有效时间范围');
      const missing = requiredAgentInputFields(selection, intent);
      // A goal answer may intentionally introduce a second required field in the next turn.
      const unresolved = (row.fields as AgentInputSpec['fields']).filter((field) =>
        missing.includes(field),
      );
      if (unresolved.length)
        throw new AgentInputError('invalid_input', `仍需补充：${unresolved.join(', ')}`);
      if (
        ['data_limit', 'retention', 'scope_changed'].includes(String(row.reason)) &&
        stableJson(selection) === stableJson(task.selection)
      )
        throw new AgentInputError('invalid_input', '请调整条件后继续');
      const changed =
        stableJson(selection) !== stableJson(task.selection) || intent !== task.intent;
      const revision = Number(task.input_revision) + (changed ? 1 : 0);
      const definition =
        selection.purpose === 'port-restriction' || selection.purpose === 'area-low-speed-notice'
          ? selection.purpose
          : null;
      updated = (
        await client.query(
          `UPDATE agent_tasks SET selection=$2::jsonb,intent=$3,input_revision=$4,bbox=$5::jsonb,
        from_time=$6,to_time=$7,history_hours=$8,definition_id=$9,status='queued',summary=NULL,summary_result_version=NULL,summary_input_revision=NULL,error=NULL,error_code=NULL,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *`,
          [
            taskId,
            JSON.stringify(selection),
            intent,
            revision,
            JSON.stringify(selection.bbox ?? null),
            selection.timeRange?.from ?? task.from_time,
            selection.timeRange?.to ?? task.to_time,
            historyHours ??
              (selection.timeRange
                ? Math.max(
                    1,
                    Math.ceil(
                      (Date.parse(selection.timeRange.to) - Date.parse(selection.timeRange.from)) /
                        3_600_000,
                    ),
                  )
                : task.history_hours),
            definition,
          ],
        )
      ).rows[0];
      request = requestRow(
        (
          await client.query(
            "UPDATE agent_input_requests SET status='answered',response=$2::jsonb,answered_at=now() WHERE id=$1 RETURNING *",
            [requestId, JSON.stringify(selection)],
          )
        ).rows[0],
      );
      const labels = {
        ais_heatmap: 'AIS 船舶热力图',
        intelligence_search: '本地情报检索',
        vessel_list: '区域船舶查询',
        vessel_detail: '船舶基本信息',
        'port-restriction': '港口限制船舶识别',
        'area-low-speed-notice': '区域低速活动与公告关联',
      };
      const timeSummary =
        (intent === 'analysis' || intent === 'ais_heatmap') && selection.timeRange
          ? `；时间 ${selection.timeRange.from} 至 ${selection.timeRange.to}`
          : (intent === 'vessel_list' || intent === 'vessel_detail') && selection.filters?.hours
            ? `；最新报告：最近 ${selection.filters.hours} 小时`
            : '';
      const summary = `已确认条件：${selection.purpose ? labels[selection.purpose] : '继续任务'}${selection.bbox ? `；区域 ${selection.bbox.join(', ')}` : ''}${selection.mmsis?.length ? `；船舶 ${selection.mmsis.join(', ')}` : ''}${timeSummary}。`;
      await client.query(
        "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'user',$4)",
        [randomUUID(), task.session_id, taskId, summary],
      );
      await event(client, String(task.session_id), taskId, 'input.answered', {
        requestId,
        inputRevision: revision,
      });
      await event(client, String(task.session_id), taskId, 'task.queued', {
        inputRevision: revision,
      });
    }
    const result = { task: taskRow(updated), request };
    await client.query(
      'INSERT INTO agent_input_responses(owner_id,idempotency_key,request_id,request_hash,response) VALUES($1,$2,$3,$4,$5::jsonb)',
      [ownerId, key, requestId, hash, JSON.stringify(result)],
    );
    return result;
  });
}

export async function retryAgentTask(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
  key: string,
) {
  const hash = createHash('sha256').update(`retry:${taskId}`).digest('hex');
  return transaction(infra, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `agent-message:${ownerId}:${key}`,
    ]);
    const source = await lockTask(client, taskId);
    if (!source || source.owner_id !== ownerId)
      throw new AgentInputError('not_found', 'Task not found');
    if (!(await canWrite(client, ownerId)))
      throw new AgentInputError('forbidden', 'Agent write permission required');
    const existing = (
      await client.query('SELECT * FROM agent_tasks WHERE owner_id=$1 AND idempotency_key=$2', [
        ownerId,
        key,
      ])
    ).rows[0];
    if (existing) {
      if (existing.request_hash !== hash)
        throw new AgentInputError('conflict', 'Idempotency key reused with different request');
      const message = (
        await client.query(
          "SELECT * FROM agent_messages WHERE task_id=$1 AND role='user' ORDER BY created_at,id LIMIT 1",
          [existing.id],
        )
      ).rows[0];
      return { task: taskRow(existing), message: messageRow(message) };
    }
    const legacyWaiting =
      source.status === 'awaiting_input' &&
      !(await pendingRequests(client, String(source.session_id), taskId)).length;
    if (!['failed', 'completed', 'cancelled'].includes(String(source.status)) && !legacyWaiting)
      throw new AgentInputError(
        'conflict',
        'Only a finished or legacy waiting task can start a new attempt',
      );
    const derived = deriveAgentIntent(String(source.goal));
    const selection = canonicalSelection({
      ...(source.bbox ? { bbox: source.bbox as AgentSelection['bbox'] } : {}),
      timeRange: { from: iso(source.from_time), to: iso(source.to_time) },
      ...(derived.purpose ? { purpose: derived.purpose } : {}),
      ...(source.selection as AgentSelection),
    });
    const intent = selection.purpose
      ? derivePurposeIntent(selection.purpose)
      : source.intent === 'unresolved'
        ? derived.intent
        : source.intent;
    const id = randomUUID();
    const task = (
      await client.query(
        `INSERT INTO agent_tasks(id,session_id,owner_id,idempotency_key,request_hash,status,goal,bbox,history_hours,from_time,to_time,definition_id,intent,selection,retry_of_task_id,retry_source_input_revision,retry_source_result_version)
      VALUES($1,$2,$3,$4,$5,'queued',$6,$7::jsonb,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16) RETURNING *`,
        [
          id,
          source.session_id,
          ownerId,
          key,
          hash,
          source.goal,
          JSON.stringify(source.bbox),
          source.history_hours,
          source.from_time,
          source.to_time,
          source.definition_id,
          intent,
          JSON.stringify(selection),
          taskId,
          source.input_revision,
          source.result_version,
        ],
      )
    ).rows[0];
    await client.query(
      `INSERT INTO agent_steps(task_id,input_revision,step_key,name,input,output) SELECT $1,0,step_key,name,input,output FROM agent_steps WHERE task_id=$2 AND input_revision=$3 AND step_key IN ('input_snapshot','input_digest','overview')`,
      [id, taskId, source.input_revision],
    );
    if (
      Number(source.result_version) > 0 &&
      source.result_input_revision === source.input_revision
    ) {
      await client.query(
        `INSERT INTO agent_results(task_id,version,input_revision,kind,results,query_result,intelligence_result,heatmap_result) SELECT $1,1,0,kind,results,CASE WHEN query_result IS NULL THEN NULL ELSE query_result || '{"version":1,"inputRevision":0}'::jsonb END,CASE WHEN intelligence_result IS NULL THEN NULL ELSE intelligence_result || '{"version":1,"inputRevision":0}'::jsonb END,CASE WHEN heatmap_result IS NULL THEN NULL ELSE heatmap_result || '{"version":1,"inputRevision":0}'::jsonb END FROM agent_results WHERE task_id=$2 AND version=$3`,
        [id, taskId, source.result_version],
      );
      await copyIntelligencePins(client, taskId, Number(source.result_version), id, 0);
      task.result_version = 1;
      task.result_input_revision = 0;
      await client.query(
        'UPDATE agent_tasks SET result_version=1,result_input_revision=0 WHERE id=$1',
        [id],
      );
    }
    const message = (
      await client.query(
        "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'user',$4) RETURNING *",
        [randomUUID(), source.session_id, id, `重新尝试：${source.goal}`],
      )
    ).rows[0];
    await event(client, String(source.session_id), id, 'task.created', {
      status: 'queued',
      retryOfTaskId: taskId,
      sourceInputRevision: source.input_revision,
      sourceResultVersion: source.result_version,
    });
    return { task: taskRow(task), message: messageRow(message) };
  });
}

export async function readAgentEvents(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  cursor = '0',
  limit = 100,
) {
  if (
    !(
      await infra.pool.query('SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2', [
        sessionId,
        ownerId,
      ])
    ).rowCount
  )
    return null;
  const rows = (
    await infra.pool.query(
      'SELECT * FROM agent_events WHERE session_id=$1 AND id>$2::bigint ORDER BY id LIMIT $3',
      [sessionId, cursor, limit],
    )
  ).rows;
  const items = rows.map((r): AgentEvent => ({
    id: String(r.id),
    sessionId: r.session_id,
    taskId: r.task_id,
    type: r.type,
    data: r.data,
    createdAt: iso(r.created_at),
  }));
  return { items, nextCursor: items.at(-1)?.id ?? cursor };
}
