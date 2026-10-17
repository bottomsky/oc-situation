import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  saveAgentStep,
  getAgentTaskContext,
} from './agent';
import {
  registerUiClient,
  updateUiState,
  createUiCommand,
  claimUiCommand,
  receiptUiCommand,
  readTaskHighlightGroups,
} from './agent-ui';
import { UiStateSchema, type UiCommand, type UiState } from '../contracts/agent-ui';
import type { AgentVesselHighlightsResult } from '../contracts/agent-map';
import { processAgentTask } from '../../apps/agent';
import { getUiTaskCommand } from './agent-ui';

describe('trusted builtin map artifacts and page group ownership', () => {
  let infra: Infrastructure;
  const owner = randomUUID(),
    other = randomUUID();
  const previous = {
    agent: process.env.AGENT_ENABLED,
    ui: process.env.AGENT_UI_ENABLED,
    dynamic: process.env.AGENT_DYNAMIC_SKILLS_ENABLED,
  };
  const initial = () =>
    UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.vessel-highlights',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['show', 'close'],
          highlightGroups: [],
        },
        {
          id: 'chart.viewport',
          version: 1,
          mounted: true,
          open: true,
          visible: true,
          actions: ['focus'],
          cameraState: { center: [120, 30], zoom: 7, bbox: [119, 29, 121, 31] },
        },
      ],
    });
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'false';
    infra = await createInfrastructure();
    await runMigrations(infra);
    for (const id of [owner, other])
      await infra.pool.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','operator')",
        [id, id],
      );
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries({
      AGENT_ENABLED: previous.agent,
      AGENT_UI_ENABLED: previous.ui,
      AGENT_DYNAMIC_SKILLS_ENABLED: previous.dynamic,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!infra) return;
    await infra.pool.query(
      'DELETE FROM agent_ui_receipts WHERE command_id IN (SELECT q.id FROM agent_ui_commands q JOIN agent_tasks t ON t.id=q.task_id WHERE t.owner_id=ANY($1::uuid[]))',
      [[owner, other]],
    );
    await infra.pool.query(
      'DELETE FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=ANY($1::uuid[]))',
      [[owner, other]],
    );
    for (const table of ['agent_events', 'agent_steps', 'agent_messages'])
      await infra.pool.query(
        `DELETE FROM ${table} WHERE ${table === 'agent_steps' ? 'task_id IN (SELECT id FROM agent_tasks WHERE owner_id=ANY($1::uuid[]))' : 'session_id IN (SELECT id FROM agent_sessions WHERE owner_id=ANY($1::uuid[]))'}`,
        [[owner, other]],
      );
    for (const table of ['agent_tasks', 'agent_ui_clients', 'agent_sessions', 'users'])
      await infra.pool.query(
        `DELETE FROM ${table} WHERE ${table === 'users' ? 'id' : 'owner_id'}=ANY($1::uuid[])`,
        [[owner, other]],
      );
    await infra.close();
  });
  async function page(actor = owner) {
    const session = await createAgentSession(infra, actor, 'Map integration');
    let binding = await registerUiClient(infra, actor, randomUUID());
    const state = initial();
    binding = await updateUiState(infra, actor, binding, session.id, state);
    return { session, binding, state, actor };
  }
  type Page = Awaited<ReturnType<typeof page>>;
  const payload = (): AgentVesselHighlightsResult => ({
    kind: 'vessel_highlights',
    version: 0,
    inputRevision: 0,
    operation: 'show',
    vessels: [
      { mmsi: '123456789', name: null, lon: 120, lat: 30, observedAt: new Date().toISOString() },
    ],
    missingMmsis: [],
  });
  async function queue(p: Page, result = payload(), content = '高亮 MMSI 123456789') {
    const sent = await submitAgentMessage(infra, p.actor, p.session.id, randomUUID(), {
      content,
      historyHours: 24,
      uiBinding: p.binding,
    });
    const task = (await claimAgentTask(infra, 'map-test', sent.task.id))!;
    const artifactRef = randomUUID();
    await saveAgentStep(infra, task.id, 'map-test', task.generation, {
      key: 'map_vessel_highlights',
      name: 'vessel-highlight',
      input: null,
      output: { artifactRef, payload: result },
    });
    const id = await createUiCommand(
      infra,
      task.id,
      'map-test',
      task.generation,
      {
        componentId: 'chart.vessel-highlights',
        action: result.operation === 'show' ? 'show' : 'close',
      },
      { stepId: 'map_vessel_highlights', artifactRef, inputRevision: 0 },
    );
    return { task, artifactRef, id: id! };
  }
  async function acknowledge(p: Page, command: UiCommand, after: UiState) {
    const common = {
      ...p.binding,
      stepId: command.stepId,
      artifactRef: command.artifactRef,
      claimToken: command.claimToken!,
    };
    await receiptUiCommand(infra, p.actor, command.id, {
      ...common,
      receiptId: randomUUID(),
      status: 'executing',
      state: p.state,
    });
    const result = await receiptUiCommand(infra, p.actor, command.id, {
      ...common,
      receiptId: randomUUID(),
      status: 'succeeded',
      state: after,
    });
    p.state = after;
    return result;
  }
  it('injects typed artifacts and permits a new session task to clear a verified group on the same document', async () => {
    const p = await page(),
      q = await queue(p);
    const claimed = await claimUiCommand(infra, owner, q.id, p.binding);
    expect(claimed.highlightsPresentation).toMatchObject({
      kind: 'vessel_highlights',
      operation: 'show',
    });
    const after = structuredClone(p.state);
    after.sequence++;
    const component = after.components[0]!;
    component.version++;
    component.open = true;
    component.visible = true;
    component.highlightGroups = [
      { groupId: q.artifactRef, taskId: q.task.id, mmsis: ['123456789'] },
    ];
    component.highlightEvidence = { artifactRef: q.artifactRef, groups: component.highlightGroups };
    expect(await acknowledge(p, claimed, after)).toEqual({ status: 'succeeded' });
    const beforeSessionChange = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '清除任务1高亮',
      historyHours: 24,
      uiBinding: p.binding,
    });
    expect(beforeSessionChange.task.selection?.highlightTaskIndex).toBe(1);
    expect(await readTaskHighlightGroups(infra, beforeSessionChange.task)).toEqual(
      component.highlightGroups,
    );
    const earlierGeneration = p.binding.pageGeneration;
    p.session = await createAgentSession(infra, owner, 'Same page new conversation');
    p.binding = await updateUiState(infra, owner, p.binding, p.session.id, p.state);
    expect(p.binding.pageGeneration).toBeGreaterThan(earlierGeneration);
    const clearRequest = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '清除任务1高亮',
      historyHours: 24,
      uiBinding: p.binding,
    });
    expect(await readTaskHighlightGroups(infra, clearRequest.task)).toEqual(
      component.highlightGroups,
    );
    expect(
      await processAgentTask(infra, clearRequest.task.id, { apiKey: '' }, 'map-task-index-runtime'),
    ).toBe(true);
    const clearCommand = (await getUiTaskCommand(
      infra,
      clearRequest.task.id,
      0,
      'map_vessel_highlights',
    ))!;
    expect(clearCommand).not.toBeNull();
    const clearClaim = await claimUiCommand(infra, owner, clearCommand.id, p.binding);
    expect(clearClaim.highlightsPresentation?.clear).toEqual({
      mode: 'groups',
      groupIds: [q.artifactRef],
    });
    const empty = structuredClone(p.state);
    empty.sequence++;
    empty.components[0]!.version++;
    Object.assign(empty.components[0]!, {
      open: false,
      visible: false,
      highlightGroups: [],
      highlightEvidence: { artifactRef: clearClaim.artifactRef, groups: [] },
    });
    expect(await acknowledge(p, clearClaim, empty)).toEqual({ status: 'succeeded' });
    await processAgentTask(infra, clearRequest.task.id, { apiKey: '' }, 'map-task-index-recover');
    expect((await getAgentTaskContext(infra, clearRequest.task.id))?.task).toMatchObject({
      status: 'completed',
      modelCalls: 0,
      summary: '已清除指定船舶高亮。',
    });
  });
  it('rejects foreign and other-page group provenance even if the browser reports it', async () => {
    const p = await page(),
      q = await queue(p);
    const claimed = await claimUiCommand(infra, owner, q.id, p.binding);
    const after = structuredClone(p.state);
    after.sequence++;
    after.components[0]!.version++;
    Object.assign(after.components[0]!, {
      open: true,
      visible: true,
      highlightGroups: [{ groupId: q.artifactRef, taskId: q.task.id, mmsis: ['123456789'] }],
      highlightEvidence: {
        artifactRef: q.artifactRef,
        groups: [{ groupId: q.artifactRef, taskId: q.task.id, mmsis: ['123456789'] }],
      },
    });
    await acknowledge(p, claimed, after);
    for (const otherPage of [await page(owner), await page(other)]) {
      const malicious = structuredClone(otherPage.state);
      malicious.sequence++;
      Object.assign(malicious.components[0]!, after.components[0], { version: 2 });
      otherPage.binding = await updateUiState(
        infra,
        otherPage.actor,
        otherPage.binding,
        otherPage.session.id,
        malicious,
      );
      otherPage.state = malicious;
      const readRequest = await submitAgentMessage(
        infra,
        otherPage.actor,
        otherPage.session.id,
        randomUUID(),
        { content: '清除任务1高亮', historyHours: 24, uiBinding: otherPage.binding },
      );
      await expect(readTaskHighlightGroups(infra, readRequest.task)).rejects.toThrow('可信来源');
      await expect(
        queue(
          otherPage,
          {
            ...payload(),
            operation: 'clear',
            vessels: [],
            clear: { mode: 'groups', groupIds: [q.artifactRef] },
          },
          `清除高亮组 ${q.artifactRef}`,
        ),
      ).rejects.toThrow('可信来源');
    }
  });
  it('requires a fresh live page when reading task groups and accepts a new heartbeat without widening its scope', async () => {
    const p = await page();
    const request = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '清除任务1高亮',
      historyHours: 24,
      uiBinding: p.binding,
    });
    expect(await readTaskHighlightGroups(infra, request.task)).toEqual([]);
    await infra.pool.query(
      "UPDATE agent_ui_clients SET observed_at=now()-interval '11 seconds',lease_until=now()+interval '30 seconds' WHERE id=$1 AND owner_id=$2",
      [p.binding.clientId, owner],
    );
    await expect(readTaskHighlightGroups(infra, request.task)).rejects.toThrow('界面状态已过期');
    p.state.sequence++;
    await updateUiState(infra, owner, p.binding, p.session.id, p.state);
    expect(await readTaskHighlightGroups(infra, request.task)).toEqual([]);
    await infra.pool.query(
      "UPDATE agent_ui_clients SET lease_until=now()-interval '1 second' WHERE id=$1 AND owner_id=$2",
      [p.binding.clientId, owner],
    );
    await expect(readTaskHighlightGroups(infra, request.task)).rejects.toThrow('页面已离线或切换');
  });
  it('rejects a stale show after manual clearing changes the bound version', async () => {
    const p = await page();
    const sent = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '高亮 MMSI 123456789',
      historyHours: 24,
      uiBinding: p.binding,
    });
    const task = (await claimAgentTask(infra, 'map-stale', sent.task.id))!;
    const artifactRef = randomUUID();
    await saveAgentStep(infra, task.id, 'map-stale', task.generation, {
      key: 'map_vessel_highlights',
      name: 'vessel-highlight',
      input: null,
      output: { artifactRef, payload: payload() },
    });
    p.state.sequence++;
    p.state.components[0]!.version++;
    await updateUiState(infra, owner, p.binding, p.session.id, p.state);
    await expect(
      createUiCommand(
        infra,
        task.id,
        'map-stale',
        task.generation,
        { componentId: 'chart.vessel-highlights', action: 'show' },
        { stepId: 'map_vessel_highlights', artifactRef, inputRevision: 0 },
      ),
    ).rejects.toThrow('人工改变');
  });
  it('runs a builtin camera task through persistence, real evidence, and completed recovery without a model', async () => {
    const p = await page();
    const sent = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '镜头聚焦经度 122.3 纬度 31.5 缩放 12',
      historyHours: 24,
      uiBinding: p.binding,
    });
    expect(sent.task.intent).toBe('map_camera');
    expect(await processAgentTask(infra, sent.task.id, { apiKey: '' }, 'map-camera-runtime')).toBe(
      true,
    );
    const queued = (await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_camera'))!;
    const claimed = await claimUiCommand(infra, owner, queued.id, p.binding);
    expect(claimed.cameraPresentation?.request).toEqual({
      mode: 'point',
      center: [122.3, 31.5],
      zoom: 12,
    });
    const after = structuredClone(p.state);
    after.sequence++;
    after.components[1]!.version++;
    after.components[1]!.cameraEvidence = {
      commandId: claimed.id,
      center: [122.3, 31.5],
      zoom: 12,
      bbox: [122.2, 31.4, 122.4, 31.6],
    };
    after.components[1]!.cameraState = {
      center: [122.3, 31.5],
      zoom: 12,
      bbox: [122.2, 31.4, 122.4, 31.6],
    };
    expect(await acknowledge(p, claimed, after)).toEqual({ status: 'succeeded' });
    await processAgentTask(infra, sent.task.id, { apiKey: '' }, 'map-camera-runtime-recover');
    expect((await getAgentTaskContext(infra, sent.task.id))?.task).toMatchObject({
      status: 'completed',
      modelCalls: 0,
      summary: '海图镜头已调整。',
    });
  });
  it('rejects an apparent focus when the actual relative zoom does not match the executing snapshot', async () => {
    const p = await page();
    const sent = await submitAgentMessage(infra, owner, p.session.id, randomUUID(), {
      content: '海图镜头放大2级',
      historyHours: 24,
      uiBinding: p.binding,
    });
    await processAgentTask(infra, sent.task.id, { apiKey: '' }, 'map-relative-runtime');
    const queued = (await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_camera'))!;
    const claimed = await claimUiCommand(infra, owner, queued.id, p.binding);
    const after = structuredClone(p.state);
    after.sequence++;
    after.components[1]!.version++;
    Object.assign(after.components[1]!, {
      focused: true,
      cameraEvidence: {
        commandId: claimed.id,
        center: [120, 30],
        zoom: 8,
        bbox: [119, 29, 121, 31],
      },
    });
    expect(await acknowledge(p, claimed, after)).toEqual({ status: 'failed' });
  });
});
