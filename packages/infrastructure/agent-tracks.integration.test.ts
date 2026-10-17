import { executeUiTask } from '../../apps/agent/ui-runtime';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  saveAgentVesselTracksResult,
  finishAgentTask,
  getOwnedAgentTask,
  getAgentTaskContext,
  retryAgentTask,
  reusePreviousAgentTask,
  respondAgentInput,
} from './agent';
import {
  registerUiClient,
  updateUiState,
  createUiCommand,
  claimUiCommand,
  receiptUiCommand,
  getUiTaskCommand,
} from './agent-ui';
import { UiStateSchema, uiPostcondition } from '../contracts/agent-ui';
import type { AgentVesselTracksResult } from '../contracts/vessel-tracks';

describe('历史航线持久化与页面版本', () => {
  let infra: Infrastructure;
  const owner = randomUUID();
  const previous = { agent: process.env.AGENT_ENABLED, ui: process.env.AGENT_UI_ENABLED };
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    infra = await createInfrastructure();
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
      [owner],
    );
  });
  afterAll(async () => {
    if (previous.agent === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previous.agent;
    if (previous.ui === undefined) delete process.env.AGENT_UI_ENABLED;
    else process.env.AGENT_UI_ENABLED = previous.ui;
    for (const table of [
      'agent_ui_receipts',
      'agent_ui_commands',
      'agent_input_responses',
      'agent_input_requests',
      'agent_events',
      'agent_steps',
      'agent_results',
      'agent_messages',
      'agent_tasks',
      'agent_ui_clients',
      'agent_sessions',
    ]) {
      const task = 'task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)';
      const where =
        table === 'agent_ui_receipts'
          ? `command_id IN (SELECT id FROM agent_ui_commands WHERE ${task})`
          : ['agent_ui_commands', 'agent_input_requests', 'agent_steps', 'agent_results'].includes(
                table,
              )
            ? task
            : ['agent_events', 'agent_messages'].includes(table)
              ? 'session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)'
              : 'owner_id=$1';
      await infra.pool.query(`DELETE FROM ${table} WHERE ${where}`, [owner]);
    }
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await infra.close();
  });
  async function setup(goal = '绘制过去24小时货船航线') {
    const session = await createAgentSession(infra, owner, '航线');
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
      ],
    });
    const binding = await updateUiState(
      infra,
      owner,
      await registerUiClient(infra, owner, randomUUID()),
      session.id,
      state,
    );
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: goal,
      historyHours: 24,
      mapContext: { bbox: [120, 30, 122, 32], capturedAt: new Date().toISOString() },
      uiBinding: { ...binding, tracksVersion: 1 },
    });
    return { session, state, binding, sent };
  }
  function snapshot(
    task: NonNullable<Awaited<ReturnType<typeof claimAgentTask>>>,
  ): AgentVesselTracksResult {
    return {
      kind: 'vessel_tracks',
      version: 0,
      inputRevision: task.inputRevision ?? 0,
      query: {
        bbox: task.selection!.bbox!,
        ...task.selection!.timeRange!,
        selector: task.selection!.vesselSelector!,
        maxVessels: 20,
        maxPointsPerVessel: 500,
      },
      asOf: task.to,
      generatedAt: task.to,
      shipTypeBasis: 'current_profile',
      selectionBasis: 'historical_observation_in_bbox',
      trackScope: 'full_time_window',
      returnedVessels: 0,
      matchedVesselsLowerBound: 0,
      hasMoreVessels: false,
      tracks: [],
    };
  }
  it('旧generation不能写入；历史/retry/reuse保留完整结果与修订', async () => {
    const { session, sent } = await setup();
    expect(sent.task.intent).toBe('vessel_tracks');
    const task = (await claimAgentTask(infra, 'tracks', sent.task.id))!;
    const result = snapshot(task);
    expect(
      await saveAgentVesselTracksResult(infra, task.id, 'tracks', task.generation + 1, result),
    ).toBeNull();
    await expect(
      infra.pool.query(
        "INSERT INTO agent_results(task_id,version,results,input_revision,kind,tracks_result) VALUES($1,1,'[]',0,'vessel_tracks','{}')",
        [task.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(
      await saveAgentVesselTracksResult(infra, task.id, 'tracks', task.generation, result),
    ).toBe(1);
    expect(
      await finishAgentTask(infra, task.id, 'tracks', task.generation, {
        status: 'completed',
        summary: '已保存航线',
        summaryResultVersion: 1,
      }),
    ).toBe(true);
    expect((await getOwnedAgentTask(infra, owner, task.id, 1))?.tracksResult).toEqual({
      ...result,
      version: 1,
    });
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '解释上次结果',
      historyHours: 24,
    });
    const claimed = (await claimAgentTask(infra, 'explain', next.task.id))!;
    expect(
      await reusePreviousAgentTask(infra, claimed.id, 'explain', claimed.generation, task.id),
    ).not.toBeNull();
    expect((await getAgentTaskContext(infra, claimed.id))?.tracksResult).toEqual({
      ...result,
      version: 1,
    });
    const retried = await retryAgentTask(infra, owner, task.id, randomUUID());
    expect((await getAgentTaskContext(infra, retried.task.id))?.tracksResult).toEqual({
      ...result,
      version: 1,
      inputRevision: 0,
    });
  });
  it('缺少目标补问，回答增加修订并保持预算', async () => {
    const { sent } = await setup('绘制过去24小时历史航线');
    expect(sent.task.status).toBe('awaiting_input');
    const req = sent.pendingInputRequests[0]!;
    expect(req.fields).toContain('vessel_selector');
    const answered = await respondAgentInput(infra, owner, sent.task.id, req.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { vesselSelector: { model: '052D' } },
    });
    expect(answered.task).toMatchObject({
      status: 'queued',
      inputRevision: 1,
      modelCalls: 0,
      toolCalls: 0,
      selection: { vesselSelector: { model: '052D' } },
    });
  });
  it('新查询show携带持久快照，版本冲突拒绝自动绘制', async () => {
    const { sent, binding, state, session } = await setup();
    const task = (await claimAgentTask(infra, 'tracks', sent.task.id))!;
    await saveAgentVesselTracksResult(infra, task.id, 'tracks', task.generation, snapshot(task));
    await updateUiState(infra, owner, binding, session.id, {
      ...state,
      sequence: 2,
      components: [{ ...state.components[0]!, version: 2 }],
    });
    await expect(
      createUiCommand(infra, task.id, 'tracks', task.generation, {
        componentId: 'chart.vessel-tracks',
        action: 'show',
      }),
    ).rejects.toThrow();
    const fresh = await setup();
    const next = (await claimAgentTask(infra, 'tracks', fresh.sent.task.id))!;
    await saveAgentVesselTracksResult(infra, next.id, 'tracks', next.generation, snapshot(next));
    const command = (await createUiCommand(infra, next.id, 'tracks', next.generation, {
      componentId: 'chart.vessel-tracks',
      action: 'show',
    }))!;
    const claim = await claimUiCommand(infra, owner, command, fresh.binding);
    expect(claim.tracksPresentation).toMatchObject({
      kind: 'vessel_tracks',
      version: 1,
      inputRevision: 0,
    });
    expect(claim.presentation).toBeUndefined();
  });
  it('无快照恢复由页面明确回执UNAVAILABLE，不伪报成功', async () => {
    const h = await setup('恢复上次航线');
    const task = (await claimAgentTask(infra, 'restore', h.sent.task.id))!;
    await executeUiTask(infra, task, 'restore', 24);
    const command = (await getUiTaskCommand(infra, task.id, 0))!;
    const claim = await claimUiCommand(infra, owner, command.id, h.binding);
    expect(claim.tracksPresentation).toBeUndefined();
    const receiptId = randomUUID();
    await receiptUiCommand(infra, owner, claim.id, {
      ...h.binding,
      claimToken: claim.claimToken!,
      receiptId,
      status: 'rejected',
      error: 'UNAVAILABLE',
      state: h.state,
    });
    const resumed = (await claimAgentTask(infra, 'restore-next', task.id))!;
    await executeUiTask(infra, resumed, 'restore-next', 24);
    expect((await getAgentTaskContext(infra, task.id))?.task.status).toBe('failed');
    expect((await getAgentTaskContext(infra, task.id))?.task.summary).toContain('历史结果');
    expect(
      (
        await infra.pool.query('SELECT body FROM agent_ui_receipts WHERE receipt_id=$1', [
          receiptId,
        ])
      ).rows[0].body.error,
    ).toBe('UNAVAILABLE');
  });
  it('关闭批量层回执不依赖既有单船图层', () => {
    const state = UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.vessel-tracks',
          version: 2,
          mounted: true,
          open: false,
          visible: false,
          loading: false,
          interacting: false,
          actions: ['show', 'close'],
        },
      ],
    });
    expect(uiPostcondition({ componentId: 'chart.vessel-tracks', action: 'close' }, state)).toBe(
      true,
    );
    state.components[0]!.loading = true;
    expect(uiPostcondition({ componentId: 'chart.vessel-tracks', action: 'close' }, state)).toBe(
      false,
    );
  });
});
