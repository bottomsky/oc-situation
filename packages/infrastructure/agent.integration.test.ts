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
      content: '分析',
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
      content: '分析',
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
});
