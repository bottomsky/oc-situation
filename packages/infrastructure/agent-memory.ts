import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  AgentAccountMemoryMutationSchema,
  AgentMemorySettingsUpdateSchema,
  AgentSessionMemoryResetSchema,
  AgentSessionMemoryWriteSchema,
  type AgentAccountMemoryEntry,
  type AgentAccountMemoryMutation,
  type AgentAccountMemoryState,
  type AgentMemorySettings,
  type AgentMemorySettingsUpdate,
  type AgentMemorySnapshot,
  type AgentSessionMemory,
  type AgentSessionMemoryWrite,
} from '../contracts/agent-memory';
import type { Infrastructure } from './clients';
import { parseMemoryInstruction } from '../domain/agent-memory';
import { selectRelevantAccountMemories } from '../domain/agent-memory-context';

type Row = Record<string, unknown>;
export class AgentMemoryError extends Error {
  constructor(
    public readonly code:
      'NOT_FOUND' | 'CONFLICT' | 'WRITE_DISABLED' | 'STALE_GENERATION' | 'INVALID_OPERATION',
    message: string,
  ) {
    super(message);
    this.name = 'AgentMemoryError';
  }
}
export function agentMemoryFeatures(env: NodeJS.ProcessEnv = process.env) {
  return {
    session: env.AGENT_SESSION_MEMORY_ENABLED !== 'false',
    account: env.AGENT_ACCOUNT_MEMORY_ENABLED !== 'false',
    proposals: env.AGENT_MEMORY_PROPOSALS_ENABLED !== 'false',
  };
}
const iso = (value: unknown) => new Date(value as Date | string).toISOString();
/** Supplying a client joins the caller's transaction; it never starts or commits a nested transaction. */
async function transaction<T>(
  infra: Infrastructure,
  client: PoolClient | undefined,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (client) return work(client);
  const own = await infra.pool.connect();
  try {
    await own.query('BEGIN');
    const result = await work(own);
    await own.query('COMMIT');
    return result;
  } catch (error) {
    await own.query('ROLLBACK');
    throw error;
  } finally {
    own.release();
  }
}
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]),
    );
  return value;
}
const fingerprint = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
async function accountLock(client: PoolClient, ownerId: string): Promise<Row> {
  await client.query(
    'INSERT INTO agent_memory_accounts(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
    [ownerId],
  );
  return (
    await client.query('SELECT * FROM agent_memory_accounts WHERE owner_id=$1 FOR UPDATE', [
      ownerId,
    ])
  ).rows[0]!;
}
function settingsRow(row: Row): AgentMemorySettings {
  return {
    readEnabled: Boolean(row.read_enabled),
    proposalsEnabled: Boolean(row.write_enabled),
    generation: Number(row.generation),
    revision: Number(row.settings_revision),
  };
}
async function replay(
  client: PoolClient,
  ownerId: string,
  operationId: string,
  hash: string,
): Promise<boolean> {
  const row = (
    await client.query(
      'SELECT request_hash FROM agent_memory_operations WHERE owner_id=$1 AND operation_id=$2',
      [ownerId, operationId],
    )
  ).rows[0];
  if (!row) return false;
  if (row.request_hash !== hash)
    throw new AgentMemoryError('CONFLICT', 'Operation ID already belongs to a different request');
  return true;
}
async function audit(
  client: PoolClient,
  ownerId: string,
  operationId: string,
  hash: string,
  action: string,
  resourceId: string | null,
  revision: number,
) {
  await client.query(
    'INSERT INTO agent_memory_operations(owner_id,operation_id,request_hash,action,resource_id,revision) VALUES($1,$2,$3,$4,$5,$6)',
    [ownerId, operationId, hash, action, resourceId, revision],
  );
  await client.query(
    'INSERT INTO agent_memory_audit(owner_id,action,resource_id,revision) VALUES($1,$2,$3,$4)',
    [ownerId, action, resourceId, revision],
  );
}
export async function getAgentMemorySettings(
  infra: Infrastructure,
  ownerId: string,
  client?: PoolClient,
): Promise<AgentMemorySettings> {
  return transaction(infra, client, async (db) => settingsRow(await accountLock(db, ownerId)));
}
export async function updateAgentMemorySettings(
  infra: Infrastructure,
  ownerId: string,
  input: AgentMemorySettingsUpdate,
  client?: PoolClient,
): Promise<AgentMemorySettings> {
  const request = AgentMemorySettingsUpdateSchema.parse(input);
  return transaction(infra, client, async (db) => {
    const row = await accountLock(db, ownerId);
    const hash = fingerprint({ scope: 'settings', ...request });
    if (await replay(db, ownerId, request.operationId, hash)) return settingsRow(row);
    if (Number(row.settings_revision) !== request.expectedRevision)
      throw new AgentMemoryError('CONFLICT', 'Memory settings revision changed');
    const next = (
      await db.query(
        'UPDATE agent_memory_accounts SET read_enabled=$2,write_enabled=$3,settings_revision=settings_revision+1,generation=generation+1 WHERE owner_id=$1 RETURNING *',
        [ownerId, request.readEnabled, request.proposalsEnabled],
      )
    ).rows[0]!;
    // A disabled read cannot reappear from an old task projection after a subsequent re-enable.
    if (!request.readEnabled)
      await db.query(
        "UPDATE agent_task_memory_snapshots SET context=jsonb_set(context,'{account}','[]') WHERE owner_id=$1",
        [ownerId],
      );
    await audit(
      db,
      ownerId,
      request.operationId,
      hash,
      'settings',
      null,
      Number(next.settings_revision),
    );
    return settingsRow(next);
  });
}
function entryRow(row: Row): AgentAccountMemoryEntry {
  return {
    id: String(row.id),
    category: String(row.category),
    key: String(row.memory_key),
    value: row.value as AgentAccountMemoryEntry['value'],
    status: row.status as AgentAccountMemoryEntry['status'],
    source: row.source as AgentAccountMemoryEntry['source'],
    revision: Number(row.revision),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: row.expires_at ? iso(row.expires_at) : null,
  };
}
async function accountState(
  db: PoolClient,
  ownerId: string,
  includeProposed = false,
): Promise<AgentAccountMemoryState> {
  await db.query(
    "UPDATE agent_account_memories SET status='expired',category=NULL,memory_key=NULL,value=NULL,source='{}',updated_at=now() WHERE owner_id=$1 AND status='proposed' AND expires_at<=now()",
    [ownerId],
  );
  const catalog = (
    await db.query('SELECT revision FROM agent_memory_accounts WHERE owner_id=$1', [ownerId])
  ).rows[0];
  const entries = await db.query(
    "SELECT * FROM agent_account_memories WHERE owner_id=$1 AND (status='active' OR ($2 AND status='proposed' AND expires_at>now())) ORDER BY created_at,id",
    [ownerId, includeProposed],
  );
  return { revision: Number(catalog?.revision ?? 0), entries: entries.rows.map(entryRow) };
}
export async function getAgentAccountMemory(
  infra: Infrastructure,
  ownerId: string,
  options: { includeProposed?: boolean } = {},
  client?: PoolClient,
): Promise<AgentAccountMemoryState> {
  return transaction(infra, client, async (db) => {
    await accountLock(db, ownerId);
    return accountState(db, ownerId, options.includeProposed);
  });
}
/** Removes deleted values from frozen projections, retaining only revisions and resource IDs in audit. */
async function scrubAccountSnapshots(db: PoolClient, ownerId: string, entryId?: string) {
  await db.query(
    `INSERT INTO agent_memory_redactions(owner_id,task_id)
    SELECT owner_id,task_id FROM agent_memory_entry_sources WHERE owner_id=$1 AND ($2::uuid IS NULL OR entry_id=$2) AND task_id IS NOT NULL
    ON CONFLICT DO NOTHING`,
    [ownerId, entryId ?? null],
  );
  await db.query(
    `INSERT INTO agent_memory_message_redactions(owner_id,message_id) SELECT owner_id,message_id FROM agent_memory_entry_sources WHERE owner_id=$1 AND ($2::uuid IS NULL OR entry_id=$2) AND message_id IS NOT NULL ON CONFLICT DO NOTHING`,
    [ownerId, entryId ?? null],
  );
  await db.query(
    `UPDATE agent_task_memory_snapshots s SET context=jsonb_set(jsonb_set(context,'{account}',COALESCE((SELECT jsonb_agg(entry) FROM jsonb_array_elements(s.context->'account') entry WHERE $2::text IS NOT NULL AND entry->>'id'<>$2),'[]'::jsonb)),'{recentTurns}',COALESCE((SELECT jsonb_agg(turn) FROM jsonb_array_elements(s.context->'recentTurns') turn WHERE NOT EXISTS(SELECT 1 FROM agent_memory_redactions r WHERE r.owner_id=$1 AND r.task_id::text=turn->>'taskId') AND NOT EXISTS(SELECT 1 FROM agent_memory_message_redactions r WHERE r.owner_id=$1 AND r.message_id::text=turn->>'messageId')),'[]'::jsonb)) WHERE owner_id=$1`,
    [ownerId, entryId ?? null],
  );
  await db.query("UPDATE agent_session_memories SET summary='' WHERE owner_id=$1", [ownerId]);
  await db.query(
    "UPDATE agent_task_memory_snapshots SET context=jsonb_set(context,'{session,summary}','\"\"') WHERE owner_id=$1 AND jsonb_typeof(context->'session')='object'",
    [ownerId],
  );
}
async function rememberSource(
  db: PoolClient,
  ownerId: string,
  entryId: string,
  source: { taskId?: string; messageId?: string } | undefined,
) {
  if (!source?.taskId && !source?.messageId) return;
  const taskId =
    source.taskId ??
    (source.messageId
      ? (await db.query('SELECT task_id FROM agent_messages WHERE id=$1', [source.messageId]))
          .rows[0]?.task_id
      : null);
  await db.query(
    'INSERT INTO agent_memory_entry_sources(owner_id,entry_id,source_key,task_id,message_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
    [ownerId, entryId, fingerprint(source), taskId ?? null, source.messageId ?? null],
  );
}
async function validateSource(
  db: PoolClient,
  ownerId: string,
  source: { taskId?: string; messageId?: string } | undefined,
) {
  if (
    source?.taskId &&
    !(
      await db.query('SELECT id FROM agent_tasks WHERE id=$1 AND owner_id=$2', [
        source.taskId,
        ownerId,
      ])
    ).rowCount
  )
    throw new AgentMemoryError('NOT_FOUND', 'Source task not found');
  if (
    source?.messageId &&
    !(
      await db.query(
        'SELECT m.id FROM agent_messages m JOIN agent_sessions s ON s.id=m.session_id WHERE m.id=$1 AND s.owner_id=$2',
        [source.messageId, ownerId],
      )
    ).rowCount
  )
    throw new AgentMemoryError('NOT_FOUND', 'Source message not found');
}
export async function mutateAgentAccountMemory(
  infra: Infrastructure,
  ownerId: string,
  input: AgentAccountMemoryMutation,
  client?: PoolClient,
): Promise<AgentAccountMemoryState> {
  const request = AgentAccountMemoryMutationSchema.parse(input);
  return transaction(infra, client, async (db) => {
    const row = await accountLock(db, ownerId);
    const hash = fingerprint({ scope: 'account', ...request });
    if (await replay(db, ownerId, request.operationId, hash)) return accountState(db, ownerId);
    if (Number(row.revision) !== request.expectedRevision)
      throw new AgentMemoryError('CONFLICT', 'Account memory revision changed');
    if (
      request.expectedGeneration !== undefined &&
      request.expectedGeneration !== Number(row.generation)
    )
      throw new AgentMemoryError('STALE_GENERATION', 'Memory generation changed');
    const features = agentMemoryFeatures();
    if (['remember', 'propose', 'accept'].includes(request.action) && !features.account)
      throw new AgentMemoryError('WRITE_DISABLED', 'Account memory is disabled');
    if (request.action === 'propose' && (!features.proposals || !row.write_enabled))
      throw new AgentMemoryError('WRITE_DISABLED', 'Automatic memory suggestions are paused');
    // Expired candidate payloads are erased, not merely hidden from reads.
    await db.query(
      "UPDATE agent_account_memories SET status='expired',category=NULL,memory_key=NULL,value=NULL,source='{}',updated_at=now() WHERE owner_id=$1 AND status='proposed' AND expires_at<=now()",
      [ownerId],
    );
    const revision = Number(row.revision) + 1;
    await validateSource(db, ownerId, request.source);
    let entryId = request.entryId ?? null;
    if (request.action === 'remember' || request.action === 'propose') {
      let existing: Row | undefined;
      if (entryId) {
        existing = (
          await db.query(
            "SELECT * FROM agent_account_memories WHERE owner_id=$1 AND id=$2 AND status IN('active','proposed')",
            [ownerId, entryId],
          )
        ).rows[0];
        if (!existing) throw new AgentMemoryError('NOT_FOUND', 'Memory entry not found');
      } else {
        existing = (
          await db.query(
            "SELECT * FROM agent_account_memories WHERE owner_id=$1 AND category=$2 AND memory_key=$3 AND status IN('active','proposed') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1",
            [ownerId, request.category, request.key],
          )
        ).rows[0];
      }
      // Automatic proposals never rewrite an explicitly confirmed fact.
      if (request.action === 'propose' && existing?.status === 'active') {
        await audit(
          db,
          ownerId,
          request.operationId,
          hash,
          'proposal_skipped',
          String(existing.id),
          Number(row.revision),
        );
        return accountState(db, ownerId);
      }
      entryId = existing ? String(existing.id) : randomUUID();
      const status = request.action === 'remember' ? 'active' : 'proposed';
      if (status === 'active') {
        const duplicate = await db.query(
          "SELECT id FROM agent_account_memories WHERE owner_id=$1 AND category=$2 AND memory_key=$3 AND status='active' AND id<>$4",
          [ownerId, request.category, request.key, entryId],
        );
        if (duplicate.rowCount)
          throw new AgentMemoryError('CONFLICT', 'An active memory already uses this key');
        await db.query(
          "UPDATE agent_account_memories SET status='deleted',category=NULL,memory_key=NULL,value=NULL,source='{}',updated_at=now() WHERE owner_id=$1 AND category=$2 AND memory_key=$3 AND status='proposed' AND id<>$4",
          [ownerId, request.category, request.key, entryId],
        );
      }
      await db.query(
        `INSERT INTO agent_account_memories(id,owner_id,category,memory_key,value,source,status,revision,generation,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,CASE WHEN $7='proposed' THEN now()+interval '30 days' END) ON CONFLICT(id) DO UPDATE SET category=excluded.category,memory_key=excluded.memory_key,value=excluded.value,source=excluded.source,status=excluded.status,revision=excluded.revision,generation=excluded.generation,expires_at=excluded.expires_at,updated_at=now()`,
        [
          entryId,
          ownerId,
          request.category,
          request.key,
          JSON.stringify(request.value),
          JSON.stringify(request.source ?? {}),
          status,
          revision,
          row.generation,
        ],
      );
      await rememberSource(
        db,
        ownerId,
        entryId,
        existing?.source as { taskId?: string; messageId?: string } | undefined,
      );
      await rememberSource(db, ownerId, entryId, request.source);
    } else if (request.action === 'clear') {
      await scrubAccountSnapshots(db, ownerId);
      await db.query(
        "UPDATE agent_account_memories SET status='deleted',category=NULL,memory_key=NULL,value=NULL,source='{}',revision=$2,updated_at=now() WHERE owner_id=$1 AND status IN('active','proposed')",
        [ownerId, revision],
      );
    } else {
      const entry = (
        await db.query(
          "SELECT * FROM agent_account_memories WHERE owner_id=$1 AND id=$2 AND status IN('active','proposed')",
          [ownerId, entryId],
        )
      ).rows[0];
      if (!entry) throw new AgentMemoryError('NOT_FOUND', 'Memory entry not found');
      if (request.action === 'accept') {
        if (entry.status !== 'proposed')
          throw new AgentMemoryError('INVALID_OPERATION', 'Only a proposed memory can be accepted');
        const duplicate = await db.query(
          "SELECT id FROM agent_account_memories WHERE owner_id=$1 AND category=$2 AND memory_key=$3 AND status='active'",
          [ownerId, entry.category, entry.memory_key],
        );
        if (duplicate.rowCount)
          throw new AgentMemoryError('CONFLICT', 'An active memory already uses this key');
        await db.query(
          "UPDATE agent_account_memories SET status='active',revision=$3,expires_at=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2",
          [ownerId, entryId, revision],
        );
      } else {
        if (request.action === 'reject' && entry.status !== 'proposed')
          throw new AgentMemoryError('INVALID_OPERATION', 'Only a proposed memory can be rejected');
        await scrubAccountSnapshots(db, ownerId, entryId!);
        await db.query(
          "UPDATE agent_account_memories SET status=$3,category=NULL,memory_key=NULL,value=NULL,source='{}',revision=$4,updated_at=now() WHERE owner_id=$1 AND id=$2",
          [ownerId, entryId, request.action === 'reject' ? 'rejected' : 'deleted', revision],
        );
      }
    }
    const destructive = ['delete', 'reject', 'clear'].includes(request.action);
    await db.query(
      'UPDATE agent_memory_accounts SET revision=$2,generation=generation+$3 WHERE owner_id=$1',
      [ownerId, revision, destructive ? 1 : 0],
    );
    await audit(db, ownerId, request.operationId, hash, request.action, entryId, revision);
    return accountState(db, ownerId);
  });
}
async function sessionScope(
  db: PoolClient,
  ownerId: string,
  sessionId: string,
): Promise<{ session: Row; account: Row } | null> {
  // Matches submit's parent-session lock before any account or child-row/FK lock.
  const owned = await db.query(
    'SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE',
    [sessionId, ownerId],
  );
  if (!owned.rowCount) return null;
  const account = await accountLock(db, ownerId);
  await db.query(
    'INSERT INTO agent_session_memories(session_id,owner_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
    [sessionId, ownerId],
  );
  const session = (
    await db.query(
      'SELECT * FROM agent_session_memories WHERE session_id=$1 AND owner_id=$2 FOR UPDATE',
      [sessionId, ownerId],
    )
  ).rows[0]!;
  return { session, account };
}
async function sessionState(db: PoolClient, row: Row): Promise<AgentSessionMemory> {
  const sets = await db.query(
    `SELECT s.metadata,COALESCE((SELECT jsonb_agg(m.member ORDER BY m.ordinal) FROM agent_memory_object_members m WHERE m.owner_id=s.owner_id AND m.session_id=s.session_id AND m.set_id=s.id),'[]') AS members,(SELECT jsonb_agg(t.target ORDER BY t.ordinal) FROM agent_memory_object_targets t WHERE t.owner_id=s.owner_id AND t.session_id=s.session_id AND t.set_id=s.id) AS targets FROM agent_memory_object_sets s WHERE s.owner_id=$1 AND s.session_id=$2 ORDER BY s.id`,
    [row.owner_id, row.session_id],
  );
  return {
    sessionId: String(row.session_id),
    revision: Number(row.revision),
    turnSeq: Number(row.turn_seq),
    generation: Number(row.generation),
    conditions: row.conditions as AgentSessionMemory['conditions'],
    references: row.refs as AgentSessionMemory['references'],
    summary: String(row.summary),
    objectSets: sets.rows.map((set) => ({
      ...set.metadata,
      members: set.members,
      ...(set.targets ? { targets: set.targets } : {}),
    })),
    updatedAt: iso(row.updated_at),
  };
}
export async function getAgentSessionMemory(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<AgentSessionMemory | null> {
  return transaction(infra, client, async (db) => {
    const row = (await sessionScope(db, ownerId, sessionId))?.session;
    return row ? sessionState(db, row) : null;
  });
}
export async function saveAgentSessionMemory(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  input: AgentSessionMemoryWrite,
  client?: PoolClient,
): Promise<AgentSessionMemory | null> {
  const request = AgentSessionMemoryWriteSchema.parse(input);
  return transaction(infra, client, async (db) => {
    if (!agentMemoryFeatures().session) return null;
    const scope = await sessionScope(db, ownerId, sessionId);
    const row = scope?.session;
    if (
      !row ||
      Number(row.revision) !== request.expectedRevision ||
      request.turnSeq < Math.max(Number(row.turn_seq), Number(row.next_turn_seq)) ||
      (request.expectedGeneration !== undefined &&
        Number(row.generation) !== request.expectedGeneration)
    )
      return null;
    if (request.objectSets) {
      for (const set of request.objectSets) await validateSource(db, ownerId, set.source);
      await db.query('DELETE FROM agent_memory_object_sets WHERE owner_id=$1 AND session_id=$2', [
        ownerId,
        sessionId,
      ]);
      for (const set of request.objectSets) {
        const { members, targets, ...metadata } = set;
        await db.query(
          'INSERT INTO agent_memory_object_sets(owner_id,session_id,id,metadata) VALUES($1,$2,$3,$4::jsonb)',
          [ownerId, sessionId, set.id, JSON.stringify(metadata)],
        );
        // JSON record expansion avoids parameter limits and keeps every member, including large query results.
        await db.query(
          'INSERT INTO agent_memory_object_members(owner_id,session_id,set_id,ordinal,member) SELECT $1,$2,$3,(ordinality-1)::integer,value FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY',
          [ownerId, sessionId, set.id, JSON.stringify(members)],
        );
        if (targets?.length)
          await db.query(
            'INSERT INTO agent_memory_object_targets(owner_id,session_id,set_id,ordinal,target) SELECT $1,$2,$3,(ordinality-1)::integer,value FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY',
            [ownerId, sessionId, set.id, JSON.stringify(targets)],
          );
      }
    }
    const updated = (
      await db.query(
        'UPDATE agent_session_memories SET revision=revision+1,turn_seq=$3,next_turn_seq=GREATEST(next_turn_seq,$3),conditions=COALESCE($4::jsonb,conditions),refs=COALESCE($5::jsonb,refs),summary=COALESCE($6,summary),updated_at=now() WHERE owner_id=$1 AND session_id=$2 RETURNING *',
        [
          ownerId,
          sessionId,
          request.turnSeq,
          request.conditions ? JSON.stringify(request.conditions) : null,
          request.references ? JSON.stringify(request.references) : null,
          request.expectedAccountGeneration !== undefined &&
          request.expectedAccountGeneration !== Number(scope!.account.generation)
            ? null
            : (request.summary ?? null),
        ],
      )
    ).rows[0]!;
    return sessionState(db, updated);
  });
}
export async function resetAgentSessionMemory(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  input: { operationId: string; expectedRevision: number },
  client?: PoolClient,
): Promise<AgentSessionMemory> {
  const request = AgentSessionMemoryResetSchema.parse(input);
  return transaction(infra, client, async (db) => {
    const row = (await sessionScope(db, ownerId, sessionId))?.session;
    if (!row) throw new AgentMemoryError('NOT_FOUND', 'Session not found');
    const hash = fingerprint({ scope: 'session', sessionId, ...request });
    if (await replay(db, ownerId, request.operationId, hash)) return sessionState(db, row);
    if (Number(row.revision) !== request.expectedRevision)
      throw new AgentMemoryError('CONFLICT', 'Session memory revision changed');
    await db.query('DELETE FROM agent_memory_object_sets WHERE owner_id=$1 AND session_id=$2', [
      ownerId,
      sessionId,
    ]);
    const updated = (
      await db.query(
        "UPDATE agent_session_memories SET revision=revision+1,generation=generation+1,conditions='{}',refs='[]',summary='',reset_at=now(),updated_at=now() WHERE owner_id=$1 AND session_id=$2 RETURNING *",
        [ownerId, sessionId],
      )
    ).rows[0]!;
    await db.query(
      "UPDATE agent_task_memory_snapshots SET context=jsonb_set(jsonb_set(context,'{session}','null'),'{recentTurns}','[]') WHERE owner_id=$1 AND session_id=$2",
      [ownerId, sessionId],
    );
    await audit(
      db,
      ownerId,
      request.operationId,
      hash,
      'session_reset',
      sessionId,
      Number(updated.revision),
    );
    return sessionState(db, updated);
  });
}
export async function captureAgentMemoryContext(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  taskId: string,
  inputRevision: number,
  client?: PoolClient,
): Promise<AgentMemorySnapshot> {
  return transaction(infra, client, async (db) => {
    const scope = await sessionScope(db, ownerId, sessionId);
    if (!scope) throw new AgentMemoryError('NOT_FOUND', 'Session not found');
    const { account, session } = scope;
    const task = await db.query(
      'SELECT id,goal FROM agent_tasks WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND input_revision=$4',
      [taskId, ownerId, sessionId, inputRevision],
    );
    if (!session || !task.rowCount)
      throw new AgentMemoryError('NOT_FOUND', 'Task or session not found at this input revision');
    const existing = await db.query(
      'SELECT context FROM agent_task_memory_snapshots WHERE task_id=$1 AND input_revision=$2 AND owner_id=$3',
      [taskId, inputRevision, ownerId],
    );
    if (existing.rowCount) return projectSnapshot(existing.rows[0]!.context, settingsRow(account));
    const turnSeq = Number(
      (
        await db.query(
          'UPDATE agent_session_memories SET next_turn_seq=next_turn_seq+1 WHERE owner_id=$1 AND session_id=$2 RETURNING next_turn_seq',
          [ownerId, sessionId],
        )
      ).rows[0]!.next_turn_seq,
    );
    const settings = settingsRow(account);
    const features = agentMemoryFeatures();
    const taskIds: string[] = [];
    if (features.session) {
      // Page candidate IDs, filtering management rounds before choosing the eight business rounds.
      // This prevents repeated remember/edit commands from displacing conversational context.
      for (let offset = 0; taskIds.length < 8; offset += 64) {
        const page = await db.query(
          'SELECT t.id,t.goal FROM agent_tasks t WHERE t.session_id=$1 AND t.owner_id=$2 AND ($3::timestamptz IS NULL OR t.created_at>=$3) AND NOT EXISTS(SELECT 1 FROM agent_memory_redactions r WHERE r.owner_id=$2 AND r.task_id=t.id) ORDER BY t.created_at DESC,t.id DESC LIMIT 64 OFFSET $4',
          [sessionId, ownerId, session.reset_at, offset],
        );
        for (const candidate of page.rows)
          if (!parseMemoryInstruction(String(candidate.goal)) && taskIds.length < 8)
            taskIds.push(String(candidate.id));
        if (page.rowCount! < 64) break;
      }
    }
    const messages = taskIds.length
      ? await db.query(
          'SELECT role,content,task_id,id FROM(SELECT m.*,row_number() OVER(PARTITION BY task_id,role ORDER BY created_at DESC,id DESC) AS rank FROM agent_messages m WHERE m.task_id=ANY($1::uuid[]) AND NOT EXISTS(SELECT 1 FROM agent_memory_message_redactions r WHERE r.owner_id=$2 AND r.message_id=m.id)) recent WHERE rank=1 ORDER BY created_at,id',
          [taskIds, ownerId],
        )
      : { rows: [] };
    const snapshot: AgentMemorySnapshot = {
      taskId,
      inputRevision,
      turnSeq,
      settingsGeneration: settings.generation,
      accountRevision: Number(account.revision),
      sessionRevision: Number(session.revision),
      sessionGeneration: Number(session.generation),
      settings,
      session: features.session ? await sessionState(db, session) : null,
      account:
        features.account && settings.readEnabled
          ? selectRelevantAccountMemories(
              String(task.rows[0]!.goal),
              (await accountState(db, ownerId)).entries,
            )
          : [],
      recentTurns: messages.rows.map((message) => ({
        messageId: String(message.id),
        role: message.role,
        content: message.content,
        taskId: message.task_id,
      })),
    };
    await db.query(
      'INSERT INTO agent_task_memory_snapshots(owner_id,session_id,task_id,input_revision,context) VALUES($1,$2,$3,$4,$5::jsonb)',
      [ownerId, sessionId, taskId, inputRevision, JSON.stringify(snapshot)],
    );
    return snapshot;
  });
}
function projectSnapshot(
  snapshot: AgentMemorySnapshot,
  settings: AgentMemorySettings,
): AgentMemorySnapshot {
  const features = agentMemoryFeatures();
  return {
    ...snapshot,
    account: features.account && settings.readEnabled ? snapshot.account : [],
    session: features.session ? snapshot.session : null,
    recentTurns: features.session ? snapshot.recentTurns : [],
  };
}
export async function getAgentTaskMemoryContext(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
  inputRevision?: number,
  client?: PoolClient,
): Promise<AgentMemorySnapshot | null> {
  return transaction(infra, client, async (db) => {
    const account = (
      await db.query('SELECT * FROM agent_memory_accounts WHERE owner_id=$1', [ownerId])
    ).rows[0];
    const settings = account
      ? settingsRow(account)
      : { readEnabled: true, proposalsEnabled: true, generation: 0, revision: 0 };
    const snapshot = await db.query(
      'SELECT context FROM agent_task_memory_snapshots WHERE owner_id=$1 AND task_id=$2 AND ($3::integer IS NULL OR input_revision=$3) ORDER BY input_revision DESC LIMIT 1',
      [ownerId, taskId, inputRevision ?? null],
    );
    return snapshot.rowCount ? projectSnapshot(snapshot.rows[0]!.context, settings) : null;
  });
}
export async function getLatestAgentSessionMemoryContext(
  infra: Infrastructure,
  ownerId: string,
  sessionId: string,
  client?: PoolClient,
): Promise<AgentMemorySnapshot | null> {
  return transaction(infra, client, async (db) => {
    const latest = await db.query(
      "SELECT task_id,input_revision FROM agent_task_memory_snapshots WHERE owner_id=$1 AND session_id=$2 ORDER BY (context->>'turnSeq')::integer DESC,input_revision DESC LIMIT 1",
      [ownerId, sessionId],
    );
    if (!latest.rowCount) return null;
    return getAgentTaskMemoryContext(
      infra,
      ownerId,
      String(latest.rows[0]!.task_id),
      Number(latest.rows[0]!.input_revision),
      db,
    );
  });
}
