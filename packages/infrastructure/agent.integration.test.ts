import type { AgentIntelligenceResult } from '../contracts/intelligence-search';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import request from 'supertest';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  cancelAgentTask,
  finishAgentTask,
  saveAgentStep,
  reserveAgentCall,
  readAgentEvents,
  getAgentSession,
  getAgentTaskContext,
  renewAgentTask,
  saveAgentResults,
  reusePreviousAgentTask,
  getPreviousAgentTask,
  setAgentDefinition,
  requestAgentInput,
  respondAgentInput,
  saveAgentQueryResult,
  saveAgentIntelligenceResult,
  getOwnedAgentTask,
  retryAgentTask,
  revokeAgentOwnerExecution,
} from './agent';

describe('durable agent task fencing and ownership', () => {
  let infra: Infrastructure;
  const owner = randomUUID();
  const other = randomUUID();
  const viewer = randomUUID();
  let api: Awaited<ReturnType<typeof createApi>>;
  const credentials = new Map<string, { cookie: string; csrf: string }>();
  const previousEnabled = process.env.AGENT_ENABLED;
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    const password = randomUUID();
    const passwordHash = await hashPassword(password);
    for (const id of [owner, other, viewer])
      await infra.pool.query(
        'INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,$3)',
        [id, passwordHash, id === viewer ? 'viewer' : 'operator'],
      );
    api = await createApi(infra, { scheduler: false, origins: ['http://127.0.0.1:13001'] });
    for (const id of [owner, other, viewer]) {
      const login = await request(api.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', 'http://127.0.0.1:13001')
        .send({ username: id, password })
        .expect(200);
      credentials.set(id, {
        cookie: (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!,
        csrf: login.body.csrfToken,
      });
    }
  });
  afterAll(async () => {
    if (!infra) return;
    await api?.stop();
    if (previousEnabled === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previousEnabled;
    for (const table of [
      'agent_events',
      'agent_steps',
      'agent_results',
      'agent_messages',
      'agent_tasks',
    ]) {
      const column = ['agent_steps', 'agent_results'].includes(table)
        ? 'task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)'
        : table === 'agent_tasks'
          ? 'owner_id=$1'
          : 'session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)';
      await infra.pool.query(`DELETE FROM ${table} WHERE ${column}`, [owner]);
    }
    await infra.pool.query('DELETE FROM agent_sessions WHERE owner_id=$1', [owner]);
    await infra.pool.query('DELETE FROM audit WHERE user_id=ANY($1::uuid[])', [
      [owner, other, viewer],
    ]);
    await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, other, viewer]]);
    await infra.close();
  });
  it('deduplicates a message, isolates owners and persists clarification', async () => {
    const session = await createAgentSession(infra, owner, 'Test');
    const key = randomUUID();
    const first = await submitAgentMessage(infra, owner, session.id, key, {
      content: '分析',
      historyHours: 24,
    });
    const retry = await submitAgentMessage(infra, owner, session.id, key, {
      content: '分析',
      historyHours: 24,
    });
    expect(retry.task.id).toBe(first.task.id);
    expect(first.task.status).toBe('awaiting_input');
    expect(await getAgentSession(infra, other, session.id)).toBeNull();
    await expect(
      submitAgentMessage(infra, owner, session.id, key, { content: '不同请求', historyHours: 24 }),
    ).rejects.toThrow('Idempotency');
    expect((await getAgentSession(infra, owner, session.id))?.messages).toHaveLength(2);
  });
  it('queues recognized conversation without a region and persists one assistant reply after recovery', async () => {
    const session = await createAgentSession(infra, owner, 'Conversation');
    const key = randomUUID();
    const input = { content: '当前北京时间', historyHours: 24 };
    const first = await submitAgentMessage(infra, owner, session.id, key, input);
    expect(first.task.status).toBe('queued');
    expect((await getAgentSession(infra, owner, session.id))?.messages).toHaveLength(1);
    expect((await submitAgentMessage(infra, owner, session.id, key, input)).task.id).toBe(
      first.task.id,
    );
    const old = (await claimAgentTask(infra, 'conversation-old', first.task.id))!;
    await saveAgentStep(infra, first.task.id, 'conversation-old', old.generation, {
      key: 'clock_snapshot',
      name: '平台时间快照',
      input: null,
      output: {
        instant: '2026-10-11T18:23:45.000Z',
        timeZone: 'Asia/Shanghai',
        status: 'available',
      },
    });
    await infra.pool.query(
      "UPDATE agent_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.task.id],
    );
    const recovered = (await claimAgentTask(infra, 'conversation-new', first.task.id))!;
    expect((await getAgentTaskContext(infra, first.task.id))?.steps).toHaveLength(1);
    const recoveredClock = {
      instant: '2026-10-12T01:02:03.000Z',
      timeZone: 'Asia/Shanghai',
      status: 'available',
    };
    expect(
      await saveAgentStep(infra, first.task.id, 'conversation-new', recovered.generation, {
        key: 'clock_snapshot',
        name: '平台时间快照',
        input: null,
        output: recoveredClock,
      }),
    ).toBe(true);
    expect((await getAgentTaskContext(infra, first.task.id))?.steps[0]?.output).toEqual(
      recoveredClock,
    );
    expect(
      await finishAgentTask(infra, first.task.id, 'conversation-old', old.generation, {
        status: 'completed',
        summary: '迟到回复',
      }),
    ).toBe(false);
    const outcome = {
      status: 'completed' as const,
      summary: '北京时间为 2026-10-12 09:02:03。',
      summaryResultVersion: 0,
    };
    expect(
      await finishAgentTask(
        infra,
        first.task.id,
        'conversation-new',
        recovered.generation,
        outcome,
      ),
    ).toBe(true);
    expect(
      await finishAgentTask(
        infra,
        first.task.id,
        'conversation-new',
        recovered.generation,
        outcome,
      ),
    ).toBe(false);
    const saved = await getAgentSession(infra, owner, session.id);
    expect(saved?.messages).toHaveLength(2);
    expect(saved?.tasks[0]?.resultVersion).toBe(0);
    expect(saved?.tasks[0]?.summaryResultVersion).toBe(0);
    expect(saved?.messages[1]?.content).toBe(outcome.summary);
  });
  it('preserves missing-region analysis across consecutive greetings before continuation', async () => {
    const session = await createAgentSession(infra, owner, 'Continue analysis');
    const analysis = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析低速活动与公告关联',
      historyHours: 24,
    });
    for (const content of ['你好', '您好', '你能做什么']) {
      const greeting = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content,
        historyHours: 24,
      });
      expect(greeting.task.status).toBe('queued');
      const claimed = (await claimAgentTask(infra, 'greeting-worker', greeting.task.id))!;
      await finishAgentTask(infra, greeting.task.id, 'greeting-worker', claimed.generation, {
        status: 'completed',
        summary: '您好。',
      });
    }
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    expect((await getPreviousAgentTask(infra, next.task.id))?.task.id).toBe(analysis.task.id);
  });
  it('preserves persisted analysis evidence across consecutive greetings and applies reuse fence', async () => {
    const session = await createAgentSession(infra, owner, 'Explain analysis');
    const analysis = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析低速活动与公告关联',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const claimed = (await claimAgentTask(infra, 'analysis-worker', analysis.task.id))!;
    await setAgentDefinition(
      infra,
      analysis.task.id,
      'analysis-worker',
      claimed.generation,
      'area-low-speed-notice',
    );
    await saveAgentResults(infra, analysis.task.id, 'analysis-worker', claimed.generation, []);
    await finishAgentTask(infra, analysis.task.id, 'analysis-worker', claimed.generation, {
      status: 'completed',
      summary: '观测事实：无匹配结果。',
      summaryResultVersion: 1,
    });
    for (const content of ['你好', '当前北京时间']) {
      const greeting = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content,
        historyHours: 24,
      });
      const greetingClaim = (await claimAgentTask(infra, 'greeting-worker', greeting.task.id))!;
      await finishAgentTask(infra, greeting.task.id, 'greeting-worker', greetingClaim.generation, {
        status: 'completed',
        summary: '模型回复。',
      });
    }
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '解释上次证据',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    expect((await getPreviousAgentTask(infra, next.task.id))?.task.id).toBe(analysis.task.id);
    const nextClaim = (await claimAgentTask(infra, 'explain-worker', next.task.id))!;
    expect(
      (
        await reusePreviousAgentTask(
          infra,
          next.task.id,
          'explain-worker',
          nextClaim.generation,
          analysis.task.id,
        )
      )?.resultVersion,
    ).toBe(1);
  });
  it('unknown business requests remain the immediate analysis predecessor', async () => {
    const session = await createAgentSession(infra, owner, 'Unknown predecessor');
    await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析低速活动',
      historyHours: 24,
    });
    const unknown = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '另一个业务目标',
      historyHours: 24,
    });
    await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '你好',
      historyHours: 24,
    });
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    expect((await getPreviousAgentTask(infra, next.task.id))?.task.id).toBe(unknown.task.id);
  });
  it('fences expired leases and prevents a late completion after cancellation', async () => {
    const session = await createAgentSession(infra, owner, 'Task');
    const { task } = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const first = (await claimAgentTask(infra, 'worker-a', task.id))!;
    expect(await claimAgentTask(infra, 'worker-b', task.id)).toBeNull();
    await infra.pool.query(
      "UPDATE agent_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [task.id],
    );
    const second = (await claimAgentTask(infra, 'worker-b', task.id))!;
    expect(second.generation).toBe(first.generation + 1);
    expect(await renewAgentTask(infra, task.id, 'worker-a', first.generation)).toBe(false);
    expect(
      await saveAgentStep(infra, task.id, 'worker-a', first.generation, {
        key: 'stale',
        name: 'test',
        input: {},
        output: {},
      }),
    ).toBe(false);
    expect(await cancelAgentTask(infra, other, task.id)).toBeNull();
    await cancelAgentTask(infra, owner, task.id);
    expect(
      await finishAgentTask(infra, task.id, 'worker-b', second.generation, {
        status: 'completed',
        summary: 'late',
      }),
    ).toBe(false);
    expect((await getAgentTaskContext(infra, task.id))?.task.status).toBe('cancelled');
    const events = await readAgentEvents(infra, owner, session.id, '0', 200);
    expect(events?.items.some((e) => e.type === 'task.cancelled')).toBe(true);
  });
  it('persists budgets and revokes execution when owner loses write permission', async () => {
    const session = await createAgentSession(infra, owner, 'Budget');
    const { task } = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const claim = (await claimAgentTask(infra, 'worker', task.id))!;
    expect(await reserveAgentCall(infra, task.id, 'worker', claim.generation, 'model', 1)).toBe(
      true,
    );
    expect(await reserveAgentCall(infra, task.id, 'worker', claim.generation, 'model', 1)).toBe(
      false,
    );
    await infra.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [owner]);
    expect(await renewAgentTask(infra, task.id, 'worker', claim.generation)).toBe(false);
    expect(
      await saveAgentStep(infra, task.id, 'worker', claim.generation, {
        key: 'revoked',
        name: 'test',
        input: {},
        output: {},
      }),
    ).toBe(false);
    await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
    await cancelAgentTask(infra, owner, task.id);
  });
  it('enforces authenticated API ownership, viewer read-only access, CSRF and feature flag', async () => {
    const http = api.app.getHttpServer();
    const ownerAuth = credentials.get(owner)!;
    const otherAuth = credentials.get(other)!;
    const viewerAuth = credentials.get(viewer)!;
    const created = await request(http)
      .post('/api/v1/agent/sessions')
      .set('Cookie', ownerAuth.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', ownerAuth.csrf)
      .send({ title: 'API permission test' })
      .expect(201);
    const path = `/api/v1/agent/sessions/${created.body.id}`;
    await request(http).get(path).set('Cookie', otherAuth.cookie).expect(404);
    await request(http).get(`${path}/events`).set('Cookie', otherAuth.cookie).expect(404);
    await request(http)
      .post('/api/v1/agent/sessions')
      .set('Cookie', viewerAuth.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', viewerAuth.csrf)
      .send({ title: 'Denied' })
      .expect(403);
    await request(http)
      .post(`${path}/messages`)
      .set('Cookie', ownerAuth.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('Idempotency-Key', randomUUID())
      .send({ content: 'analysis' })
      .expect(403);
    const submitted = await request(http)
      .post(`${path}/messages`)
      .set('Cookie', ownerAuth.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', ownerAuth.csrf)
      .set('Idempotency-Key', randomUUID())
      .send({ content: '分析港口限制', bbox: [120, 20, 122, 22] })
      .expect(202);
    await request(http)
      .get(`/api/v1/agent/tasks/${submitted.body.task.id}`)
      .set('Cookie', otherAuth.cookie)
      .expect(404);
    await request(http)
      .post(`/api/v1/agent/tasks/${submitted.body.task.id}/cancel`)
      .set('Cookie', otherAuth.cookie)
      .set('Origin', 'http://127.0.0.1:13001')
      .set('X-CSRF-Token', otherAuth.csrf)
      .expect(404);
    const events = await request(http)
      .get(`${path}/events`)
      .set('Cookie', ownerAuth.cookie)
      .expect(200);
    expect(events.body.items).toHaveLength(1);
    const resumed = await request(http)
      .get(`${path}/events?cursor=${events.body.nextCursor}`)
      .set('Cookie', ownerAuth.cookie)
      .expect(200);
    expect(resumed.body.items).toHaveLength(0);
    process.env.AGENT_ENABLED = 'false';
    await request(http).get(path).set('Cookie', ownerAuth.cookie).expect(404);
    process.env.AGENT_ENABLED = 'true';
  });
  it('binds summaries and follow-up tasks to immutable result versions and original time windows', async () => {
    const session = await createAgentSession(infra, owner, 'Follow-up');
    const first = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      bbox: [120, 20, 122, 22],
      historyHours: 12,
    });
    const firstClaim = (await claimAgentTask(infra, 'worker', first.task.id))!;
    expect(await saveAgentResults(infra, first.task.id, 'worker', firstClaim.generation, [])).toBe(
      1,
    );
    expect(await saveAgentResults(infra, first.task.id, 'worker', firstClaim.generation, [])).toBe(
      1,
    );
    expect(
      await finishAgentTask(infra, first.task.id, 'worker', firstClaim.generation, {
        status: 'completed',
        summary: '无匹配',
        summaryResultVersion: 2,
      }),
    ).toBe(false);
    expect(
      await finishAgentTask(infra, first.task.id, 'worker', firstClaim.generation, {
        status: 'completed',
        summary: '无匹配',
        summaryResultVersion: 1,
      }),
    ).toBe(true);
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '解释之前的证据',
      bbox: [121, 21, 123, 23],
      historyHours: 24,
    });
    expect((await getPreviousAgentTask(infra, next.task.id))?.task.id).toBe(first.task.id);
    const nextClaim = (await claimAgentTask(infra, 'worker', next.task.id))!;
    const reused = await reusePreviousAgentTask(
      infra,
      next.task.id,
      'worker',
      nextClaim.generation,
      first.task.id,
    );
    expect(reused).toMatchObject({
      from: first.task.from,
      to: first.task.to,
      bbox: first.task.bbox,
      historyHours: 12,
      resultVersion: 1,
    });
    await cancelAgentTask(infra, owner, next.task.id);
    expect(
      await saveAgentResults(infra, next.task.id, 'worker', nextClaim.generation, []),
    ).toBeNull();
    const events = (await readAgentEvents(infra, owner, session.id, '0', 200))!;
    expect(events.items.some((item) => item.type === 'results.discarded')).toBe(true);
    expect((await getAgentTaskContext(infra, next.task.id))?.task.status).toBe('cancelled');
  });
  it('continues the immediate partial task instead of an older completed algorithm', async () => {
    const session = await createAgentSession(infra, owner, 'Partial continuation');
    const tasks = [];
    for (const [definition, status] of [
      ['port-restriction', 'completed'],
      ['area-low-speed-notice', 'awaiting_input'],
    ] as const) {
      const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: definition,
        bbox: [120, 20, 122, 22],
        historyHours: 24,
      });
      const claim = (await claimAgentTask(infra, 'worker', submitted.task.id))!;
      await setAgentDefinition(infra, claim.id, 'worker', claim.generation, definition);
      await saveAgentResults(infra, claim.id, 'worker', claim.generation, []);
      await finishAgentTask(infra, claim.id, 'worker', claim.generation, {
        status,
        summary: '已保存证据',
        summaryResultVersion: 1,
      });
      tasks.push(claim);
    }
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    expect((await getAgentTaskContext(infra, tasks[1]!.id))?.task.status).toBe('awaiting_input');
    expect((await getPreviousAgentTask(infra, next.task.id))?.task.id).toBe(tasks[1]!.id);
    const claim = (await claimAgentTask(infra, 'worker', next.task.id))!;
    expect(
      await reusePreviousAgentTask(infra, claim.id, 'worker', claim.generation, tasks[0]!.id),
    ).toBeNull();
    expect(
      await reusePreviousAgentTask(infra, claim.id, 'worker', claim.generation, tasks[1]!.id),
    ).toMatchObject({ definitionId: 'area-low-speed-notice', resultVersion: 1 });
    await cancelAgentTask(infra, owner, tasks[1]!.id);
    expect(await getPreviousAgentTask(infra, next.task.id)).toBeNull();
    expect(
      await reusePreviousAgentTask(infra, claim.id, 'worker', claim.generation, tasks[1]!.id),
    ).toBeNull();
    await cancelAgentTask(infra, owner, next.task.id);
  });
  it('does not skip an unfinished latest task to reuse an older completed result', async () => {
    const session = await createAgentSession(infra, owner, 'No historical fallback');
    const first = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '港口',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const claim = (await claimAgentTask(infra, 'worker', first.task.id))!;
    await setAgentDefinition(infra, claim.id, 'worker', claim.generation, 'port-restriction');
    await saveAgentResults(infra, claim.id, 'worker', claim.generation, []);
    await finishAgentTask(infra, claim.id, 'worker', claim.generation, { status: 'completed' });
    const pending = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '低速',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    expect(await getPreviousAgentTask(infra, next.task.id)).toBeNull();
    await cancelAgentTask(infra, owner, pending.task.id);
    expect(await getPreviousAgentTask(infra, next.task.id)).toBeNull();
  });
  it('answers consecutive structured requests on the same task with idempotency and snapshot recovery', async () => {
    const session = await createAgentSession(infra, owner, 'Structured input');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '帮助我处理任务',
      historyHours: 24,
    });
    const first = submitted.pendingInputRequests[0]!;
    expect(first.fields).toContain('goal');
    const key = randomUUID();
    const response = {
      action: 'accept' as const,
      inputRevision: 0,
      values: { purpose: 'vessel_list' as const },
    };
    const accepted = await respondAgentInput(
      infra,
      owner,
      submitted.task.id,
      first.id,
      key,
      response,
    );
    expect(accepted.task).toMatchObject({
      id: submitted.task.id,
      status: 'queued',
      inputRevision: 1,
      intent: 'vessel_list',
    });
    expect(
      await respondAgentInput(infra, owner, submitted.task.id, first.id, key, response),
    ).toEqual(accepted);
    await expect(
      respondAgentInput(infra, owner, submitted.task.id, first.id, randomUUID(), response),
    ).rejects.toMatchObject({ code: 'conflict' });
    const claimed = (await claimAgentTask(infra, 'round-two', submitted.task.id))!;
    expect(
      await requestAgentInput(infra, claimed.id, 'round-two', claimed.generation, {
        fields: ['region'],
        reason: 'missing_region',
      }),
    ).toBe(true);
    expect(await renewAgentTask(infra, claimed.id, 'round-two', claimed.generation)).toBe(false);
    const snapshot = (await getAgentSession(infra, owner, session.id))!;
    const second = snapshot.pendingInputRequests[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.pauseGeneration).toBe(claimed.generation);
    expect(
      (await readAgentEvents(infra, owner, session.id, snapshot.snapshotCursor))?.items,
    ).toEqual([]);
    const greeting = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '你好',
      historyHours: 24,
    });
    expect(
      (await getAgentSession(infra, owner, session.id))?.pendingInputRequests.map((r) => r.id),
    ).toContain(second.id);
    const answers = await Promise.allSettled(
      [120, 121].map((west) =>
        respondAgentInput(infra, owner, claimed.id, second.id, randomUUID(), {
          action: 'accept',
          inputRevision: 1,
          values: { bbox: [west, 20, 122, 22] },
        }),
      ),
    );
    expect(answers.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(answers.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect((await getAgentTaskContext(infra, claimed.id))?.task.inputRevision).toBe(2);
    await cancelAgentTask(infra, owner, claimed.id);
    await cancelAgentTask(infra, owner, greeting.task.id);
  });
  it('versions changed inputs and results, rejects stale workers and retries with an independent budget', async () => {
    const session = await createAgentSession(infra, owner, 'Revision results');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析区域低速活动',
      bbox: [120, 20, 122, 22],
      historyHours: 24,
    });
    const claim = (await claimAgentTask(infra, 'revision', submitted.task.id))!;
    await saveAgentStep(infra, claim.id, 'revision', claim.generation, {
      key: 'input_snapshot',
      name: 'snapshot',
      input: null,
      output: { old: true },
    });
    expect(await saveAgentResults(infra, claim.id, 'revision', claim.generation, [])).toBe(1);
    await requestAgentInput(infra, claim.id, 'revision', claim.generation, {
      fields: ['region'],
      reason: 'data_limit',
    });
    const pending = (await getAgentTaskContext(infra, claim.id))!.pendingInputRequests[0]!;
    const answered = await respondAgentInput(infra, owner, claim.id, pending.id, randomUUID(), {
      action: 'accept',
      inputRevision: 0,
      values: { bbox: [120, 20, 121, 21] },
    });
    expect(answered.task).toMatchObject({
      resultVersion: 1,
      resultInputRevision: 0,
      inputRevision: 1,
    });
    expect((await getAgentTaskContext(infra, claim.id))?.steps).toEqual([]);
    const renewed = (await claimAgentTask(infra, 'revision-new', claim.id))!;
    expect(await saveAgentResults(infra, claim.id, 'revision', claim.generation, [])).toBeNull();
    await saveAgentStep(infra, claim.id, 'revision-new', renewed.generation, {
      key: 'input_snapshot',
      name: 'snapshot',
      input: null,
      output: { new: true },
    });
    expect(await saveAgentResults(infra, claim.id, 'revision-new', renewed.generation, [])).toBe(2);
    await reserveAgentCall(infra, claim.id, 'revision-new', renewed.generation, 'model', 1);
    await finishAgentTask(infra, claim.id, 'revision-new', renewed.generation, {
      status: 'failed',
      error: 'budget exhausted',
      errorCode: 'budget_exhausted',
    });
    const key = randomUUID();
    const retried = await retryAgentTask(infra, owner, claim.id, key);
    expect(retried.task).toMatchObject({
      retryOfTaskId: claim.id,
      modelCalls: 0,
      toolCalls: 0,
      inputRevision: 0,
      resultVersion: 1,
      resultInputRevision: 0,
      from: answered.task.from,
      to: answered.task.to,
    });
    expect((await getAgentTaskContext(infra, retried.task.id))?.steps[0]?.output).toEqual({
      new: true,
    });
    expect((await retryAgentTask(infra, owner, claim.id, key)).task.id).toBe(retried.task.id);
    expect(
      (
        await infra.pool.query(
          'SELECT version,input_revision FROM agent_results WHERE task_id=$1 ORDER BY version',
          [claim.id],
        )
      ).rows,
    ).toEqual([
      { version: 1, input_revision: 0 },
      { version: 2, input_revision: 1 },
    ]);
    await cancelAgentTask(infra, owner, retried.task.id);
  });
  it('supports legacy waiting-task retries but requires new pending requests to be answered or declined', async () => {
    const session = await createAgentSession(infra, owner, 'Legacy waiting task');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      historyHours: 24,
    });
    await expect(
      retryAgentTask(infra, owner, submitted.task.id, randomUUID()),
    ).rejects.toMatchObject({ code: 'conflict' });
    // Simulate an upgraded pre-014 waiting task, which has no structured request record.
    await infra.pool.query('DELETE FROM agent_input_requests WHERE task_id=$1', [
      submitted.task.id,
    ]);
    await infra.pool.query(
      "UPDATE agent_tasks SET intent='unresolved',selection='{}' WHERE id=$1",
      [submitted.task.id],
    );
    const retried = await retryAgentTask(infra, owner, submitted.task.id, randomUUID());
    expect(retried.task).toMatchObject({
      intent: 'analysis',
      selection: { purpose: 'port-restriction' },
      retryOfTaskId: submitted.task.id,
    });
    expect(retried.task.selection?.timeRange).toEqual({
      from: submitted.task.from,
      to: submitted.task.to,
    });
    await cancelAgentTask(infra, owner, submitted.task.id);
    await cancelAgentTask(infra, owner, retried.task.id);
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      historyHours: 24,
    });
    const pending = next.pendingInputRequests[0]!;
    const key = randomUUID();
    const response = { action: 'decline' as const, inputRevision: 0 };
    const cancelled = await respondAgentInput(
      infra,
      owner,
      next.task.id,
      pending.id,
      key,
      response,
    );
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.request.status).toBe('cancelled');
    expect(await respondAgentInput(infra, owner, next.task.id, pending.id, key, response)).toEqual(
      cancelled,
    );
    await expect(
      respondAgentInput(infra, owner, next.task.id, pending.id, randomUUID(), {
        action: 'accept',
        inputRevision: 0,
        values: { bbox: [120, 20, 122, 22] },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects stale vessel candidates and permanently revokes pending input across permission restoration', async () => {
    const session = await createAgentSession(infra, owner, 'Revoked input');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '查看船舶基本信息',
      historyHours: 24,
    });
    const pending = submitted.pendingInputRequests[0]!;
    const absent = '999999998';
    expect(
      (await infra.pool.query('SELECT mmsi FROM vessels WHERE mmsi=$1', [absent])).rowCount,
    ).toBe(0);
    await expect(
      respondAgentInput(infra, owner, submitted.task.id, pending.id, randomUUID(), {
        action: 'accept',
        inputRevision: 0,
        values: { mmsis: [absent] },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(
      (await getAgentTaskContext(infra, submitted.task.id))?.pendingInputRequests,
    ).toHaveLength(1);
    const client = await infra.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE users SET role='viewer' WHERE id=$1", [owner]);
      await revokeAgentOwnerExecution(client, owner);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
    }
    expect((await getAgentTaskContext(infra, submitted.task.id))?.task).toMatchObject({
      status: 'failed',
      errorCode: 'permission_changed',
    });
    expect((await getAgentTaskContext(infra, submitted.task.id))?.pendingInputRequests).toEqual([]);
    await expect(
      respondAgentInput(infra, owner, submitted.task.id, pending.id, randomUUID(), {
        action: 'decline',
        inputRevision: 0,
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });
  it('stores empty query results and rejects invalid, cancelled or unauthorized input responses', async () => {
    const session = await createAgentSession(infra, owner, 'Query snapshot');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '当前视野有哪些船舶',
      historyHours: 24,
      mapContext: {
        bbox: [120, 20, 122, 22],
        capturedAt: new Date().toISOString(),
        hours: 6,
        sourceId: 'synthetic',
      },
    });
    expect(submitted.task).toMatchObject({
      status: 'queued',
      intent: 'vessel_list',
      selection: { bbox: [120, 20, 122, 22], filters: { hours: 6, sourceId: 'synthetic' } },
    });
    const claim = (await claimAgentTask(infra, 'query', submitted.task.id))!;
    expect(
      await saveAgentQueryResult(infra, claim.id, 'query', claim.generation, {
        kind: 'vessel_list',
        version: 0,
        inputRevision: 0,
        total: 0,
        truncated: false,
        items: [],
        asOf: new Date().toISOString(),
        selection: claim.selection!,
      }),
    ).toBe(1);
    expect((await getAgentTaskContext(infra, claim.id))?.queryResult).toMatchObject({
      version: 1,
      inputRevision: 0,
      total: 0,
    });
    await finishAgentTask(infra, claim.id, 'query', claim.generation, {
      status: 'completed',
      summary: '该区域暂无船舶。',
      summaryResultVersion: 1,
    });
    const another = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      historyHours: 24,
    });
    const pending = another.pendingInputRequests[0]!;
    const key = randomUUID();
    await expect(
      respondAgentInput(infra, owner, another.task.id, pending.id, key, {
        action: 'accept',
        inputRevision: 0,
        values: {
          bbox: [120, 20, 122, 22],
          timeRange: { from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await getAgentTaskContext(infra, another.task.id))?.pendingInputRequests).toHaveLength(
      1,
    );
    const answer = {
      action: 'accept' as const,
      inputRevision: 0,
      values: { bbox: [120, 20, 122, 22] as [number, number, number, number] },
    };
    await respondAgentInput(infra, owner, another.task.id, pending.id, key, answer);
    await infra.pool.query("UPDATE users SET role='viewer' WHERE id=$1", [owner]);
    try {
      await expect(
        respondAgentInput(infra, owner, another.task.id, pending.id, key, answer),
      ).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
    }
    await cancelAgentTask(infra, owner, another.task.id);
    const cancelled = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      historyHours: 24,
    });
    await cancelAgentTask(infra, owner, cancelled.task.id);
    await expect(
      respondAgentInput(
        infra,
        owner,
        cancelled.task.id,
        cancelled.pendingInputRequests[0]!.id,
        randomUUID(),
        answer,
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await getAgentTaskContext(infra, cancelled.task.id))?.pendingInputRequests).toEqual([]);
  });
  it('persists intelligence snapshots, message versions and historical windows across retry and reuse', async () => {
    const session = await createAgentSession(infra, owner, 'Intel snapshot');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '查询2024-01-01至2024-12-31港口公告',
      historyHours: 24,
    });
    expect(submitted.task.intent).toBe('intelligence_search');
    expect(submitted.task.status).toBe('queued');
    expect(submitted.task.selection?.intelligenceTimeRange?.from).toBe('2023-12-31T16:00:00.000Z');
    const claimed = (await claimAgentTask(infra, 'intel-worker', submitted.task.id))!;
    const snapshot: AgentIntelligenceResult = {
      kind: 'intelligence_search',
      version: 0,
      inputRevision: 0,
      asOf: new Date().toISOString(),
      spec: submitted.task.selection!.intelligenceQuery!,
      total: 0,
      truncated: false,
      evidence: [],
      sourceHealth: [],
      coverageNotes: ['本地覆盖说明'],
    };
    expect(
      await saveAgentIntelligenceResult(
        infra,
        claimed.id,
        'intel-worker',
        claimed.generation,
        snapshot,
      ),
    ).toBe(1);
    expect(
      await finishAgentTask(infra, claimed.id, 'intel-worker', claimed.generation, {
        status: 'completed',
        summary: '没有匹配记录',
        summaryResultVersion: 1,
      }),
    ).toBe(true);
    const message = (await getAgentSession(infra, owner, session.id))!.messages.find(
      (m) => m.role === 'assistant',
    )!;
    expect(message).toMatchObject({ resultVersion: 1, inputRevision: 0 });
    expect(
      (await getOwnedAgentTask(infra, owner, claimed.id, 1))?.intelligenceResult,
    ).toMatchObject({ version: 1, inputRevision: 0 });
    expect(await getOwnedAgentTask(infra, owner, claimed.id, 2)).toBeNull();
    const explanation = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '解释上次结果',
      historyHours: 24,
    });
    const worker = (await claimAgentTask(infra, 'intel-explain', explanation.task.id))!;
    expect(
      await reusePreviousAgentTask(
        infra,
        worker.id,
        'intel-explain',
        worker.generation,
        claimed.id,
      ),
    ).not.toBeNull();
    expect((await getAgentTaskContext(infra, worker.id))?.intelligenceResult).toMatchObject({
      version: 1,
      inputRevision: 0,
      spec: snapshot.spec,
    });
    const retry = await retryAgentTask(infra, owner, claimed.id, randomUUID());
    expect((await getAgentTaskContext(infra, retry.task.id))?.intelligenceResult).toMatchObject({
      version: 1,
      inputRevision: 0,
      spec: snapshot.spec,
    });
  });
  it('pins weather evidence for save and retry, and refuses a snapshot whose archive was collected', async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await infra.pool.query("INSERT INTO intelligence_sources(id,config) VALUES($1,'{}')", [id]);
    await infra.pool.query(
      "INSERT INTO intelligence_archives(id,source_id,object_key,checksum,bytes,content_type) VALUES($1,$1,$1,'fixture',1,'application/json')",
      [id],
    );
    await infra.pool.query(
      "INSERT INTO intelligence_weather_snapshots(id,source_id,point_id,fetched_at,valid_from,valid_to,archive_id,data) VALUES($1,$1,'bohai',$2,$2,$2,$1,'{}')",
      [id, now],
    );
    try {
      const session = await createAgentSession(infra, owner, 'Marine');
      const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: '未来三天渤海浪高',
        historyHours: 24,
      });
      const claimed = (await claimAgentTask(infra, 'marine-worker', submitted.task.id))!;
      const result: AgentIntelligenceResult = {
        kind: 'intelligence_search',
        version: 0,
        inputRevision: 0,
        asOf: now,
        spec: { kind: 'marine' },
        total: 1,
        truncated: false,
        evidence: [
          {
            kind: 'marine',
            reference: 'I1',
            forecast: {
              id,
              sourceId: id,
              samplePointId: 'bohai',
              pointName: '渤海代表点',
              point: { lon: 120, lat: 39 },
              grid: { lon: 120, lat: 39 },
              fetchedAt: now,
              modelPublishedAt: null,
              validFrom: now,
              validTo: now,
              series: [{ validAt: now, waveHeight: 1, waveDirection: 90, wavePeriod: 5 }],
              originalArchiveId: id,
              originalUrl: 'https://example.com',
              visibility: 'public',
            },
          },
        ],
        sourceHealth: [],
        coverageNotes: [],
      };
      await expect(
        saveAgentIntelligenceResult(infra, claimed.id, 'marine-worker', claimed.generation, {
          ...result,
          evidence: [
            {
              ...result.evidence[0]!,
              kind: 'marine',
              forecast: {
                ...(
                  result.evidence[0] as Extract<
                    (typeof result.evidence)[number],
                    { kind: 'marine' }
                  >
                ).forecast,
                id: 'missing-archive',
              },
            },
          ],
        }),
      ).rejects.toMatchObject({ code: 'conflict' });
      expect((await getAgentTaskContext(infra, claimed.id))?.task.resultVersion).toBe(0);
      await saveAgentIntelligenceResult(
        infra,
        claimed.id,
        'marine-worker',
        claimed.generation,
        result,
      );
      await finishAgentTask(infra, claimed.id, 'marine-worker', claimed.generation, {
        status: 'completed',
        summary: '海况 [I1]',
        summaryResultVersion: 1,
      });
      const retry = await retryAgentTask(infra, owner, claimed.id, randomUUID());
      const pins = await infra.pool.query(
        'SELECT task_id,input_revision FROM intelligence_weather_pins WHERE snapshot_id=$1',
        [id],
      );
      expect(pins.rows).toEqual(
        expect.arrayContaining([
          { task_id: claimed.id, input_revision: 0 },
          { task_id: retry.task.id, input_revision: 0 },
        ]),
      );
      await expect(
        infra.pool.query('DELETE FROM intelligence_weather_snapshots WHERE id=$1', [id]),
      ).rejects.toMatchObject({ code: '23503' });
    } finally {
      await infra.pool.query('DELETE FROM intelligence_weather_pins WHERE snapshot_id=$1', [id]);
      await infra.pool.query('DELETE FROM intelligence_weather_snapshots WHERE id=$1', [id]);
      await infra.pool.query('DELETE FROM intelligence_archives WHERE id=$1', [id]);
      await infra.pool.query('DELETE FROM intelligence_sources WHERE id=$1', [id]);
    }
  });
  it('does not inherit an old analysis bbox for a new named or global intelligence search', async () => {
    const session = await createAgentSession(infra, owner, 'Scope');
    const oldBbox: [number, number, number, number] = [10, 10, 11, 11];
    const named = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '东海有哪些新闻',
      bbox: oldBbox,
      historyHours: 24,
    });
    expect(named.task.selection?.bbox).toEqual([120, 23, 130, 34]);
    expect(named.task.selection?.intelligenceQuery?.bbox).toEqual([120, 23, 130, 34]);
    const global = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '最近有哪些新闻',
      bbox: oldBbox,
      historyHours: 24,
    });
    expect(global.task.selection?.bbox).toBeUndefined();
    expect(global.task.selection?.intelligenceQuery?.bbox).toBeUndefined();
    const selected = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '这个区域有哪些新闻',
      bbox: oldBbox,
      historyHours: 24,
    });
    expect(selected.task.selection?.intelligenceQuery?.bbox).toEqual(oldBbox);
  });
  it('persists unclear intelligence time as a request and clears it only after an explicit range', async () => {
    const session = await createAgentSession(infra, owner, 'Unclear time');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '去年春节有哪些新闻',
      historyHours: 24,
    });
    expect(submitted.task.status).toBe('awaiting_input');
    expect(submitted.pendingInputRequests[0]).toMatchObject({
      fields: ['time'],
      reason: 'missing_time',
    });
    const pending = submitted.pendingInputRequests[0]!;
    const answered = await respondAgentInput(
      infra,
      owner,
      submitted.task.id,
      pending.id,
      randomUUID(),
      {
        action: 'accept',
        inputRevision: pending.inputRevision,
        values: {
          intelligenceTimeRange: { from: '2025-01-01T00:00:00Z', to: '2025-03-01T00:00:00Z' },
        },
      },
    );
    expect(answered.task.status).toBe('queued');
    expect(answered.task.selection?.intelligenceTimeUnclear).toBeUndefined();
    expect(answered.task.selection?.intelligenceTimeRange).toEqual({
      from: '2025-01-01T00:00:00Z',
      to: '2025-03-01T00:00:00Z',
    });
  });
  it('accepts forecast fields from the time dialog and replaces an old generic intelligence range', async () => {
    const session = await createAgentSession(infra, owner, 'Marine time clarification');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '去年春节渤海海况',
      historyHours: 24,
    });
    const pending = submitted.pendingInputRequests[0]!;
    expect(pending.fields).toEqual(['time']);
    await infra.pool.query('UPDATE agent_tasks SET selection=selection || $2::jsonb WHERE id=$1', [
      submitted.task.id,
      JSON.stringify({
        intelligenceTimeRange: { from: '2025-01-01T00:00:00Z', to: '2025-01-02T00:00:00Z' },
      }),
    ]);
    const forecastFrom = '2026-10-14T00:00:00Z',
      forecastTo = '2026-10-15T00:00:00Z';
    const answered = await respondAgentInput(
      infra,
      owner,
      submitted.task.id,
      pending.id,
      randomUUID(),
      {
        action: 'accept',
        inputRevision: pending.inputRevision,
        values: {
          intelligenceQuery: { kind: 'marine', samplePointId: 'bohai', forecastFrom, forecastTo },
        },
      },
    );
    expect(answered.task.status).toBe('queued');
    expect(answered.task.selection?.intelligenceTimeUnclear).toBeUndefined();
    expect(answered.task.selection?.intelligenceTimeRange).toEqual({
      from: forecastFrom,
      to: forecastTo,
    });
    expect(answered.task.selection?.intelligenceQuery).toMatchObject({
      kind: 'marine',
      forecastFrom,
      forecastTo,
    });
  });
  it('honors an explicit events topic over stale marine fields in a clarification answer', async () => {
    const session = await createAgentSession(infra, owner, 'Switch forecast to events');
    const submitted = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '去年渤海海况',
      historyHours: 24,
    });
    const pending = submitted.pendingInputRequests[0]!;
    const from = '2025-01-01T00:00:00Z',
      to = '2025-02-01T00:00:00Z';
    const answered = await respondAgentInput(
      infra,
      owner,
      submitted.task.id,
      pending.id,
      randomUUID(),
      {
        action: 'accept',
        inputRevision: pending.inputRevision,
        values: {
          intelligenceQuery: {
            kind: 'events',
            from,
            to,
            forecastFrom: '2026-10-14T00:00:00Z',
            forecastTo: '2026-10-15T00:00:00Z',
          },
        },
      },
    );
    expect(answered.task.status).toBe('queued');
    expect(answered.task.selection?.intelligenceTimeUnclear).toBeUndefined();
    expect(answered.task.selection?.intelligenceTimeRange).toEqual({ from, to });
    expect(answered.task.selection?.intelligenceQuery).toMatchObject({ kind: 'events', from, to });
    expect(answered.task.selection?.intelligenceQuery?.forecastFrom).toBeUndefined();
    expect(answered.task.selection?.intelligenceQuery?.forecastTo).toBeUndefined();
  });
  it('resolves registered object aliases locally and fences ambiguous or stale answers', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const suffix = randomUUID().slice(0, 8);
    const unique = '独有港' + suffix,
      shared = '重名港' + suffix;
    for (let i = 0; i < ids.length; i++)
      await infra.pool.query(
        "INSERT INTO intelligence_objects(id,kind,name,data) VALUES($1,'port',$2,$3::jsonb)",
        [
          ids[i],
          '审计港' + suffix + i,
          JSON.stringify({
            aliases: i === 0 ? [unique, shared] : i === 1 ? [shared] : ['其他港' + suffix],
          }),
        ],
      );
    try {
      const session = await createAgentSession(infra, owner, 'Object clarification');
      const direct = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: unique + '有哪些新闻',
        historyHours: 24,
      });
      expect(direct.task.status).toBe('queued');
      expect(direct.task.selection?.intelligenceQuery?.objectId).toBe(ids[0]);
      expect(direct.task.selection?.intelligenceQuery?.keyword).toBeUndefined();
      const ambiguous = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: shared + '有哪些新闻',
        historyHours: 24,
      });
      const pending = ambiguous.pendingInputRequests[0]!;
      expect(pending.fields).toContain('topic');
      expect(ambiguous.task.selection?.intelligenceObjectCandidates).toHaveLength(2);
      await expect(
        respondAgentInput(infra, owner, ambiguous.task.id, pending.id, randomUUID(), {
          action: 'accept',
          inputRevision: 0,
          values: {
            intelligenceQuery: { kind: 'events', objectId: ids[2] },
            intelligenceObjectUnclear: false,
            intelligenceObjectCandidates: [{ id: ids[2]!, name: '伪造候选' }],
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      await infra.pool.query('DELETE FROM intelligence_objects WHERE id=$1', [ids[0]]);
      await expect(
        respondAgentInput(infra, owner, ambiguous.task.id, pending.id, randomUUID(), {
          action: 'accept',
          inputRevision: 0,
          values: { intelligenceQuery: { kind: 'events', objectId: ids[0] } },
        }),
      ).rejects.toMatchObject({ code: 'invalid_input' });
      const answered = await respondAgentInput(
        infra,
        owner,
        ambiguous.task.id,
        pending.id,
        randomUUID(),
        {
          action: 'accept',
          inputRevision: 0,
          values: { intelligenceQuery: { kind: 'events', objectId: ids[1] } },
        },
      );
      expect(answered.task.status).toBe('queued');
      expect(answered.task.selection?.intelligenceObjectUnclear).toBeUndefined();
      expect(answered.task.selection?.intelligenceObjectCandidates).toBeUndefined();
      expect(answered.task.selection?.intelligenceQuery?.objectId).toBe(ids[1]);
    } finally {
      await infra.pool.query('DELETE FROM intelligence_objects WHERE id=ANY($1::text[])', [ids]);
    }
  });
});
