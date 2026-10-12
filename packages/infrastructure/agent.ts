import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  AgentEvent,
  AgentMessage,
  AgentMessageInput,
  AgentSession,
  AgentStep,
  AgentTask,
} from '../contracts/agent';
import type { AnalysisResult, TopicDefinitionId } from '../contracts/topics';
import { classifyConversationIntent } from '../domain/agent-conversation';
import type { Infrastructure } from './clients';

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
  createdAt: iso(r.created_at),
});
async function transaction<T>(
  infra: Infrastructure,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
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
  const result = await infra.pool.query(
    'INSERT INTO agent_sessions(id,owner_id,title) VALUES($1,$2,$3) RETURNING *',
    [randomUUID(), ownerId, title],
  );
  return sessionRow(result.rows[0]);
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
  const session = (
    await infra.pool.query('SELECT * FROM agent_sessions WHERE id=$1 AND owner_id=$2', [
      sessionId,
      ownerId,
    ])
  ).rows[0];
  if (!session) return null;
  const messages = await infra.pool.query(
    "SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at,CASE role WHEN 'user' THEN 0 ELSE 1 END,id",
    [sessionId],
  );
  const tasks = await infra.pool.query(
    'SELECT * FROM agent_tasks WHERE session_id=$1 ORDER BY created_at,id',
    [sessionId],
  );
  return {
    session: sessionRow(session),
    messages: messages.rows.map(messageRow),
    tasks: tasks.rows.map(taskRow),
  };
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
        await client.query("SELECT * FROM agent_messages WHERE task_id=$1 AND role='user'", [
          previous.id,
        ])
      ).rows[0];
      return { message: messageRow(message), task: taskRow(previous) };
    }
    const id = randomUUID();
    const status =
      input.bbox || classifyConversationIntent(input.content) ? 'queued' : 'awaiting_input';
    const parent =
      (
        await client.query(
          `SELECT e.task_id,t.goal FROM agent_events e JOIN agent_tasks t ON t.id=e.task_id AND t.session_id=e.session_id
          WHERE e.session_id=$1 AND e.type='task.created' ORDER BY e.id DESC`,
          [sessionId],
        )
      ).rows.find((row) => classifyConversationIntent(String(row.goal)) === null)?.task_id ?? null;
    const result = await client.query(
      `INSERT INTO agent_tasks(id,session_id,owner_id,idempotency_key,request_hash,status,goal,bbox,history_hours,from_time,to_time,parent_task_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,now()-make_interval(hours=>$9),now(),$10) RETURNING *`,
      [
        id,
        sessionId,
        ownerId,
        key,
        hash,
        status,
        input.content,
        JSON.stringify(input.bbox ?? null),
        input.historyHours,
        parent,
      ],
    );
    const message = await client.query(
      "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'user',$4) RETURNING *",
      [randomUUID(), sessionId, id, input.content],
    );
    if (status === 'awaiting_input')
      await client.query(
        "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'assistant',$4)",
        [randomUUID(), sessionId, id, '请先在海图中确认分析区域，再发送分析目标。'],
      );
    // Partial results remain resumable; cancelled denotes an explicit user cancellation.
    await event(client, sessionId, id, 'task.created', { status });
    return { message: messageRow(message.rows[0]), task: taskRow(result.rows[0]) };
  });
}
export async function getAgentTaskContext(infra: Infrastructure, taskId: string) {
  const task = (await infra.pool.query('SELECT * FROM agent_tasks WHERE id=$1', [taskId])).rows[0];
  if (!task) return null;
  const [messages, steps, result] = await Promise.all([
    infra.pool.query(
      "SELECT * FROM agent_messages WHERE session_id=$1 ORDER BY created_at,CASE role WHEN 'user' THEN 0 ELSE 1 END,id",
      [task.session_id],
    ),
    infra.pool.query('SELECT * FROM agent_steps WHERE task_id=$1 ORDER BY created_at,step_key', [
      taskId,
    ]),
    infra.pool.query('SELECT results FROM agent_results WHERE task_id=$1 AND version=$2', [
      taskId,
      task.result_version,
    ]),
  ]);
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
  };
}
export async function getOwnedAgentTask(infra: Infrastructure, ownerId: string, taskId: string) {
  if (
    !(
      await infra.pool.query('SELECT id FROM agent_tasks WHERE id=$1 AND owner_id=$2', [
        taskId,
        ownerId,
      ])
    ).rowCount
  )
    return null;
  return getAgentTaskContext(infra, taskId);
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
    if (!previous || !previous.result_version) return null;
    if (Number(current.result_version) > 0) return taskRow(current);
    await client.query(
      'INSERT INTO agent_results(task_id,version,results) SELECT $1,1,results FROM agent_results WHERE task_id=$2 AND version=$3',
      [taskId, previousTaskId, previous.result_version],
    );
    await client.query(
      `INSERT INTO agent_steps(task_id,step_key,name,input,output)
      SELECT $1,step_key,name,input,output FROM agent_steps WHERE task_id=$2 AND step_key IN ('overview','input_snapshot','input_digest') ON CONFLICT DO NOTHING`,
      [taskId, previousTaskId],
    );
    const updated = await client.query(
      'UPDATE agent_tasks SET bbox=$2::jsonb,history_hours=$3,from_time=$4,to_time=$5,definition_id=$6,result_version=1,updated_at=now() WHERE id=$1 RETURNING *',
      [
        taskId,
        JSON.stringify(previous.bbox),
        previous.history_hours,
        previous.from_time,
        previous.to_time,
        previous.definition_id,
      ],
    );
    await event(client, String(current.session_id), taskId, 'results.reused', {
      previousTaskId,
      previousResultVersion: previous.result_version,
      version: 1,
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
      `INSERT INTO agent_steps(task_id,step_key,name,input,output) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
      ${
        step.key === 'clock_snapshot'
          ? 'ON CONFLICT (task_id,step_key) DO UPDATE SET name=EXCLUDED.name,input=EXCLUDED.input,output=EXCLUDED.output,created_at=now()'
          : 'ON CONFLICT DO NOTHING'
      }`,
      [
        taskId,
        step.key,
        step.name,
        JSON.stringify(step.input ?? null),
        JSON.stringify(step.output ?? null),
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
    if (Number(row.result_version) > 0) return Number(row.result_version);
    await client.query(
      'INSERT INTO agent_results(task_id,version,results) VALUES($1,1,$2::jsonb)',
      [taskId, JSON.stringify(results)],
    );
    await client.query('UPDATE agent_tasks SET result_version=1,updated_at=now() WHERE id=$1', [
      taskId,
    ]);
    await event(client, String(row.session_id), taskId, 'results.saved', {
      version: 1,
      count: results.length,
    });
    return 1;
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
  },
): Promise<boolean> {
  return transaction(infra, async (client) => {
    const row = await fenced(client, taskId, workerId, generation);
    if (
      !row ||
      (outcome.summaryResultVersion !== undefined &&
        outcome.summaryResultVersion !== Number(row.result_version))
    )
      return false;
    await client.query(
      'UPDATE agent_tasks SET status=$2,summary=$3,error=$4,summary_result_version=$5,lease_until=NULL,worker_id=NULL,updated_at=now() WHERE id=$1',
      [
        taskId,
        outcome.status,
        outcome.summary ?? null,
        outcome.error ?? null,
        outcome.summary ? (outcome.summaryResultVersion ?? Number(row.result_version)) : null,
      ],
    );
    if (outcome.summary)
      await client.query(
        "INSERT INTO agent_messages(id,session_id,task_id,role,content) VALUES($1,$2,$3,'assistant',$4)",
        [randomUUID(), row.session_id, taskId, outcome.summary],
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
    const updated = await client.query(
      "UPDATE agent_tasks SET status='cancelled',generation=generation+1,worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1 RETURNING *",
      [taskId],
    );
    await event(client, String(row.session_id), taskId, 'task.cancelled');
    return taskRow(updated.rows[0]);
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
