import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  getAgentTaskContext,
  cancelAgentTask,
} from './agent';
import {
  registerUiClient,
  updateUiState,
  claimUiCommand,
  receiptUiCommand,
  getUiTaskCommand,
  expireUiCommands,
  readUiState,
  listUiCommands,
} from './agent-ui';
import { UiStateSchema, type UiReceipt } from '../contracts/agent-ui';
import { executeUiTask } from '../../apps/agent/ui-runtime';

describe('durable semantic UI execution', () => {
  let infra: Infrastructure;
  const owner = randomUUID(),
    other = randomUUID();
  const previous = { agent: process.env.AGENT_ENABLED, ui: process.env.AGENT_UI_ENABLED };
  const initial = () =>
    UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.heatmap',
          version: 1,
          mounted: true,
          open: true,
          visible: true,
          actions: ['close'],
        },
        {
          id: 'chart.heatmap.legend',
          version: 1,
          mounted: true,
          open: true,
          visible: true,
          actions: [],
        },
        {
          id: 'chart.heatmap.popup',
          version: 1,
          mounted: true,
          open: false,
          visible: false,
          actions: ['close'],
        },
      ],
    });
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    for (const id of [owner, other])
      await infra.pool.query(
        "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'unused','operator')",
        [id, id],
      );
  });
  afterAll(async () => {
    if (previous.agent === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previous.agent;
    if (previous.ui === undefined) delete process.env.AGENT_UI_ENABLED;
    else process.env.AGENT_UI_ENABLED = previous.ui;
    if (!infra) return;
    for (const table of [
      'agent_ui_receipts',
      'agent_ui_commands',
      'agent_events',
      'agent_steps',
      'agent_messages',
      'agent_tasks',
      'agent_ui_clients',
      'agent_sessions',
    ]) {
      const where =
        table === 'agent_ui_receipts'
          ? 'command_id IN (SELECT id FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1))'
          : ['agent_ui_commands', 'agent_steps'].includes(table)
            ? 'task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)'
            : ['agent_events', 'agent_messages'].includes(table)
              ? 'session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)'
              : 'owner_id=$1';
      await infra.pool.query(`DELETE FROM ${table} WHERE ${where}`, [owner]);
    }
    await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, other]]);
    await infra.close();
  });
  async function setup() {
    const session = await createAgentSession(infra, owner, 'UI');
    let binding = await registerUiClient(infra, owner, randomUUID());
    const state = initial();
    binding = await updateUiState(infra, owner, binding, session.id, state);
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '关闭热力图',
      historyHours: 24,
      uiBinding: binding,
    });
    const task = (await claimAgentTask(infra, 'ui-worker', sent.task.id))!;
    await executeUiTask(infra, task, 'ui-worker', 24);
    const command = (await getUiTaskCommand(infra, task.id, 0))!;
    return { session, binding, state, task, command };
  }
  it('releases worker, persists receipts, resumes same task and never queries AIS', async () => {
    const h = await setup();
    expect((await getAgentTaskContext(infra, h.task.id))?.task.status).toBe('waiting_ui');
    const claim = await claimUiCommand(infra, owner, h.command.id, h.binding);
    const started: UiReceipt = {
      ...h.binding,
      claimToken: claim.claimToken!,
      receiptId: randomUUID(),
      status: 'executing',
      state: h.state,
    };
    await receiptUiCommand(infra, owner, claim.id, started);
    await receiptUiCommand(infra, owner, claim.id, started);
    const state = initial();
    state.sequence = 2;
    state.components.forEach((c) => {
      c.open = false;
      c.visible = false;
      c.version++;
    });
    const done: UiReceipt = { ...started, receiptId: randomUUID(), status: 'succeeded', state };
    await receiptUiCommand(infra, owner, claim.id, done);
    await receiptUiCommand(infra, owner, claim.id, done);
    const resumed = (await claimAgentTask(infra, 'restarted-worker', h.task.id))!;
    await executeUiTask(infra, resumed, 'restarted-worker', 24);
    const result = await getAgentTaskContext(infra, h.task.id);
    expect(result?.task.status).toBe('completed');
    expect(result?.task.uiResult?.status).toBe('succeeded');
    expect(result?.task.resultVersion).toBe(0);
    expect(result?.task.summary).toContain('已关闭热力图');
  });
  it('rejects other users, other tabs, concurrent claims and late cancellation receipts', async () => {
    const h = await setup();
    await expect(claimUiCommand(infra, other, h.command.id, h.binding)).rejects.toThrow();
    const second = await registerUiClient(infra, owner, randomUUID());
    expect(await listUiCommands(infra, owner, second)).toEqual([]);
    await expect(claimUiCommand(infra, owner, h.command.id, second)).rejects.toThrow();
    const claims = await Promise.allSettled([
      claimUiCommand(infra, owner, h.command.id, h.binding),
      claimUiCommand(infra, owner, h.command.id, h.binding),
    ]);
    expect(claims.filter((c) => c.status === 'fulfilled')).toHaveLength(1);
    const claimed = claims.find((c) => c.status === 'fulfilled')!;
    if (claimed.status !== 'fulfilled') throw new Error('claim');
    await cancelAgentTask(infra, owner, h.task.id);
    await expect(
      receiptUiCommand(infra, owner, h.command.id, {
        ...h.binding,
        claimToken: claimed.value.claimToken!,
        receiptId: randomUUID(),
        status: 'executing',
        state: h.state,
      }),
    ).rejects.toThrow();
  });
  it('detects stale state, component conflicts and changed page generations', async () => {
    const h = await setup();
    await updateUiState(infra, owner, h.binding, h.session.id, { ...h.state, sequence: 2 });
    const claim = await claimUiCommand(infra, owner, h.command.id, h.binding);
    const state = structuredClone(h.state);
    state.components[0]!.version++;
    await expect(
      receiptUiCommand(infra, owner, h.command.id, {
        ...h.binding,
        claimToken: claim.claimToken!,
        receiptId: randomUUID(),
        status: 'executing',
        state,
      }),
    ).rejects.toThrow();
    await infra.pool.query(
      "UPDATE agent_ui_clients SET observed_at=now()-interval '20 seconds' WHERE id=$1",
      [h.binding.clientId],
    );
    await expect(readUiState(infra, owner, h.binding, h.session.id)).rejects.toThrow('过期');
    await updateUiState(infra, owner, h.binding, h.session.id, {
      ...h.state,
      sequence: 3,
      route: '/sources',
      components: [],
    });
    await expect(claimUiCommand(infra, owner, h.command.id, h.binding)).rejects.toThrow();
  });
  it('rechecks permissions after claim and before accepting any execution receipt', async () => {
    const h = await setup();
    const claim = await claimUiCommand(infra, owner, h.command.id, h.binding);
    await infra.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [owner]);
    try {
      await expect(
        receiptUiCommand(infra, owner, h.command.id, {
          ...h.binding,
          claimToken: claim.claimToken!,
          receiptId: randomUUID(),
          status: 'executing',
          state: h.state,
        }),
      ).rejects.toMatchObject({ code: 'forbidden' });
      expect((await getUiTaskCommand(infra, h.task.id, 0))?.status).toBe('claimed');
    } finally {
      await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
    }
  });
  it('never replays a command whose executing receipt survived a lost browser', async () => {
    const h = await setup();
    const claim = await claimUiCommand(infra, owner, h.command.id, h.binding);
    await receiptUiCommand(infra, owner, h.command.id, {
      ...h.binding,
      claimToken: claim.claimToken!,
      receiptId: randomUUID(),
      status: 'executing',
      state: h.state,
    });
    await infra.pool.query(
      "UPDATE agent_ui_clients SET lease_until=now()-interval '1 second' WHERE id=$1",
      [h.binding.clientId],
    );
    await expireUiCommands(infra);
    expect((await getUiTaskCommand(infra, h.task.id, 0))?.status).toBe('unknown');
    const task = (await claimAgentTask(infra, 'restart', h.task.id))!;
    await executeUiTask(infra, task, 'restart', 24);
    expect((await getAgentTaskContext(infra, h.task.id))?.task.status).toBe('failed');
  });
  it('rejects invalid success postconditions and never publishes a success summary', async () => {
    const h = await setup();
    const claim = await claimUiCommand(infra, owner, h.command.id, h.binding);
    const receipt: UiReceipt = {
      ...h.binding,
      claimToken: claim.claimToken!,
      receiptId: randomUUID(),
      status: 'executing',
      state: h.state,
    };
    await receiptUiCommand(infra, owner, claim.id, receipt);
    await receiptUiCommand(infra, owner, claim.id, {
      ...receipt,
      receiptId: randomUUID(),
      status: 'succeeded',
    });
    expect((await getUiTaskCommand(infra, h.task.id, 0))?.status).toBe('failed');
    const task = (await claimAgentTask(infra, 'bad-receipt', h.task.id))!;
    await executeUiTask(infra, task, 'bad-receipt', 24);
    expect((await getAgentTaskContext(infra, h.task.id))?.task.summary).not.toContain('已关闭');
  });
  it('does not replenish the task budget when UI work is requested', async () => {
    const session = await createAgentSession(infra, owner, '预算');
    let binding = await registerUiClient(infra, owner, randomUUID());
    binding = await updateUiState(infra, owner, binding, session.id, initial());
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '关闭热力图',
      historyHours: 24,
      uiBinding: binding,
    });
    await infra.pool.query('UPDATE agent_tasks SET tool_calls=24 WHERE id=$1', [sent.task.id]);
    const task = (await claimAgentTask(infra, 'budget', sent.task.id))!;
    await executeUiTask(infra, task, 'budget', 24);
    expect((await getAgentTaskContext(infra, task.id))?.task.errorCode).toBe('budget_exhausted');
    expect(await getUiTaskCommand(infra, task.id, 0)).toBeNull();
  });
});
