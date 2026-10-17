import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import {
  assertTaskDynamicSkillActive,
  beginDynamicSkillCall,
  bindTaskDynamicSkill,
  completeDynamicSkillCall,
  getDynamicSkillExecution,
  getOwnedSkillVersion,
  listOwnedSkills,
  publishOwnedSkill,
  revokeOwnedSkillVersion,
  setOwnedSkillEnabled,
} from './dynamic-skills';
import {
  cancelAgentTask,
  claimAgentTask,
  createAgentSession,
  finishAgentTask,
  getAgentTaskContext,
  getOwnedAgentTask,
  requestAgentInput,
  respondAgentInput,
  retryAgentTask,
  submitAgentMessage,
} from './agent';
import {
  claimUiCommand,
  getUiTaskCommand,
  queueDynamicSkillUi,
  receiptUiCommand,
  registerUiClient,
  updateUiState,
} from './agent-ui';
import { UiStateSchema } from '../contracts/agent-ui';
import { DynamicSkillDefinitionSchema, type AgentSkillFence } from '../contracts/dynamic-skills';

describe('personal dynamic skill transactions and durable execution', () => {
  let infra: Infrastructure;
  const owner = randomUUID(),
    other = randomUUID();
  const prior = {
    agent: process.env.AGENT_ENABLED,
    dynamic: process.env.AGENT_DYNAMIC_SKILLS_ENABLED,
    ui: process.env.AGENT_UI_ENABLED,
  };
  const definition = (name = `test-${randomUUID()}`) =>
    DynamicSkillDefinitionSchema.parse({
      schemaVersion: 1,
      name,
      description: '账号私有的船舶查询方法',
      body: '读取任务绑定范围，查询并保留船舶结果。',
      toolIds: ['query_vessels'],
      steps: [
        {
          id: 'vessels',
          toolId: 'query_vessels',
          input: { selection: { $ref: 'input.selection' } },
          artifactKind: 'vessel_list',
        },
      ],
    });
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    for (const id of [owner, other])
      await infra.pool.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
        [id],
      );
  });
  afterAll(async () => {
    for (const [name, value] of Object.entries({
      AGENT_ENABLED: prior.agent,
      AGENT_DYNAMIC_SKILLS_ENABLED: prior.dynamic,
      AGENT_UI_ENABLED: prior.ui,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    if (!infra) return;
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN');
      for (const id of [owner, other]) {
        await client.query(
          'DELETE FROM agent_ui_receipts WHERE command_id IN (SELECT id FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1))',
          [id],
        );
        await client.query(
          'DELETE FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)',
          [id],
        );
        for (const table of [
          'agent_skill_artifacts',
          'agent_skill_calls',
          'agent_task_skill_bindings',
          'agent_dynamic_skill_versions',
          'agent_dynamic_skills',
          'agent_dynamic_skill_operations',
          'agent_dynamic_skill_catalogs',
        ])
          await client.query(`DELETE FROM ${table} WHERE owner_id=$1`, [id]);
        await client.query('DELETE FROM agent_input_responses WHERE owner_id=$1', [id]);
        await client.query(
          'DELETE FROM agent_input_requests WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)',
          [id],
        );
        for (const table of ['agent_steps', 'agent_results'])
          await client.query(
            `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)`,
            [id],
          );
        for (const table of ['agent_events', 'agent_messages'])
          await client.query(
            `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)`,
            [id],
          );
        await client.query('DELETE FROM agent_tasks WHERE owner_id=$1', [id]);
        await client.query('DELETE FROM agent_ui_clients WHERE owner_id=$1', [id]);
        await client.query('DELETE FROM agent_sessions WHERE owner_id=$1', [id]);
        await client.query('DELETE FROM audit WHERE user_id=$1', [id]);
        await client.query('DELETE FROM users WHERE id=$1', [id]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await infra.close();
    }
  });
  const revision = async () => (await listOwnedSkills(infra, owner)).catalogRevision;
  async function publish(input = definition()) {
    return publishOwnedSkill(infra, owner, {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      definition: input,
    });
  }
  async function task() {
    const session = await createAgentSession(infra, owner, '动态技能');
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '查询当前区域货船并展示航线和热力图',
      historyHours: 24,
      bbox: [120, 30, 122, 32],
    });
    const claimed = (await claimAgentTask(infra, 'first-worker', sent.task.id))!;
    const fence: AgentSkillFence = {
      ownerId: owner,
      taskId: claimed.id,
      workerId: 'first-worker',
      generation: claimed.generation,
      inputRevision: claimed.inputRevision ?? 0,
    };
    return { session, claimed, fence };
  }
  async function bound() {
    const p = await publish();
    const t = await task();
    await bindTaskDynamicSkill(infra, t.fence, { skillId: p.skill.skillId }, ['query_vessels']);
    return { ...t, published: p };
  }
  it('publishes atomically with audit, survives response loss and isolates accounts', async () => {
    const input = {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      definition: definition(),
    };
    const first = await publishOwnedSkill(infra, owner, input);
    await publish();
    expect(await publishOwnedSkill(infra, owner, input)).toEqual(first);
    await expect(
      publishOwnedSkill(infra, owner, {
        ...input,
        definition: { ...input.definition, description: '其他请求' },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      await getOwnedSkillVersion(infra, other, first.skill.skillId, first.version.binding.version),
    ).toBeNull();
    expect((await listOwnedSkills(infra, other)).items).toEqual([]);
    const audit = await infra.pool.query(
      "SELECT count(*)::int AS count FROM audit WHERE user_id=$1 AND action='skill.publish' AND details->>'operationId'=$2",
      [owner, input.operationId],
    );
    expect(audit.rows[0].count).toBe(1);
  });
  it('serializes catalog CAS and enforces owner-local unique names', async () => {
    const expectedCatalogRevision = await revision();
    const outcomes = await Promise.allSettled(
      [1, 2].map(() =>
        publishOwnedSkill(infra, owner, {
          operationId: randomUUID(),
          expectedCatalogRevision,
          definition: definition(),
        }),
      ),
    );
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const named = definition();
    await publish(named);
    await expect(publish(named)).rejects.toMatchObject({ code: 'conflict' });
    await publishOwnedSkill(infra, other, {
      operationId: randomUUID(),
      expectedCatalogRevision: 0,
      definition: named,
    });
  });
  it('publishes and binds under the same worker fence and rejects a stale input revision', async () => {
    const t = await task();
    const input = {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      definition: definition(),
    };
    const first = await publishOwnedSkill(infra, owner, input, {
      fence: t.fence,
      toolCeiling: ['query_vessels'],
    });
    expect(first.taskBinding?.binding).toEqual(first.version.binding);
    expect(
      (await getDynamicSkillExecution(infra, owner, t.claimed.id))?.createdVersions,
    ).toHaveLength(1);
    await expect(
      publishOwnedSkill(
        infra,
        owner,
        { ...input, operationId: randomUUID(), expectedCatalogRevision: await revision() },
        { fence: { ...t.fence, inputRevision: 1 }, toolCeiling: ['query_vessels'] },
      ),
    ).rejects.toMatchObject({ code: 'fenced' });
    expect(
      (await getDynamicSkillExecution(infra, owner, t.claimed.id))?.createdVersions,
    ).toHaveLength(1);
  });
  it('persists exact skill candidates and rejects injected choices before resuming', async () => {
    const first = await publish(),
      second = await publish();
    const t = await task();
    const candidates = [first, second].map((item) => ({
      skillId: item.skill.skillId,
      version: item.version.binding.version,
      name: item.skill.name,
    }));
    await requestAgentInput(infra, t.claimed.id, t.fence.workerId, t.fence.generation, {
      fields: ['skill'],
      reason: 'ambiguous_skill',
      skillCandidates: candidates,
    });
    const request = (await getAgentTaskContext(infra, t.claimed.id))!.pendingInputRequests[0]!;
    expect(request.prefill.skillCandidates).toEqual(candidates);
    await expect(
      respondAgentInput(infra, owner, t.claimed.id, request.id, randomUUID(), {
        action: 'accept',
        inputRevision: 0,
        values: {
          skillRef: { skillId: first.skill.skillId, version: randomUUID() },
          skillCandidates: [
            { skillId: first.skill.skillId, version: randomUUID(), name: '伪造候选' },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    const selected = { skillId: first.skill.skillId, version: first.version.binding.version };
    const answer = await respondAgentInput(infra, owner, t.claimed.id, request.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: {
        skillRef: selected,
        skillCandidates: [{ skillId: randomUUID(), version: randomUUID(), name: '忽略客户端列表' }],
      },
    });
    expect(answer.task).toMatchObject({
      status: 'queued',
      intent: 'skill',
      inputRevision: 1,
      skillRef: selected,
    });
    expect(answer.task.selection?.skillCandidates).toBeUndefined();
    const claimed = (await claimAgentTask(infra, 'chosen-skill', t.claimed.id))!;
    const restored = await bindTaskDynamicSkill(
      infra,
      { ...t.fence, workerId: 'chosen-skill', generation: claimed.generation, inputRevision: 1 },
      selected,
      ['query_vessels'],
    );
    expect(restored.taskBinding?.binding).toEqual(first.version.binding);
  });
  it('clears generic time ambiguity when the persisted input request is answered', async () => {
    const t = await task();
    await infra.pool.query(
      'UPDATE agent_tasks SET selection=(selection-\'timeRange\') || \'{"heatmapTimeUnclear":true,"tracksTimeUnclear":true}\'::jsonb WHERE id=$1',
      [t.claimed.id],
    );
    await requestAgentInput(infra, t.claimed.id, t.fence.workerId, t.fence.generation, {
      fields: ['time'],
      reason: 'missing_time',
    });
    const request = (await getAgentTaskContext(infra, t.claimed.id))!.pendingInputRequests[0]!;
    const answer = await respondAgentInput(infra, owner, t.claimed.id, request.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { historyHours: 12 },
    });
    expect(answer.task.selection?.heatmapTimeUnclear).toBeUndefined();
    expect(answer.task.selection?.tracksTimeUnclear).toBeUndefined();
    expect(answer.task.selection?.timeRange).toBeDefined();
  });
  it('restores exact content after head update, input revision and explicit retry', async () => {
    const t = await bound();
    const old = t.published.version.binding;
    const fresh = await publishOwnedSkill(infra, owner, {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      skillId: old.skillId,
      definition: { ...t.published.version.definition, description: '新的方法说明' },
    });
    expect(fresh.version.binding.version).not.toBe(old.version);
    expect((await getDynamicSkillExecution(infra, owner, t.claimed.id))?.version?.binding).toEqual(
      old,
    );
    await requestAgentInput(infra, t.claimed.id, t.fence.workerId, t.fence.generation, {
      fields: ['region'],
      reason: 'scope_changed',
    });
    const request = (await getAgentTaskContext(infra, t.claimed.id))!.pendingInputRequests[0]!;
    await respondAgentInput(infra, owner, t.claimed.id, request.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { bbox: [121, 30, 122, 32] },
    });
    const afterInput = (await getDynamicSkillExecution(infra, owner, t.claimed.id))!;
    expect(afterInput.taskBinding?.inputRevision).toBe(1);
    expect(afterInput.version?.binding).toEqual(old);
    expect(await assertTaskDynamicSkillActive(infra, t.fence, 'query_vessels')).toBe(false);
    await cancelAgentTask(infra, owner, t.claimed.id);
    const retried = await retryAgentTask(infra, owner, t.claimed.id, randomUUID());
    expect(
      (await getDynamicSkillExecution(infra, owner, retried.task.id))?.version?.binding,
    ).toEqual(old);
    const latest = await retryAgentTask(
      infra,
      owner,
      t.claimed.id,
      randomUUID(),
      undefined,
      'latest',
    );
    expect(
      (await getDynamicSkillExecution(infra, owner, latest.task.id))?.version?.binding,
    ).toEqual(fresh.version.binding);
  });
  it('immediately blocks existing calls after disable, revoke, owner demotion and global disable', async () => {
    const t = await bound();
    expect(await assertTaskDynamicSkillActive(infra, t.fence, 'query_vessels')).toBe(true);
    expect(await assertTaskDynamicSkillActive(infra, t.fence, 'query_ais_heatmap')).toBe(false);
    await setOwnedSkillEnabled(infra, owner, t.published.skill.skillId, {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      enabled: false,
    });
    expect(await assertTaskDynamicSkillActive(infra, t.fence, 'query_vessels')).toBe(false);
    await setOwnedSkillEnabled(infra, owner, t.published.skill.skillId, {
      operationId: randomUUID(),
      expectedCatalogRevision: await revision(),
      enabled: true,
    });
    await infra.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [owner]);
    expect(await assertTaskDynamicSkillActive(infra, t.fence)).toBe(false);
    await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'false';
    expect(await assertTaskDynamicSkillActive(infra, t.fence)).toBe(false);
    expect((await getDynamicSkillExecution(infra, owner, t.claimed.id))?.version?.binding).toEqual(
      t.published.version.binding,
    );
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    await revokeOwnedSkillVersion(
      infra,
      owner,
      t.published.skill.skillId,
      t.published.version.binding.version,
      { operationId: randomUUID(), expectedCatalogRevision: await revision(), reason: '撤销测试' },
    );
    expect(await assertTaskDynamicSkillActive(infra, t.fence)).toBe(false);
  });
  it('keeps stable call IDs and budgets across worker takeover and fences late writes', async () => {
    const t = await bound();
    const input = {
      stepId: 'vessels',
      toolId: 'query_vessels',
      input: { selection: {} },
      maxToolCalls: 8,
    };
    const first = await beginDynamicSkillCall(infra, t.fence, input);
    await infra.pool.query(
      "UPDATE agent_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [t.claimed.id],
    );
    const takeover = (await claimAgentTask(infra, 'next-worker', t.claimed.id))!;
    const next = { ...t.fence, workerId: 'next-worker', generation: takeover.generation };
    await expect(
      completeDynamicSkillCall(infra, t.fence, {
        stepId: 'vessels',
        localResult: {},
        modelProjection: {},
        artifact: { kind: 'vessel_list', payload: {}, modelProjection: {} },
      }),
    ).rejects.toMatchObject({ code: 'fenced' });
    const unknown = await beginDynamicSkillCall(infra, next, input);
    expect(unknown).toMatchObject({ callId: first.callId, status: 'unknown' });
    expect((await getAgentTaskContext(infra, t.claimed.id))?.task.toolCalls).toBe(1);
    expect(
      await finishAgentTask(infra, t.claimed.id, next.workerId, next.generation, {
        status: 'completed',
      }),
    ).toBe(false);
  });
  it('persists complete local outputs, safe projections and immutable artifacts', async () => {
    const t = await bound();
    await beginDynamicSkillCall(infra, t.fence, {
      stepId: 'vessels',
      toolId: 'query_vessels',
      input: {},
      maxToolCalls: 8,
    });
    const call = await completeDynamicSkillCall(infra, t.fence, {
      stepId: 'vessels',
      localResult: { items: [{ mmsi: '413123456' }] },
      modelProjection: { total: 1 },
      artifact: {
        kind: 'vessel_list',
        payload: { items: [{ mmsi: '413123456' }] },
        modelProjection: { total: 1 },
      },
    });
    expect(call).toMatchObject({ status: 'completed', modelProjection: { total: 1 } });
    const snapshot = (await getDynamicSkillExecution(infra, owner, t.claimed.id))!;
    expect(snapshot.artifacts[0]?.id).toBe(call.artifactRefs[0]);
    await expect(
      infra.pool.query(
        "UPDATE agent_dynamic_skill_versions SET definition='{}' WHERE owner_id=$1 AND skill_id=$2",
        [owner, t.published.skill.skillId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      infra.pool.query("UPDATE agent_skill_artifacts SET payload='{}' WHERE id=$1", [
        call.artifactRefs[0],
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      infra.pool.query("UPDATE agent_task_skill_bindings SET tool_ceiling='{}' WHERE task_id=$1", [
        t.claimed.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await finishAgentTask(infra, t.claimed.id, t.fence.workerId, t.fence.generation, {
        status: 'completed',
        summary: '已查询船舶',
      }),
    ).toBe(true);
  });
  it('reads prior revision artifacts through owned task history after inputs change', async () => {
    const t = await bound();
    await beginDynamicSkillCall(infra, t.fence, {
      stepId: 'vessels',
      toolId: 'query_vessels',
      input: {},
      maxToolCalls: 8,
    });
    const call = await completeDynamicSkillCall(infra, t.fence, {
      stepId: 'vessels',
      localResult: { items: [] },
      modelProjection: { total: 0 },
      artifact: { kind: 'vessel_list', payload: { items: [] }, modelProjection: { total: 0 } },
    });
    await requestAgentInput(infra, t.claimed.id, t.fence.workerId, t.fence.generation, {
      fields: ['region'],
      reason: 'scope_changed',
    });
    const request = (await getAgentTaskContext(infra, t.claimed.id))!.pendingInputRequests[0]!;
    await respondAgentInput(infra, owner, t.claimed.id, request.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { bbox: [121, 30, 122, 32] },
    });
    expect((await getOwnedAgentTask(infra, owner, t.claimed.id))?.artifacts).toHaveLength(0);
    const history = await getOwnedAgentTask(infra, owner, t.claimed.id, undefined, 0);
    expect(history?.dynamicSkill.taskBinding?.inputRevision).toBe(0);
    expect(history?.artifacts[0]?.id).toBe(call.artifactRefs[0]);
    expect(await getOwnedAgentTask(infra, other, t.claimed.id, undefined, 0)).toBeNull();
  });
  it('releases a UI lease, resolves exact artifacts, accepts duplicate receipts and resumes remaining steps', async () => {
    const session = await createAgentSession(infra, owner, '多步骤展示');
    let uiBinding = await registerUiClient(infra, owner, randomUUID());
    const state = UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.heatmap',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['show'],
        },
      ],
    });
    uiBinding = await updateUiState(infra, owner, uiBinding, session.id, state);
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '查询当前区域货船并展示热力图',
      historyHours: 24,
      bbox: [120, 30, 122, 32],
      uiBinding,
    });
    const claimed = (await claimAgentTask(infra, 'ui-step-worker', sent.task.id))!;
    const fence = {
      ownerId: owner,
      taskId: claimed.id,
      inputRevision: 0,
      generation: claimed.generation,
      workerId: 'ui-step-worker',
    };
    const p = await publishOwnedSkill(
      infra,
      owner,
      {
        operationId: randomUUID(),
        expectedCatalogRevision: await revision(),
        definition: DynamicSkillDefinitionSchema.parse({
          schemaVersion: 1,
          name: `ui-${randomUUID()}`,
          description: '先展示热图再查船舶',
          body: '等待热图展示回执，再执行船舶查询。',
          toolIds: ['query_ais_heatmap', 'query_vessels'],
          steps: [
            {
              id: 'heatmap',
              toolId: 'query_ais_heatmap',
              input: {},
              artifactKind: 'ais_heatmap',
              ui: { componentId: 'chart.heatmap', action: 'show' },
            },
            { id: 'vessels', toolId: 'query_vessels', input: {}, artifactKind: 'vessel_list' },
          ],
        }),
      },
      { fence, toolCeiling: ['query_ais_heatmap', 'query_vessels'] },
    );
    const heatmap = {
      kind: 'ais_heatmap',
      version: 0,
      inputRevision: 0,
      query: { bbox: [120, 30, 122, 32], from: claimed.from, to: claimed.to },
      grid: { level: 0, cellDegrees: 360 },
      cells: [],
      totalVessels: 0,
      generatedAt: claimed.to,
      metric: 'unique_vessels',
      shipTypeBasis: 'current_profile',
    };
    await beginDynamicSkillCall(infra, fence, {
      stepId: 'heatmap',
      toolId: 'query_ais_heatmap',
      input: {},
      maxToolCalls: 8,
    });
    const output = await completeDynamicSkillCall(infra, fence, {
      stepId: 'heatmap',
      localResult: heatmap,
      modelProjection: { totalVessels: 0 },
      artifact: { kind: 'ais_heatmap', payload: heatmap, modelProjection: { totalVessels: 0 } },
    });
    await expect(
      beginDynamicSkillCall(infra, fence, {
        stepId: 'vessels',
        toolId: 'query_vessels',
        input: {},
        maxToolCalls: 8,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    const commandId = (await queueDynamicSkillUi(infra, fence, 'heatmap', output.artifactRefs[0]!, {
      componentId: 'chart.heatmap',
      action: 'show',
    }))!;
    expect((await getAgentTaskContext(infra, claimed.id))?.task.status).toBe('waiting_ui');
    const command = await claimUiCommand(infra, owner, commandId, uiBinding);
    expect(command.presentation).toEqual(heatmap);
    expect(command.artifactRef).toBe(output.artifactRefs[0]);
    const started = {
      ...uiBinding,
      stepId: 'heatmap',
      artifactRef: command.artifactRef,
      receiptId: randomUUID(),
      claimToken: command.claimToken!,
      status: 'executing' as const,
      state,
    };
    await receiptUiCommand(infra, owner, commandId, started);
    const shown = UiStateSchema.parse({
      ...state,
      sequence: 2,
      components: [{ ...state.components[0], version: 2, open: true, visible: true }],
    });
    const succeeded = {
      ...started,
      receiptId: randomUUID(),
      status: 'succeeded' as const,
      state: shown,
    };
    expect(await receiptUiCommand(infra, owner, commandId, succeeded)).toEqual({
      status: 'succeeded',
    });
    expect(await receiptUiCommand(infra, owner, commandId, succeeded)).toEqual({
      status: 'succeeded',
    });
    const resumed = (await claimAgentTask(infra, 'ui-resumed', claimed.id))!;
    const resumedFence = { ...fence, workerId: 'ui-resumed', generation: resumed.generation };
    expect(
      await finishAgentTask(infra, claimed.id, resumedFence.workerId, resumedFence.generation, {
        status: 'completed',
      }),
    ).toBe(false);
    await beginDynamicSkillCall(infra, resumedFence, {
      stepId: 'vessels',
      toolId: 'query_vessels',
      input: {},
      maxToolCalls: 8,
    });
    await completeDynamicSkillCall(infra, resumedFence, {
      stepId: 'vessels',
      localResult: {},
      modelProjection: {},
      artifact: { kind: 'vessel_list', payload: {}, modelProjection: {} },
    });
    expect(
      await finishAgentTask(infra, claimed.id, resumedFence.workerId, resumedFence.generation, {
        status: 'completed',
        summary: '热图已展示，船舶已查询',
      }),
    ).toBe(true);
    expect((await getDynamicSkillExecution(infra, owner, claimed.id))?.artifacts).toHaveLength(2);
    expect((await getUiTaskCommand(infra, claimed.id, 0, 'heatmap'))?.status).toBe('succeeded');
    const otherTask = await task();
    await expect(
      infra.pool.query(
        "INSERT INTO agent_ui_commands(id,task_id,input_revision,task_generation,client_id,page_generation,operation,expected_version,status,step_id,artifact_ref) VALUES($1,$2,0,1,$3,$4,'{}',1,'queued','foreign',$5)",
        [
          randomUUID(),
          otherTask.claimed.id,
          uiBinding.clientId,
          uiBinding.pageGeneration,
          output.artifactRefs[0],
        ],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    expect(p.taskBinding?.binding).toEqual(p.version.binding);
    const nextMessage = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续使用指定技能',
      historyHours: 24,
      bbox: [120, 30, 122, 32],
      uiBinding,
      skillRef: { skillId: p.skill.skillId, version: p.version.binding.version },
    });
    const nextTask = (await claimAgentTask(infra, 'late-ui-worker', nextMessage.task.id))!;
    const lateFence = {
      ...fence,
      taskId: nextTask.id,
      workerId: 'late-ui-worker',
      generation: nextTask.generation,
    };
    expect(nextTask.uiBinding?.heatmapVersion).toBe(2);
    await bindTaskDynamicSkill(
      infra,
      lateFence,
      { skillId: p.skill.skillId, version: p.version.binding.version },
      ['query_ais_heatmap', 'query_vessels'],
    );
    await beginDynamicSkillCall(infra, lateFence, {
      stepId: 'heatmap',
      toolId: 'query_ais_heatmap',
      input: {},
      maxToolCalls: 8,
    });
    const lateOutput = await completeDynamicSkillCall(infra, lateFence, {
      stepId: 'heatmap',
      localResult: heatmap,
      modelProjection: { totalVessels: 0 },
      artifact: { kind: 'ais_heatmap', payload: heatmap, modelProjection: { totalVessels: 0 } },
    });
    await updateUiState(
      infra,
      owner,
      uiBinding,
      session.id,
      UiStateSchema.parse({
        ...shown,
        sequence: 3,
        components: [{ ...shown.components[0], version: 3, open: false, visible: false }],
      }),
    );
    await expect(
      queueDynamicSkillUi(infra, lateFence, 'heatmap', lateOutput.artifactRefs[0]!, {
        componentId: 'chart.heatmap',
        action: 'show',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await getAgentTaskContext(infra, nextTask.id))?.task.status).toBe('running');
  });
});
