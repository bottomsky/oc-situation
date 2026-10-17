import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  AgentSkillFenceSchema,
  DynamicSkillMutationSchema,
  PublishDynamicSkillSchema,
  SetDynamicSkillEnabledSchema,
  RevokeDynamicSkillVersionSchema,
  type AgentSkillFence,
  type DynamicSkillArtifact,
  type DynamicSkillArtifactKind,
  type DynamicSkillCall,
  type DynamicSkillCatalog,
  type DynamicSkillDefinition,
  type DynamicSkillErrorCode,
  type DynamicSkillExecution,
  type DynamicSkillRef,
  type DynamicSkillSummary,
  type DynamicSkillToolDescriptor,
  type DynamicSkillVersion,
  type PublishDynamicSkill,
  type TaskDynamicSkillBinding,
} from '../contracts/dynamic-skills';
import { validateDynamicSkillDefinition } from '../domain/dynamic-skills';
import { AgentIntelligenceResultSchema } from '../contracts/intelligence-search';
import { canWrite, event, fenced, transaction, pinIntelligence } from './agent';
import type { Infrastructure } from './clients';

type Row = Record<string, unknown>;
type Json = z.infer<ReturnType<typeof z.json>>;
export const DYNAMIC_SKILL_ADAPTER_VERSION = 'declarative-v1';
/** Shared admission ceiling; implementations and argument schemas remain in the host registry. */
export const DYNAMIC_SKILL_HOST_TOOLS: readonly DynamicSkillToolDescriptor[] = Object.freeze([
  {
    id: 'prepare_vessel_highlights',
    artifactKinds: ['vessel_highlights'],
    allowedPhases: ['skill'],
  },
  { id: 'prepare_map_camera', artifactKinds: ['map_camera'], allowedPhases: ['skill'] },
  {
    id: 'query_vessels',
    artifactKinds: ['vessel_list', 'vessel_detail'],
    allowedPhases: ['skill'],
  },
  { id: 'query_ais_heatmap', artifactKinds: ['ais_heatmap'], allowedPhases: ['skill'] },
  { id: 'query_vessel_tracks', artifactKinds: ['vessel_tracks'], allowedPhases: ['skill'] },
  { id: 'search_intelligence', artifactKinds: ['intelligence_search'], allowedPhases: ['skill'] },
]);
export class DynamicSkillError extends Error {
  constructor(
    readonly code: DynamicSkillErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}
const reject = (code: DynamicSkillErrorCode, message?: string): never => {
  throw new DynamicSkillError(code, message);
};
const isEnabled = () => process.env.AGENT_DYNAMIC_SKILLS_ENABLED === 'true';
function assertEnabled() {
  if (!isEnabled()) reject('forbidden', '动态技能执行尚未启用');
}
const iso = (value: unknown) => new Date(value as string | Date).toISOString();
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function parseJson(value: unknown): Json {
  const parsed = z.json().parse(value);
  if (Buffer.byteLength(JSON.stringify(parsed)) > 16_777_216)
    reject('invalid_input', '执行结果超过持久化上限');
  return parsed;
}
const bindingView = (row: Row) => ({
  skillId: String(row.skill_id),
  version: String(row.version),
  contentHash: String(row.content_hash),
  adapterVersion: String(row.adapter_version),
});
function versionView(row: Row): DynamicSkillVersion {
  return {
    ownerId: String(row.owner_id),
    binding: bindingView(row),
    definition: row.definition as DynamicSkillDefinition,
    source: row.source as DynamicSkillVersion['source'],
    createdAt: iso(row.created_at),
    revokedAt: row.revoked_at ? iso(row.revoked_at) : null,
  };
}
function summaryView(row: Row): DynamicSkillSummary {
  const definition = row.definition as DynamicSkillDefinition | undefined;
  return {
    skillId: String(row.skill_id),
    name: String(row.name),
    description: String(row.description),
    toolIds: definition?.toolIds ?? [],
    enabled: Boolean(row.enabled),
    currentVersion: row.current_version ? String(row.current_version) : null,
    source: row.source as DynamicSkillSummary['source'],
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function taskBindingView(row: Row): TaskDynamicSkillBinding {
  return {
    ownerId: String(row.owner_id),
    taskId: String(row.task_id),
    inputRevision: Number(row.input_revision),
    binding: bindingView(row),
    toolCeiling: row.tool_ceiling as string[],
    boundAt: iso(row.created_at),
  };
}
function callView(row: Row): DynamicSkillCall {
  return {
    callId: String(row.call_id),
    taskId: String(row.task_id),
    inputRevision: Number(row.input_revision),
    stepId: String(row.step_id),
    toolId: String(row.tool_id),
    generation: Number(row.generation),
    status: row.status as DynamicSkillCall['status'],
    input: row.input as Json,
    localResult: (row.local_result ?? null) as Json,
    modelProjection: (row.model_projection ?? null) as Json,
    artifactRefs: (row.artifact_refs ?? []) as string[],
    errorCode: row.error_code ? String(row.error_code) : null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}
function artifactView(row: Row): DynamicSkillArtifact {
  return {
    id: String(row.id),
    ownerId: String(row.owner_id),
    taskId: String(row.task_id),
    inputRevision: Number(row.input_revision),
    stepId: String(row.step_id),
    kind: row.kind as DynamicSkillArtifactKind,
    payload: row.payload as Json,
    modelProjection: row.model_projection as Json,
    createdAt: iso(row.created_at),
  };
}
async function revision(client: PoolClient, ownerId: string) {
  return Number(
    (
      await client.query('SELECT revision FROM agent_dynamic_skill_catalogs WHERE owner_id=$1', [
        ownerId,
      ])
    ).rows[0]?.revision ?? 0,
  );
}
const summarySql = `SELECT s.*,v.definition FROM agent_dynamic_skills s JOIN agent_dynamic_skill_versions v ON v.owner_id=s.owner_id AND v.skill_id=s.skill_id AND v.version=s.current_version`;
export async function listOwnedSkills(
  infra: Infrastructure,
  ownerId: string,
): Promise<DynamicSkillCatalog> {
  return transaction(
    infra,
    async (client) => ({
      catalogRevision: await revision(client, ownerId),
      items: (
        await client.query(
          `${summarySql} WHERE s.owner_id=$1 ORDER BY s.updated_at DESC,s.skill_id`,
          [ownerId],
        )
      ).rows.map(summaryView),
    }),
    true,
  );
}
export async function getOwnedSkill(infra: Infrastructure, ownerId: string, skillId: string) {
  return transaction(
    infra,
    async (client) => {
      const row = (
        await client.query(`${summarySql} WHERE s.owner_id=$1 AND s.skill_id=$2`, [
          ownerId,
          skillId,
        ])
      ).rows[0];
      if (!row) return null;
      return {
        catalogRevision: await revision(client, ownerId),
        skill: summaryView(row),
        versions: (
          await client.query(
            'SELECT * FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND skill_id=$2 ORDER BY created_at DESC,version',
            [ownerId, skillId],
          )
        ).rows.map(versionView),
      };
    },
    true,
  );
}
export async function getOwnedSkillVersion(
  infra: Infrastructure,
  ownerId: string,
  skillId: string,
  version: string,
) {
  const row = (
    await infra.pool.query(
      'SELECT * FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND skill_id=$2 AND version=$3',
      [ownerId, skillId, version],
    )
  ).rows[0];
  return row ? versionView(row) : null;
}
async function executionFence(client: PoolClient, input: AgentSkillFence): Promise<Row> {
  const fence = AgentSkillFenceSchema.parse(input);
  const task = await fenced(client, fence.taskId, fence.workerId, fence.generation);
  if (
    !task ||
    task.owner_id !== fence.ownerId ||
    Number(task.input_revision) !== fence.inputRevision
  )
    return reject('fenced', '任务执行租约或输入版本已改变');
  return task;
}
async function currentSkill(client: PoolClient, ownerId: string, skillId: string) {
  const row = (
    await client.query(`${summarySql} WHERE s.owner_id=$1 AND s.skill_id=$2`, [ownerId, skillId])
  ).rows[0];
  return row ? summaryView(row) : reject('not_found', '技能不存在');
}
async function checkVersion(client: PoolClient, ownerId: string, skillId: string, version: string) {
  const row = (
    await client.query(
      `SELECT v.*,s.enabled FROM agent_dynamic_skill_versions v JOIN agent_dynamic_skills s ON s.owner_id=v.owner_id AND s.skill_id=v.skill_id WHERE v.owner_id=$1 AND v.skill_id=$2 AND v.version=$3 FOR SHARE OF s,v`,
      [ownerId, skillId, version],
    )
  ).rows[0];
  if (!row) return reject('not_found', '技能版本不存在');
  if (!row.enabled) return reject('skill_disabled', '技能已停用');
  if (row.revoked_at) return reject('skill_revoked', '技能版本已撤销');
  if (row.adapter_version !== DYNAMIC_SKILL_ADAPTER_VERSION)
    return reject('skill_changed', '技能执行器版本不兼容');
  const definition = row.definition as DynamicSkillDefinition;
  if (
    hash({
      definition,
      version: String(row.version),
      adapterVersion: String(row.adapter_version),
    }) !== row.content_hash
  )
    return reject('skill_changed', '技能完整内容校验失败');
  return row;
}
export async function validateOwnedDynamicSkillRef(
  client: PoolClient,
  ownerId: string,
  ref: DynamicSkillRef,
) {
  assertEnabled();
  if (!ref.version) return reject('invalid_input', '请选择确切技能版本');
  return versionView(await checkVersion(client, ownerId, ref.skillId, ref.version));
}

async function bindInTransaction(
  client: PoolClient,
  fence: AgentSkillFence,
  ref: DynamicSkillRef,
  toolCeiling: readonly string[],
) {
  const old = (
    await client.query(
      'SELECT * FROM agent_task_skill_bindings WHERE task_id=$1 AND input_revision=$2',
      [fence.taskId, fence.inputRevision],
    )
  ).rows[0];
  if (old) {
    if (old.skill_id !== ref.skillId || (ref.version && old.version !== ref.version))
      return reject('conflict', '当前任务已绑定其他技能版本');
    await checkVersion(client, fence.ownerId, String(old.skill_id), String(old.version));
    return taskBindingView(old);
  }
  const head = await currentSkill(client, fence.ownerId, ref.skillId);
  const version = await checkVersion(
    client,
    fence.ownerId,
    ref.skillId,
    ref.version ?? head.currentVersion!,
  );
  const definition = version.definition as DynamicSkillDefinition;
  if (definition.toolIds.some((id) => !toolCeiling.includes(id)))
    return reject('forbidden', '技能工具超出任务授权上限');
  const row = (
    await client.query(
      'INSERT INTO agent_task_skill_bindings(task_id,owner_id,input_revision,skill_id,version,content_hash,adapter_version,tool_ceiling) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [
        fence.taskId,
        fence.ownerId,
        fence.inputRevision,
        ref.skillId,
        version.version,
        version.content_hash,
        version.adapter_version,
        [...new Set(toolCeiling)].sort(),
      ],
    )
  ).rows[0];
  return taskBindingView(row);
}
type MutationInput = { operationId: string; expectedCatalogRevision: number };
type PublishOptions = {
  fence?: AgentSkillFence;
  toolCatalog?: readonly DynamicSkillToolDescriptor[];
  toolCeiling?: readonly string[];
};
async function mutate<T>(
  infra: Infrastructure,
  ownerId: string,
  action: string,
  input: MutationInput,
  request: unknown,
  work: (client: PoolClient) => Promise<T>,
  fence?: AgentSkillFence,
): Promise<T & { catalogRevision: number }> {
  assertEnabled();
  try {
    return await transaction(infra, async (client) => {
      if (fence) {
        if (fence.ownerId !== ownerId) reject('forbidden');
        await executionFence(client, fence);
      }
      if (!(await canWrite(client, ownerId))) reject('forbidden', '需要当前账号写入权限');
      await client.query(
        'INSERT INTO agent_dynamic_skill_catalogs(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
        [ownerId],
      );
      const row = (
        await client.query(
          'SELECT revision FROM agent_dynamic_skill_catalogs WHERE owner_id=$1 FOR UPDATE',
          [ownerId],
        )
      ).rows[0];
      const requestHash = hash({
        action,
        request,
        ...(fence ? { taskId: fence.taskId, inputRevision: fence.inputRevision } : {}),
      });
      const old = (
        await client.query(
          'SELECT request_hash,response FROM agent_dynamic_skill_operations WHERE owner_id=$1 AND operation_id=$2',
          [ownerId, input.operationId],
        )
      ).rows[0];
      if (old) {
        if (old.request_hash !== requestHash) reject('conflict', '幂等键已用于不同请求');
        return old.response as T & { catalogRevision: number };
      }
      if (Number(row.revision) !== input.expectedCatalogRevision)
        reject('conflict', '技能目录版本已改变，请重新加载');
      const value = await work(client);
      const catalogRevision = Number(row.revision) + 1;
      const response = { ...value, catalogRevision };
      await client.query('UPDATE agent_dynamic_skill_catalogs SET revision=$2 WHERE owner_id=$1', [
        ownerId,
        catalogRevision,
      ]);
      await client.query(
        'INSERT INTO agent_dynamic_skill_operations(owner_id,operation_id,request_hash,response) VALUES($1,$2,$3,$4::jsonb)',
        [ownerId, input.operationId, requestHash, JSON.stringify(response)],
      );
      await client.query(
        "INSERT INTO audit(id,user_id,action,resource_type,resource_id,details) VALUES($1,$2,$3,'dynamic_skill',$4,$5::jsonb)",
        [
          randomUUID(),
          ownerId,
          action,
          (value as { skill?: DynamicSkillSummary }).skill?.skillId ?? null,
          JSON.stringify({
            operationId: input.operationId,
            catalogRevision,
            ...(fence ? { taskId: fence.taskId, inputRevision: fence.inputRevision } : {}),
          }),
        ],
      );
      return response;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      return reject('conflict', '技能名称或操作已存在');
    throw error;
  }
}
export async function publishOwnedSkill(
  infra: Infrastructure,
  ownerId: string,
  input: PublishDynamicSkill,
  options: PublishOptions = {},
) {
  assertEnabled();
  const parsed = PublishDynamicSkillSchema.parse(input);
  let definition: DynamicSkillDefinition;
  try {
    definition = validateDynamicSkillDefinition(
      parsed.definition,
      options.toolCatalog ?? DYNAMIC_SKILL_HOST_TOOLS,
    );
  } catch {
    return reject('invalid_input', '技能声明、引用或工具校验失败');
  }
  return mutate(
    infra,
    ownerId,
    'skill.publish',
    parsed,
    parsed,
    async (client) => {
      const skillId = parsed.skillId ?? `dynamic.${randomUUID()}`;
      if (parsed.skillId) await currentSkill(client, ownerId, skillId);
      const version = randomUUID();
      const adapterVersion = DYNAMIC_SKILL_ADAPTER_VERSION;
      const contentHash = hash({ definition, version, adapterVersion });
      const source = options.fence ? 'agent' : 'user';
      if (!parsed.skillId)
        await client.query(
          'INSERT INTO agent_dynamic_skills(owner_id,skill_id,name,description,enabled,current_version,source) VALUES($1,$2,$3,$4,true,$5,$6)',
          [ownerId, skillId, definition.name, definition.description, version, source],
        );
      await client.query(
        'INSERT INTO agent_dynamic_skill_versions(owner_id,skill_id,version,content_hash,adapter_version,definition,source,created_by_task_id) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',
        [
          ownerId,
          skillId,
          version,
          contentHash,
          adapterVersion,
          JSON.stringify(definition),
          source,
          options.fence?.taskId ?? null,
        ],
      );
      await client.query(
        'UPDATE agent_dynamic_skills SET name=$3,description=$4,current_version=$5,enabled=true,updated_at=now() WHERE owner_id=$1 AND skill_id=$2',
        [ownerId, skillId, definition.name, definition.description, version],
      );
      const versionRow = (
        await client.query(
          'SELECT * FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND skill_id=$2 AND version=$3',
          [ownerId, skillId, version],
        )
      ).rows[0];
      const taskBinding = options.fence
        ? await bindInTransaction(
            client,
            options.fence,
            { skillId, version },
            options.toolCeiling ?? [],
          )
        : undefined;
      if (options.fence) {
        const task = (
          await client.query('SELECT session_id FROM agent_tasks WHERE id=$1', [
            options.fence.taskId,
          ])
        ).rows[0];
        await event(client, String(task.session_id), options.fence.taskId, 'skill.published', {
          binding: { skillId, version, contentHash, adapterVersion },
          inputRevision: options.fence.inputRevision,
        });
      }
      return {
        skill: await currentSkill(client, ownerId, skillId),
        version: versionView(versionRow),
        ...(taskBinding ? { taskBinding } : {}),
      };
    },
    options.fence,
  );
}
export async function setOwnedSkillEnabled(
  infra: Infrastructure,
  ownerId: string,
  skillId: string,
  input: z.infer<typeof SetDynamicSkillEnabledSchema>,
) {
  const parsed = SetDynamicSkillEnabledSchema.parse(input);
  return mutate(infra, ownerId, 'skill.state', parsed, { skillId, ...parsed }, async (client) => {
    await currentSkill(client, ownerId, skillId);
    await client.query(
      'UPDATE agent_dynamic_skills SET enabled=$3,updated_at=now() WHERE owner_id=$1 AND skill_id=$2',
      [ownerId, skillId, parsed.enabled],
    );
    return { skill: await currentSkill(client, ownerId, skillId) };
  });
}
export async function activateOwnedSkillVersion(
  infra: Infrastructure,
  ownerId: string,
  skillId: string,
  version: string,
  input: MutationInput,
) {
  const parsed = DynamicSkillMutationSchema.parse(input);
  return mutate(
    infra,
    ownerId,
    'skill.activate',
    parsed,
    { skillId, version, ...parsed },
    async (client) => {
      const row = (
        await client.query(
          'SELECT revoked_at,definition FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND skill_id=$2 AND version=$3',
          [ownerId, skillId, version],
        )
      ).rows[0];
      if (!row) reject('not_found');
      if (row.revoked_at) reject('skill_revoked');
      await client.query(
        'UPDATE agent_dynamic_skills SET current_version=$3,name=$4,description=$5,updated_at=now() WHERE owner_id=$1 AND skill_id=$2',
        [
          ownerId,
          skillId,
          version,
          (row.definition as DynamicSkillDefinition).name,
          (row.definition as DynamicSkillDefinition).description,
        ],
      );
      return { skill: await currentSkill(client, ownerId, skillId) };
    },
  );
}
export async function revokeOwnedSkillVersion(
  infra: Infrastructure,
  ownerId: string,
  skillId: string,
  version: string,
  input: z.infer<typeof RevokeDynamicSkillVersionSchema>,
) {
  const parsed = RevokeDynamicSkillVersionSchema.parse(input);
  return mutate(
    infra,
    ownerId,
    'skill.revoke',
    parsed,
    { skillId, version, ...parsed },
    async (client) => {
      const result = await client.query(
        'UPDATE agent_dynamic_skill_versions SET revoked_at=coalesce(revoked_at,now()) WHERE owner_id=$1 AND skill_id=$2 AND version=$3 RETURNING version',
        [ownerId, skillId, version],
      );
      if (!result.rowCount) reject('not_found');
      return { skill: await currentSkill(client, ownerId, skillId) };
    },
  );
}

/** Reused by task snapshots so history remains readable while execution is disabled. */
export async function readDynamicSkillExecution(
  client: PoolClient,
  ownerId: string,
  taskId: string,
  inputRevision: number,
): Promise<DynamicSkillExecution> {
  const bound = (
    await client.query(
      'SELECT * FROM agent_task_skill_bindings WHERE task_id=$1 AND owner_id=$2 AND input_revision=$3',
      [taskId, ownerId, inputRevision],
    )
  ).rows[0];
  const version = bound
    ? (
        await client.query(
          'SELECT * FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND skill_id=$2 AND version=$3',
          [ownerId, bound.skill_id, bound.version],
        )
      ).rows[0]
    : null;
  return {
    taskBinding: bound ? taskBindingView(bound) : null,
    version: version ? versionView(version) : null,
    calls: (
      await client.query(
        'SELECT * FROM agent_skill_calls WHERE task_id=$1 AND owner_id=$2 AND input_revision=$3 ORDER BY created_at,step_id',
        [taskId, ownerId, inputRevision],
      )
    ).rows.map(callView),
    artifacts: (
      await client.query(
        'SELECT * FROM agent_skill_artifacts WHERE task_id=$1 AND owner_id=$2 AND input_revision=$3 ORDER BY created_at,id',
        [taskId, ownerId, inputRevision],
      )
    ).rows.map(artifactView),
    createdVersions: (
      await client.query(
        'SELECT * FROM agent_dynamic_skill_versions WHERE owner_id=$1 AND created_by_task_id=$2 ORDER BY created_at,version',
        [ownerId, taskId],
      )
    ).rows.map(versionView),
  };
}
export async function getDynamicSkillExecution(
  infra: Infrastructure,
  ownerId: string,
  taskId: string,
  inputRevision?: number,
) {
  return transaction(
    infra,
    async (client) => {
      const task = (
        await client.query('SELECT input_revision FROM agent_tasks WHERE id=$1 AND owner_id=$2', [
          taskId,
          ownerId,
        ])
      ).rows[0];
      if (!task) return null;
      return readDynamicSkillExecution(
        client,
        ownerId,
        taskId,
        inputRevision ?? Number(task.input_revision),
      );
    },
    true,
  );
}
export async function bindTaskDynamicSkill(
  infra: Infrastructure,
  fence: AgentSkillFence,
  ref: DynamicSkillRef,
  toolCeiling: readonly string[],
): Promise<DynamicSkillExecution> {
  assertEnabled();
  return transaction(infra, async (client) => {
    const task = await executionFence(client, fence);
    await bindInTransaction(client, fence, ref, toolCeiling);
    await event(client, String(task.session_id), fence.taskId, 'skill.bound', {
      skillId: ref.skillId,
      inputRevision: fence.inputRevision,
    });
    return readDynamicSkillExecution(client, fence.ownerId, fence.taskId, fence.inputRevision);
  });
}
async function activeBinding(client: PoolClient, fence: AgentSkillFence, toolId?: string) {
  assertEnabled();
  await executionFence(client, fence);
  const bound = (
    await client.query(
      'SELECT * FROM agent_task_skill_bindings WHERE task_id=$1 AND owner_id=$2 AND input_revision=$3',
      [fence.taskId, fence.ownerId, fence.inputRevision],
    )
  ).rows[0];
  if (!bound) return reject('not_found', '任务尚未绑定技能');
  const version = await checkVersion(
    client,
    fence.ownerId,
    String(bound.skill_id),
    String(bound.version),
  );
  const definition = version.definition as DynamicSkillDefinition;
  if (
    bound.content_hash !== version.content_hash ||
    bound.adapter_version !== version.adapter_version
  )
    reject('skill_changed');
  if (
    toolId &&
    (!(bound.tool_ceiling as string[]).includes(toolId) || !definition.toolIds.includes(toolId))
  )
    reject('forbidden', '工具超出固定授权');
  return { bound, definition };
}
export async function assertTaskDynamicSkillActive(
  infra: Infrastructure,
  fence: AgentSkillFence,
  toolId?: string,
): Promise<boolean> {
  if (!isEnabled()) return false;
  try {
    await transaction(infra, (client) => activeBinding(client, fence, toolId));
    return true;
  } catch (error) {
    if (error instanceof DynamicSkillError) return false;
    throw error;
  }
}
export async function beginDynamicSkillCall(
  infra: Infrastructure,
  fence: AgentSkillFence,
  input: {
    stepId: string;
    toolId: string;
    input: unknown;
    maxToolCalls: number;
    recoverableRead?: boolean;
  },
): Promise<DynamicSkillCall> {
  return transaction(infra, async (client) => {
    const { definition } = await activeBinding(client, fence, input.toolId);
    const step = definition.steps.find(
      (item) => item.id === input.stepId && item.toolId === input.toolId,
    );
    if (!step) return reject('invalid_input', '调用与技能声明步骤不符');
    const payload = parseJson(input.input);
    const inputHash = hash(payload);
    const old = (
      await client.query(
        'SELECT * FROM agent_skill_calls WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 FOR UPDATE',
        [fence.taskId, fence.inputRevision, input.stepId],
      )
    ).rows[0];
    if (old) {
      if (old.tool_id !== input.toolId || old.input_hash !== inputHash)
        return reject('conflict', '稳定调用身份对应不同输入');
      if (old.status === 'running' && Number(old.generation) !== fence.generation) {
        const status = input.recoverableRead ? 'running' : 'unknown';
        const updated = (
          await client.query(
            'UPDATE agent_skill_calls SET status=$4,generation=$5,error_code=$6,updated_at=now() WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 RETURNING *',
            [
              fence.taskId,
              fence.inputRevision,
              input.stepId,
              status,
              fence.generation,
              input.recoverableRead ? null : 'call_outcome_unknown',
            ],
          )
        ).rows[0];
        return callView(updated);
      }
      return callView(old);
    }
    const priorSteps = definition.steps
      .slice(
        0,
        definition.steps.findIndex((item) => item.id === input.stepId),
      )
      .map((item) => item.id);
    if (priorSteps.length) {
      const completed = await client.query(
        "SELECT step_id FROM agent_skill_calls WHERE task_id=$1 AND input_revision=$2 AND step_id=ANY($3::text[]) AND status='completed'",
        [fence.taskId, fence.inputRevision, priorSteps],
      );
      if (completed.rows.length !== priorSteps.length)
        return reject('conflict', '先前步骤尚未完成或展示回执未确认');
    }
    const budget = await client.query(
      'UPDATE agent_tasks SET tool_calls=tool_calls+1,updated_at=now() WHERE id=$1 AND tool_calls<$2',
      [fence.taskId, input.maxToolCalls],
    );
    if (!budget.rowCount) return reject('budget', '工具调用预算已用尽');
    const row = (
      await client.query(
        `INSERT INTO agent_skill_calls(call_id,task_id,owner_id,input_revision,step_id,tool_id,generation,input_hash,input,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'running') RETURNING *`,
        [
          randomUUID(),
          fence.taskId,
          fence.ownerId,
          fence.inputRevision,
          input.stepId,
          input.toolId,
          fence.generation,
          inputHash,
          JSON.stringify(payload),
        ],
      )
    ).rows[0];
    return callView(row);
  });
}
export async function completeDynamicSkillCall(
  infra: Infrastructure,
  fence: AgentSkillFence,
  input: {
    stepId: string;
    localResult: unknown;
    modelProjection: unknown;
    artifact?: { kind: DynamicSkillArtifactKind; payload: unknown; modelProjection: unknown };
  },
): Promise<DynamicSkillCall> {
  return transaction(infra, async (client) => {
    const { definition } = await activeBinding(client, fence);
    const step = definition.steps.find((item) => item.id === input.stepId);
    if (!step || step.artifactKind !== input.artifact?.kind)
      return reject('invalid_input', '步骤产物与声明不符');
    await activeBinding(client, fence, step.toolId);
    const call = (
      await client.query(
        'SELECT * FROM agent_skill_calls WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 FOR UPDATE',
        [fence.taskId, fence.inputRevision, input.stepId],
      )
    ).rows[0];
    if (!call) return reject('not_found');
    const local = parseJson(input.localResult);
    const projection = parseJson(input.modelProjection);
    if (['completed', 'waiting_ui'].includes(String(call.status))) {
      if (
        hash(call.local_result) !== hash(local) ||
        hash(call.model_projection) !== hash(projection)
      )
        return reject('conflict', '已完成调用结果不可改写');
      return callView(call);
    }
    if (call.status !== 'running' || Number(call.generation) !== fence.generation)
      return reject('fenced');
    const refs: string[] = [];
    if (input.artifact) {
      if (input.artifact.kind === 'intelligence_search')
        await pinIntelligence(
          client,
          fence.taskId,
          fence.inputRevision,
          AgentIntelligenceResultSchema.parse(input.artifact.payload),
        );
      const id = randomUUID();
      await client.query(
        'INSERT INTO agent_skill_artifacts(id,task_id,owner_id,input_revision,step_id,kind,payload,model_projection) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)',
        [
          id,
          fence.taskId,
          fence.ownerId,
          fence.inputRevision,
          input.stepId,
          input.artifact.kind,
          JSON.stringify(parseJson(input.artifact.payload)),
          JSON.stringify(parseJson(input.artifact.modelProjection)),
        ],
      );
      refs.push(id);
    }
    const row = (
      await client.query(
        'UPDATE agent_skill_calls SET status=$4,local_result=$5::jsonb,model_projection=$6::jsonb,artifact_refs=$7::jsonb,updated_at=now() WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 RETURNING *',
        [
          fence.taskId,
          fence.inputRevision,
          input.stepId,
          step.ui ? 'waiting_ui' : 'completed',
          JSON.stringify(local),
          JSON.stringify(projection),
          JSON.stringify(refs),
        ],
      )
    ).rows[0];
    const task = (
      await client.query('SELECT session_id FROM agent_tasks WHERE id=$1', [fence.taskId])
    ).rows[0];
    await event(client, String(task.session_id), fence.taskId, 'skill.step.completed', {
      stepId: input.stepId,
      artifactRefs: refs,
    });
    return callView(row);
  });
}
export async function failDynamicSkillCall(
  infra: Infrastructure,
  fence: AgentSkillFence,
  stepId: string,
  errorCode: string,
) {
  return transaction(infra, async (client) => {
    await executionFence(client, fence);
    const result = await client.query(
      "UPDATE agent_skill_calls SET status='failed',error_code=$4,updated_at=now() WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 AND status='running' AND generation=$5",
      [fence.taskId, fence.inputRevision, stepId, errorCode.slice(0, 100), fence.generation],
    );
    return Boolean(result.rowCount);
  });
}
/** Copies exact immutable method and the original ceiling into a new task/revision. */
export async function copyDynamicSkillBinding(
  client: PoolClient,
  ownerId: string,
  sourceTaskId: string,
  sourceRevision: number,
  taskId: string,
  revision: number,
  policy: 'original' | 'latest' = 'original',
) {
  const old = (
    await client.query(
      'SELECT * FROM agent_task_skill_bindings WHERE task_id=$1 AND owner_id=$2 AND input_revision=$3',
      [sourceTaskId, ownerId, sourceRevision],
    )
  ).rows[0];
  if (!old) return;
  const head = await currentSkill(client, ownerId, String(old.skill_id));
  const version = await checkVersion(
    client,
    ownerId,
    String(old.skill_id),
    policy === 'latest' ? head.currentVersion! : String(old.version),
  );
  if (
    (version.definition as DynamicSkillDefinition).toolIds.some(
      (id) => !(old.tool_ceiling as string[]).includes(id),
    )
  )
    reject('forbidden', '新版技能超出原任务工具授权');
  await client.query(
    'INSERT INTO agent_task_skill_bindings(task_id,owner_id,input_revision,skill_id,version,content_hash,adapter_version,tool_ceiling) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
    [
      taskId,
      ownerId,
      revision,
      old.skill_id,
      version.version,
      version.content_hash,
      version.adapter_version,
      old.tool_ceiling,
    ],
  );
}

/** Final completion belongs to the host and requires every durable output and UI acknowledgement. */
export async function verifyTaskDynamicSkillCompletion(
  client: PoolClient,
  task: Row,
): Promise<boolean> {
  if (!isEnabled()) return false;
  try {
    const state = await readDynamicSkillExecution(
      client,
      String(task.owner_id),
      String(task.id),
      Number(task.input_revision),
    );
    if (!state.taskBinding || !state.version) return false;
    await checkVersion(
      client,
      String(task.owner_id),
      state.taskBinding.binding.skillId,
      state.taskBinding.binding.version,
    );
    for (const step of state.version.definition.steps)
      if (
        !state.calls.some(
          (call) =>
            call.stepId === step.id && call.toolId === step.toolId && call.status === 'completed',
        )
      )
        return false;
    for (const expected of state.version.definition.expectedArtifacts)
      if (
        !state.artifacts.some(
          (artifact) =>
            artifact.stepId === expected.stepId &&
            artifact.kind === expected.kind &&
            state.calls.some(
              (call) => call.stepId === expected.stepId && call.artifactRefs.includes(artifact.id),
            ),
        )
      )
        return false;
    for (const stepId of state.version.definition.requiredDisplays)
      if (
        !(
          await client.query(
            "SELECT id FROM agent_ui_commands WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 AND artifact_ref IS NOT NULL AND status='succeeded'",
            [task.id, task.input_revision, stepId],
          )
        ).rowCount
      )
        return false;
    return true;
  } catch (error) {
    if (error instanceof DynamicSkillError) return false;
    throw error;
  }
}

/** UI commands use the same current policy even while a worker lease is released. */
export async function assertDynamicSkillUiAvailable(
  client: PoolClient,
  task: Row,
  stepId: string,
  artifactRef?: string,
) {
  assertEnabled();
  const state = await readDynamicSkillExecution(
    client,
    String(task.owner_id),
    String(task.id),
    Number(task.input_revision),
  );
  if (!state.taskBinding || !state.version) return reject('not_found', '任务尚未绑定技能');
  await checkVersion(
    client,
    String(task.owner_id),
    state.taskBinding.binding.skillId,
    state.taskBinding.binding.version,
  );
  const step = state.version.definition.steps.find((item) => item.id === stepId);
  const artifact = state.artifacts.find(
    (item) => item.id === artifactRef && item.stepId === stepId,
  );
  if (
    !step?.ui ||
    !artifact ||
    artifact.kind !== step.artifactKind ||
    !state.taskBinding.toolCeiling.includes(step.toolId)
  )
    return reject('forbidden', '界面命令与技能产物不匹配');
  const call = state.calls.find((item) => item.stepId === stepId);
  if (!call || call.status !== 'waiting_ui') return reject('conflict', '技能步骤未等待界面回执');
  return { operation: step.ui, artifact };
}
