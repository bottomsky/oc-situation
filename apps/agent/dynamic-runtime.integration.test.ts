import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PositionObservation } from '../../packages/contracts';
import { DynamicSkillDefinitionSchema } from '../../packages/contracts/dynamic-skills';
import { UiStateSchema } from '../../packages/contracts/agent-ui';
import { createInfrastructure, type Infrastructure } from '../../packages/infrastructure/clients';
import { saveHistoryBatch, saveLatestBatch } from '../../packages/infrastructure/storage';
import {
  createAgentSession,
  getAgentTaskContext,
  submitAgentMessage,
  respondAgentInput,
} from '../../packages/infrastructure/agent';
import {
  getDynamicSkillExecution,
  listOwnedSkills,
  publishOwnedSkill,
} from '../../packages/infrastructure/dynamic-skills';
import {
  claimUiCommand,
  getUiTaskCommand,
  receiptUiCommand,
  registerUiClient,
  updateUiState,
} from '../../packages/infrastructure/agent-ui';
import { processAgentTask } from './index';

describe('dynamic host, Pi and durable PostgreSQL task composition', () => {
  let infra: Infrastructure;
  const owner = randomUUID(),
    source = `dynamic-runtime-${randomUUID()}`;
  const cargo = String(970000000 + Math.floor(Math.random() * 1000000));
  const fishing = String(Number(cargo) + 1);
  const prefix = `dynamic-${randomUUID()}`;
  const before = {
    agent: process.env.AGENT_ENABLED,
    dynamic: process.env.AGENT_DYNAMIC_SKILLS_ENABLED,
    ui: process.env.AGENT_UI_ENABLED,
  };
  const definition = DynamicSkillDefinitionSchema.parse({
    schemaVersion: 1,
    name: prefix,
    description: '当前区域货船历史航线和热力图',
    body: '先筛选宿主当前范围内的货船，后续航线和热力图使用同一前置船舶集合，逐步展示。',
    requiredInputs: ['region', 'time'],
    toolIds: ['query_vessels', 'query_vessel_tracks', 'query_ais_heatmap'],
    steps: [
      {
        id: 'cargo',
        toolId: 'query_vessels',
        input: { selection: { $ref: 'input.selection' }, vesselClass: 'cargo' },
        artifactKind: 'vessel_list',
      },
      {
        id: 'tracks',
        toolId: 'query_vessel_tracks',
        input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
        artifactKind: 'vessel_tracks',
        ui: { componentId: 'chart.vessel-tracks', action: 'show' },
      },
      {
        id: 'heatmap',
        toolId: 'query_ais_heatmap',
        input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
        artifactKind: 'ais_heatmap',
        ui: { componentId: 'chart.heatmap', action: 'show' },
      },
    ],
    expectedArtifacts: [
      { stepId: 'cargo', kind: 'vessel_list' },
      { stepId: 'tracks', kind: 'vessel_tracks' },
      { stepId: 'heatmap', kind: 'ais_heatmap' },
    ],
    requiredDisplays: ['tracks', 'heatmap'],
  });
  function candidateResponse(candidate = definition) {
    const envelope = {
      id: 'integration',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
    };
    return new Response(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'skills_create', arguments: JSON.stringify({ definition: candidate }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    infra = await createInfrastructure();
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
      [owner],
    );
    const positions: PositionObservation[] = [cargo, fishing].flatMap((mmsi) =>
      [0, 1, 2].map((index) => ({
        schemaVersion: 1,
        cleaningVersion: 1,
        kind: 'position' as const,
        eventId: `${prefix}-${mmsi}-${index}`,
        captureId: randomUUID(),
        sourceId: source,
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        runId: null,
        observedAt: new Date(Date.now() - (5 - index) * 60000).toISOString(),
        receivedAt: new Date().toISOString(),
        mmsi,
        lat: 25.5 + index * 0.01,
        lon: 145.5 + index * 0.01,
        sogKnots: 2,
        cogDegrees: 0,
        headingDegrees: null,
        rotDegPerMinute: null,
        navigationStatus: null,
        receptionType: 'UNKNOWN' as const,
        quality: [],
      })),
    );
    await saveLatestBatch(infra, positions);
    await saveHistoryBatch(infra, positions);
    await infra.pool.query(
      'UPDATE vessels SET ship_type=CASE WHEN mmsi=$1 THEN 72 ELSE 30 END WHERE mmsi=ANY($2::text[])',
      [cargo, [cargo, fishing]],
    );
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries({
      AGENT_ENABLED: before.agent,
      AGENT_DYNAMIC_SKILLS_ENABLED: before.dynamic,
      AGENT_UI_ENABLED: before.ui,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!infra) return;
    const cleanup = await infra.pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query(
        'DELETE FROM agent_ui_receipts WHERE command_id IN (SELECT id FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1))',
        [owner],
      );
      await cleanup.query(
        'DELETE FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)',
        [owner],
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
        await cleanup.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      await cleanup.query('DELETE FROM agent_input_responses WHERE owner_id=$1', [owner]);
      for (const table of ['agent_input_requests', 'agent_steps', 'agent_results'])
        await cleanup.query(
          `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)`,
          [owner],
        );
      for (const table of ['agent_events', 'agent_messages'])
        await cleanup.query(
          `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)`,
          [owner],
        );
      for (const table of ['agent_tasks', 'agent_ui_clients', 'agent_sessions'])
        await cleanup.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      await cleanup.query('DELETE FROM audit WHERE user_id=$1', [owner]);
      await cleanup.query('DELETE FROM users WHERE id=$1', [owner]);
      await cleanup.query('DELETE FROM positions_latest WHERE mmsi=ANY($1::text[])', [
        [cargo, fishing],
      ]);
      await cleanup.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [[cargo, fishing]]);
      await cleanup.query('COMMIT');
      await infra.clickhouse.command({
        query: 'ALTER TABLE positions DELETE WHERE sourceId={source:String}',
        query_params: { source },
        clickhouse_settings: { mutations_sync: '1' },
      });
    } catch (error) {
      await cleanup.query('ROLLBACK');
      throw error;
    } finally {
      cleanup.release();
      await infra.close();
    }
  });

  it('creates and resumes the same task through three UI receipts, then reuses the skill without a model', async () => {
    const session = await createAgentSession(infra, owner, '动态组合验收');
    const state = UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.vessel-tracks',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['show', 'close'],
        },
        {
          id: 'chart.heatmap',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['show', 'close'],
        },
        {
          id: 'chart.focus',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['show', 'close', 'focus'],
        },
      ],
    });
    const binding = await updateUiState(
      infra,
      owner,
      await registerUiClient(infra, owner, randomUUID()),
      session.id,
      state,
    );
    const input = {
      content: '筛选当前区域货船，展示最近72小时历史航线和热力图',
      historyHours: 24,
      mapContext: {
        bbox: [145.1, 25.1, 145.9, 25.9] as [number, number, number, number],
        capturedAt: new Date().toISOString(),
        sourceId: source,
      },
      uiBinding: binding,
    };
    let requests = 0;
    const options = {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      maxModelCalls: 12,
      maxToolCalls: 24,
      fetch: async (_url: unknown, init?: RequestInit) => {
        requests++;
        expect(String(init?.body)).not.toMatch(new RegExp(`${cargo}|${fishing}|145\\.5|25\\.5`));
        return candidateResponse();
      },
    };
    const acknowledge = async (taskId: string, stepId: string) => {
      const command = (await getUiTaskCommand(infra, taskId, 0, stepId))!;
      expect(command).not.toBeNull();
      const claimed = await claimUiCommand(infra, owner, command.id, binding);
      expect(claimed.artifactRef).toBeTruthy();
      expect(
        stepId === 'tracks'
          ? claimed.tracksPresentation
          : stepId === 'map_map_focus'
            ? claimed.focusPresentation
            : claimed.presentation,
      ).toBeTruthy();
      if (stepId === 'map_map_focus') {
        expect(claimed.focusPresentation).toMatchObject({
          taskId,
          inputRevision: 0,
          displayStatus: 'complete',
          targets: expect.arrayContaining([
            expect.objectContaining({ ref: { kind: 'vessel', id: cargo } }),
            expect.objectContaining({ ref: { kind: 'track', id: cargo } }),
          ]),
        });
      }
      const receipt = {
        ...binding,
        claimToken: claimed.claimToken!,
        receiptId: randomUUID(),
        stepId,
        artifactRef: claimed.artifactRef,
        status: 'executing' as const,
        state: structuredClone(state),
      };
      await receiptUiCommand(infra, owner, claimed.id, receipt);
      state.sequence++;
      const component = state.components.find(
        (entry) => entry.id === claimed.operation.componentId,
      )!;
      component.version++;
      component.open = true;
      component.visible = true;
      if (stepId === 'map_map_focus') {
        component.focusEvidence = {
          artifactRef: claimed.artifactRef!,
          taskId,
          version: claimed.focusPresentation!.version,
          inputRevision: claimed.focusPresentation!.inputRevision,
          displayStatus: claimed.focusPresentation!.displayStatus,
        };
      }
      expect(
        await receiptUiCommand(infra, owner, claimed.id, {
          ...receipt,
          receiptId: randomUUID(),
          status: 'succeeded',
          state: structuredClone(state),
        }),
      ).toEqual({ status: 'succeeded' });
    };
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), input);
    expect(sent.task).toMatchObject({ intent: 'skill', status: 'queued' });
    expect(Date.parse(sent.task.to) - Date.parse(sent.task.from)).toBe(72 * 3600000);
    expect(await processAgentTask(infra, sent.task.id, options, 'first-worker')).toBe(true);
    expect((await getAgentTaskContext(infra, sent.task.id))?.task.status).toBe('waiting_ui');
    const first = (await getDynamicSkillExecution(infra, owner, sent.task.id))!;
    expect(first.calls.map((call) => call.stepId)).toEqual(['cargo', 'tracks']);
    expect(
      first.artifacts.find((artifact) => artifact.kind === 'vessel_list')?.payload,
    ).toMatchObject({ total: 1, items: [{ mmsi: cargo, shipType: 72 }] });
    await acknowledge(sent.task.id, 'tracks');
    await processAgentTask(infra, sent.task.id, options, 'after-restart');
    expect((await getDynamicSkillExecution(infra, owner, sent.task.id))?.calls).toHaveLength(3);
    await acknowledge(sent.task.id, 'heatmap');
    await processAgentTask(infra, sent.task.id, options, 'after-second-restart');
    expect((await getAgentTaskContext(infra, sent.task.id))?.task.status).toBe('waiting_ui');
    await acknowledge(sent.task.id, 'map_map_focus');
    await processAgentTask(infra, sent.task.id, options, 'after-focus-restart');
    const completed = await getAgentTaskContext(infra, sent.task.id);
    expect(completed?.task.status, JSON.stringify(completed?.task)).toBe('completed');
    expect(
      Number(
        (
          await infra.pool.query('SELECT count(*) FROM agent_ui_commands WHERE task_id=$1', [
            sent.task.id,
          ])
        ).rows[0].count,
      ),
    ).toBe(3);
    expect(requests).toBe(1);
    expect((await listOwnedSkills(infra, owner)).items).toHaveLength(1);
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      ...input,
      mapContext: { ...input.mapContext, capturedAt: new Date().toISOString() },
    });
    await processAgentTask(
      infra,
      next.task.id,
      {
        ...options,
        fetch: async () => {
          throw new Error('reuse must not invoke model');
        },
      },
      'reuse-worker',
    );
    const reused = (await getDynamicSkillExecution(infra, owner, next.task.id))!;
    expect(reused.taskBinding?.binding).toEqual(first.taskBinding?.binding);
    expect(reused.calls.map((call) => call.stepId)).toEqual(['cargo', 'tracks']);
    await acknowledge(next.task.id, 'tracks');
    await processAgentTask(infra, next.task.id, options, 'reuse-tracks');
    await acknowledge(next.task.id, 'heatmap');
    await processAgentTask(infra, next.task.id, options, 'reuse-heatmap');
    expect((await getAgentTaskContext(infra, next.task.id))?.task.status).toBe('waiting_ui');
    await acknowledge(next.task.id, 'map_map_focus');
    await processAgentTask(infra, next.task.id, options, 'reuse-focus');
    expect((await getAgentTaskContext(infra, next.task.id))?.task.status).toBe('completed');
    expect(
      Number(
        (
          await infra.pool.query('SELECT count(*) FROM agent_ui_commands WHERE task_id=$1', [
            next.task.id,
          ])
        ).rows[0].count,
      ),
    ).toBe(3);
    expect(requests).toBe(1);
    expect(reused.calls[0]!.callId).not.toBe(first.calls[0]!.callId);
  });
  it('continues an unknown goal after a purpose answer and resolves compatible skill ambiguity by exact version', async () => {
    const session = await createAgentSession(infra, owner, '结构化目标和方法选择');
    const mapContext = {
      bbox: [145.1, 25.1, 145.9, 25.9] as [number, number, number, number],
      capturedAt: new Date().toISOString(),
      sourceId: source,
    };
    const single = DynamicSkillDefinitionSchema.parse({
      ...definition,
      name: `${prefix}-single`,
      requiredInputs: ['region'],
      toolIds: ['query_vessels'],
      steps: [{ ...definition.steps[0], input: { selection: { $ref: 'input.selection' } } }],
      expectedArtifacts: [definition.expectedArtifacts[0]],
      requiredDisplays: [],
    });
    const options = {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async () => candidateResponse(single),
    };
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '对比区域内多种观测',
      historyHours: 24,
      mapContext,
    });
    await processAgentTask(infra, sent.task.id, options, 'unknown-worker');
    const awaiting = (await getAgentTaskContext(infra, sent.task.id))!;
    expect(awaiting.task.status).toBe('awaiting_input');
    const request = awaiting.pendingInputRequests[0]!;
    expect(request.fields).toContain('goal');
    await respondAgentInput(infra, owner, sent.task.id, request.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { purpose: 'vessel_list' },
    });
    await processAgentTask(infra, sent.task.id, options, 'answered-purpose');
    expect((await getAgentTaskContext(infra, sent.task.id))?.task).toMatchObject({
      status: 'completed',
      inputRevision: 1,
    });
    const published = await listOwnedSkills(infra, owner);
    await publishOwnedSkill(infra, owner, {
      operationId: randomUUID(),
      expectedCatalogRevision: published.catalogRevision,
      definition: { ...single, name: `${prefix}-alternative` },
    });
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '用技能筛选当前区域船舶',
      historyHours: 24,
      mapContext: { ...mapContext, capturedAt: new Date().toISOString() },
    });
    await processAgentTask(infra, next.task.id, options, 'ambiguous-worker');
    const choose = (await getAgentTaskContext(infra, next.task.id))!;
    expect(choose.task.status).toBe('awaiting_input');
    const skillRequest = choose.pendingInputRequests[0]!;
    expect(skillRequest.fields).toEqual(['skill']);
    const candidates = skillRequest.prefill?.skillCandidates;
    expect(candidates).toHaveLength(2);
    const selected = candidates![0]!;
    await respondAgentInput(infra, owner, next.task.id, skillRequest.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { skillRef: { skillId: selected.skillId, version: selected.version } },
    });
    await processAgentTask(
      infra,
      next.task.id,
      {
        ...options,
        fetch: async () => {
          throw new Error('selected published skill must not invoke a model');
        },
      },
      'selected-worker',
    );
    expect((await getAgentTaskContext(infra, next.task.id))?.task.status).toBe('completed');
    expect(
      (await getDynamicSkillExecution(infra, owner, next.task.id))?.taskBinding?.binding,
    ).toMatchObject({ skillId: selected.skillId, version: selected.version });
  });
});
