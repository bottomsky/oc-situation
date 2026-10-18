import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfrastructure, type Infrastructure } from '../../packages/infrastructure/clients';
import { runMigrations } from '../../packages/infrastructure/migrations';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  saveAgentStep,
  saveAgentQueryResult,
  getAgentTaskContext,
  getPreviousAgentTask,
  finishAgentTask,
} from '../../packages/infrastructure/agent';
import {
  getAgentSessionMemory,
  getAgentAccountMemory,
  getAgentMemorySettings,
  updateAgentMemorySettings,
} from '../../packages/infrastructure/agent-memory';
import type { AgentQueryResult } from '../../packages/contracts/agent';

describe('task submission binds durable session and account memory', () => {
  let infra: Infrastructure;
  const owner = randomUUID();
  const flags = [
    'AGENT_ENABLED',
    'AGENT_SESSION_MEMORY_ENABLED',
    'AGENT_ACCOUNT_MEMORY_ENABLED',
    'AGENT_MEMORY_PROPOSALS_ENABLED',
  ] as const;
  const original = Object.fromEntries(flags.map((flag) => [flag, process.env[flag]]));
  beforeAll(async () => {
    for (const flag of flags) process.env[flag] = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'test-only','operator')",
      [owner],
    );
  });
  afterAll(async () => {
    for (const flag of flags) {
      if (original[flag] === undefined) delete process.env[flag];
      else process.env[flag] = original[flag];
    }
    if (!infra) return;
    for (const table of ['agent_input_requests', 'agent_steps', 'agent_results'])
      await infra.pool.query(
        `DELETE FROM ${table} WHERE task_id IN(SELECT id FROM agent_tasks WHERE owner_id=$1)`,
        [owner],
      );
    for (const table of ['agent_messages', 'agent_events'])
      await infra.pool.query(
        `DELETE FROM ${table} WHERE session_id IN(SELECT id FROM agent_sessions WHERE owner_id=$1)`,
        [owner],
      );
    await infra.pool.query('DELETE FROM agent_tasks WHERE owner_id=$1', [owner]);
    await infra.pool.query('DELETE FROM agent_sessions WHERE owner_id=$1', [owner]);
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await infra.close();
  });
  const submit = (sessionId: string, content: string, extra = {}) =>
    submitAgentMessage(infra, owner, sessionId, randomUUID(), {
      content,
      historyHours: 24,
      ...extra,
    });
  async function highlight(sessionId: string, ids = ['413000001', '413000002']) {
    const { task } = await submit(sessionId, '高亮型号ABC的船舶', { bbox: [110, 20, 120, 30] });
    const claimed = (await claimAgentTask(infra, 'memory-worker', task.id))!;
    const query: AgentQueryResult = {
      kind: 'vessel_list',
      version: 0,
      inputRevision: 0,
      selection: { bbox: [110, 20, 120, 30], vesselSelector: { model: 'ABC' } },
      total: ids.length,
      truncated: false,
      asOf: new Date().toISOString(),
      items: ids.map((mmsi) => ({
        mmsi,
        name: null,
        imo: null,
        shipType: null,
        latestPosition: null,
      })),
    };
    expect(
      await saveAgentStep(infra, task.id, 'memory-worker', claimed.generation, {
        key: 'map_vessel_snapshot',
        name: '地图对象快照',
        input: null,
        output: query,
      }),
    ).toBe(true);
    await finishAgentTask(infra, task.id, 'memory-worker', claimed.generation, {
      status: 'failed',
      errorCode: 'ui_unavailable',
    });
    return { task, query };
  }
  it('resolves highlighter resultVersion zero before intent validation, across an intervening greeting', async () => {
    const session = await createAgentSession(infra, owner, 'highlight-focus');
    await highlight(session.id);
    const greeting = await submit(session.id, '你好');
    const claimed = (await claimAgentTask(infra, 'greeting-worker', greeting.task.id))!;
    await finishAgentTask(infra, greeting.task.id, 'greeting-worker', claimed.generation, {
      status: 'completed',
      summary: '你好。',
    });
    const focus = await submit(session.id, '聚焦', {
      mapContext: { bbox: [0, 0, 1, 1], capturedAt: new Date().toISOString() },
    });
    expect(focus.task.status).toBe('queued');
    expect(focus.task.selection?.mmsis).toEqual(['413000001', '413000002']);
    expect(focus.task.selection?.vesselSelector).toEqual({ mmsis: ['413000001', '413000002'] });
    expect(focus.task.selection?.bbox).toBeUndefined();
    const context = await getAgentTaskContext(infra, focus.task.id);
    expect(context?.memory?.session?.objectSets.at(-1)).toMatchObject({
      querySucceeded: true,
      uiSucceeded: false,
    });
    const tracks = await submit(session.id, '查询刚才这批船过去6小时的历史轨迹', {
      mapContext: { bbox: [0, 0, 1, 1], capturedAt: new Date().toISOString() },
    });
    expect(tracks.task.selection?.vesselSelector).toEqual({ mmsis: ['413000001', '413000002'] });
    expect(tracks.task.selection?.bbox).toEqual([110, 20, 120, 30]);
    const pronounTracks = await submit(session.id, '查询它们过去6小时的历史轨迹', {
      mapContext: { bbox: [0, 0, 1, 1], capturedAt: new Date().toISOString() },
    });
    expect(pronounTracks.task.selection?.bbox).toEqual([110, 20, 120, 30]);
    expect(pronounTracks.task.selection?.vesselSelector).toEqual({
      mmsis: ['413000001', '413000002'],
    });
    const newModel = await submit(session.id, '继续高亮型号B的船舶', { bbox: [110, 20, 120, 30] });
    expect(newModel.task.selection?.vesselSelector).toEqual({ model: 'B' });
    expect(newModel.task.selection?.mmsis).toBeUndefined();
    const explanation = await submit(session.id, '继续解释');
    expect(explanation.task.intent).toBe('explain');
    expect(
      (await getPreviousAgentTask(infra, explanation.task.id))?.queryResult?.items.map(
        (item) => item.mmsi,
      ),
    ).toEqual(['413000001', '413000002']);
  });
  it('keeps highlight clearing separate from explicit referent forgetting and isolates a new session', async () => {
    const session = await createAgentSession(infra, owner, 'forget');
    await highlight(session.id);
    await submit(session.id, '清除全部高亮');
    expect((await submit(session.id, '聚焦')).task.selection?.mmsis).toHaveLength(2);
    expect((await submit(session.id, '忘掉刚才这批船')).task.status).toBe('completed');
    expect((await submit(session.id, '聚焦')).task.status).toBe('awaiting_input');
    const fresh = await createAgentSession(infra, owner, 'fresh');
    expect((await submit(fresh.id, '聚焦')).task.status).toBe('awaiting_input');
  });
  it('never lets an older task completion replace the latest submitted round context', async () => {
    const session = await createAgentSession(infra, owner, 'late');
    const old = await submit(session.id, '查询当前视野有哪些船舶', { bbox: [110, 20, 120, 30] });
    const claimed = (await claimAgentTask(infra, 'late-worker', old.task.id))!;
    await highlight(session.id, ['413000003']);
    await saveAgentQueryResult(infra, old.task.id, 'late-worker', claimed.generation, {
      kind: 'vessel_list',
      version: 0,
      inputRevision: 0,
      total: 0,
      truncated: false,
      items: [],
      asOf: new Date().toISOString(),
      selection: { bbox: [110, 20, 120, 30] },
    });
    expect(
      (await getAgentSessionMemory(infra, owner, session.id))?.objectSets.at(-1)?.members,
    ).toEqual([{ kind: 'vessel', mmsi: '413000003' }]);
  });
  it('actually stores, updates and deletes natural-language preferences and binds the active default time', async () => {
    const session = await createAgentSession(infra, owner, 'preferences');
    expect((await submit(session.id, '记住：默认看过去2小时')).task.summary).toContain('已记住');
    expect(
      (await getAgentAccountMemory(infra, owner)).entries.some(
        (entry) => entry.value === '默认看过去2小时',
      ),
    ).toBe(true);
    const next = await submit(session.id, '查询船舶413000001的历史轨迹', {
      bbox: [110, 20, 120, 30],
    });
    expect(
      Date.parse(next.task.selection!.timeRange!.to) -
        Date.parse(next.task.selection!.timeRange!.from),
    ).toBe(2 * 3600_000);
    await submit(session.id, '把我的偏好改为：默认看过去6小时');
    expect(
      (await getAgentAccountMemory(infra, owner)).entries.some(
        (entry) => entry.value === '默认看过去6小时',
      ),
    ).toBe(true);
    await submit(session.id, '忘记我的偏好：默认看过去6小时');
    expect(
      (await getAgentAccountMemory(infra, owner)).entries.some(
        (entry) => entry.key === '历史查询默认',
      ),
    ).toBe(false);
  });
  it('stores automatic suggestions as proposed and confirms them even with future suggestions paused', async () => {
    const session = await createAgentSession(infra, owner, 'candidate');
    const candidate = await submit(session.id, '我习惯回答简洁一点');
    expect(candidate.task.status).toBe('completed');
    expect(candidate.task.summary).toContain('偏好候选');
    expect(
      (await getAgentAccountMemory(infra, owner, { includeProposed: true })).entries.find(
        (entry) => entry.key === '回答方式',
      )?.status,
    ).toBe('proposed');
    const settings = await getAgentMemorySettings(infra, owner);
    await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: settings.revision,
      readEnabled: settings.readEnabled,
      proposalsEnabled: false,
    });
    expect((await submit(session.id, '确认记住这个偏好')).task.summary).toContain('已确认');
    expect(
      (await getAgentAccountMemory(infra, owner)).entries.find((entry) => entry.key === '回答方式')
        ?.status,
    ).toBe('active');
  });
  it('persists named region geometry and exact vessel identities and recalls only an explicit name across sessions', async () => {
    const first = await createAgentSession(infra, owner, 'named-source');
    const remembered = await submit(first.id, '记住这个区域叫研究区', {
      mapContext: { bbox: [110, 20, 120, 30], capturedAt: new Date().toISOString() },
    });
    expect(remembered.task.summary).toContain('已记住');
    await submit(first.id, '记住选中的船舶叫常用船队', {
      mapContext: {
        bbox: [0, 0, 1, 1],
        selectedMmsis: ['413000001', '413000002'],
        capturedAt: new Date().toISOString(),
      },
    });
    const second = await createAgentSession(infra, owner, 'named-target');
    const region = await submit(second.id, '聚焦研究区');
    expect(region.task.intent).toBe('map_focus');
    expect(region.task.selection?.region).toEqual({ kind: 'bbox', bbox: [110, 20, 120, 30] });
    const vessels = await submit(second.id, '聚焦常用船队');
    expect(vessels.task.intent).toBe('map_focus');
    expect(vessels.task.selection?.mmsis).toEqual(['413000001', '413000002']);
    const regionAndVessel = await submit(second.id, '研究区内查询船舶413999999');
    expect(regionAndVessel.task.selection?.region).toEqual({
      kind: 'bbox',
      bbox: [110, 20, 120, 30],
    });
    expect(regionAndVessel.task.selection?.mmsis).toEqual(['413999999']);
    expect((await submit(second.id, '聚焦')).task.status).toBe('awaiting_input');
    const settings = await getAgentMemorySettings(infra, owner);
    await updateAgentMemorySettings(infra, owner, {
      operationId: randomUUID(),
      expectedRevision: settings.revision,
      readEnabled: false,
      proposalsEnabled: settings.proposalsEnabled,
    });
    expect((await submit(second.id, '聚焦研究区')).task.status).toBe('awaiting_input');
  });
});
