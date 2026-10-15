import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import { hashToken } from '../../apps/api/src/auth/security';
import { ensureAgentBus, runAgentWorker } from '../../apps/agent';
import {
  createInfrastructure,
  runMigrations,
  saveHistoryBatch,
  type Infrastructure,
} from '../../packages/infrastructure';
import {
  claimAgentTask,
  finishAgentTask,
  requestAgentInput,
  reusePreviousAgentTask,
  saveAgentHeatmapResult,
} from '../../packages/infrastructure/agent';
import type {
  AgentInputRequest,
  AgentTask,
  AgentStep,
  PositionObservation,
} from '../../packages/contracts';
import type { AgentHeatmapResult } from '../../packages/contracts/heatmap';

describe('heatmap through real API, PostgreSQL, ClickHouse and NATS worker', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  let cookie: string;
  let csrf: string;
  const owner = randomUUID();
  const administrator = randomUUID();
  const password = randomUUID();
  const origin = 'http://127.0.0.1:13011';
  const loginIp = `198.18.71.${randomInt(1, 255)}`;
  const sourceId = `heatmap-flow-${randomUUID()}`;
  const firstMmsi = 970000000 + Math.floor(Math.random() * 999999);
  const mmsis = [String(firstMmsi), String(firstMmsi + 1)];
  const bbox: [number, number, number, number] = [120, 20, 121, 21];
  const from = new Date(Date.now() - 3_600_000).toISOString();
  const to = new Date(Date.now() - 60_000).toISOString();
  const goal = `生成当前视野 ${from} 至 ${to} 的 AIS 热力图`;
  const mapContext = { bbox, sourceId, capturedAt: new Date().toISOString() };
  const previousEnabled = process.env.AGENT_ENABLED;
  let workerAbort: AbortController;
  let worker: Promise<void> | undefined;
  let workerError: unknown;
  let providerCalls = 0;

  function startWorker() {
    workerAbort = new AbortController();
    workerError = undefined;
    worker = runAgentWorker(infra, workerAbort.signal, {
      enabled: true,
      apiKey: 'heatmap-test-forbidden-provider',
      maxRecords: 50_000,
      fetch: async () => {
        providerCalls++;
        throw new Error('Heatmap must never call a model provider');
      },
    }).catch((error: unknown) => {
      workerError = error;
    });
  }
  async function stopWorker() {
    workerAbort?.abort();
    await worker;
    worker = undefined;
  }
  function post(path: string, body: Record<string, unknown>, key = randomUUID()) {
    return request(api.app.getHttpServer())
      .post(`/api/v1/agent${path}`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', key)
      .send(body);
  }
  function get(path: string) {
    return request(api.app.getHttpServer()).get(`/api/v1/agent${path}`).set('Cookie', cookie);
  }
  async function login() {
    const response = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .set('X-Forwarded-For', loginIp)
      .send({ username: owner, password })
      .expect(200);
    cookie = (response.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    csrf = response.body.csrfToken;
  }
  async function submit(content = goal, extra: Record<string, unknown> = { mapContext }) {
    const session = await post('/sessions', { title: 'Heatmap integration verification' }).expect(
      201,
    );
    const message = await post(`/sessions/${session.body.id}/messages`, {
      content,
      ...extra,
    }).expect(202);
    return { taskId: message.body.task.id as string, sessionId: session.body.id as string };
  }
  async function waitTask(id: string, status: AgentTask['status']) {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (workerError) throw workerError;
      const response = await get(`/tasks/${id}`).expect(200);
      if (response.body.task.status === status) return response.body;
      if (response.body.task.status === 'failed')
        throw new Error(JSON.stringify(response.body.task));
      await delay(100);
    }
    throw new Error(`Task ${id} did not reach ${status}`);
  }
  async function complete() {
    const submitted = await submit();
    return { ...submitted, detail: await waitTask(submitted.taskId, 'completed') };
  }
  async function assertNoStoredResult(taskId: string) {
    const rows = await infra.pool.query('SELECT count(*) FROM agent_results WHERE task_id=$1', [
      taskId,
    ]);
    expect(Number(rows.rows[0].count)).toBe(0);
    const detail = await get(`/tasks/${taskId}`).expect(200);
    expect(detail.body.heatmapResult).toBeNull();
    expect(detail.body.task.summaryResultVersion).toBeNull();
  }

  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    await ensureAgentBus(infra);
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,'operator'),($3::uuid,$3::text,$2,'admin')",
      [owner, await hashPassword(password), administrator],
    );
    const positions: PositionObservation[] = [
      { mmsi: mmsis[0]!, lon: 120.2, lat: 20.2 },
      { mmsi: mmsis[0]!, lon: 120.2, lat: 20.2 },
      { mmsi: mmsis[0]!, lon: 120.8, lat: 20.8 },
      { mmsi: mmsis[1]!, lon: 120.2, lat: 20.2 },
    ].map((point, index) => ({
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: `${sourceId}-${index}`,
      captureId: `${sourceId}-capture`,
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      observedAt: new Date(Date.parse(from) + (index + 1) * 60_000).toISOString(),
      receivedAt: from,
      sogKnots: 1,
      cogDegrees: null,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'UNKNOWN',
      quality: ['synthetic'],
      ...point,
    }));
    await saveHistoryBatch(infra, positions);
    api = await createApi(infra, { scheduler: false, origins: [origin] });
    // Only this test server trusts its loopback transport to isolate suite login quotas.
    const adapter = api.app.getHttpAdapter().getInstance();
    adapter.set('trust proxy', 'loopback');
    expect(adapter.get('trust proxy fn')('127.0.0.1')).toBe(true);
    expect(adapter.get('trust proxy fn')(loginIp)).toBe(false);
    await login();
    startWorker();
  });

  afterAll(async () => {
    await stopWorker();
    await api?.stop();
    if (previousEnabled === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previousEnabled;
    if (!infra) return;
    await infra.pool.query(
      "DELETE FROM audit WHERE action='login_attempt' AND resource_type='authentication' AND resource_id=$1",
      [hashToken(loginIp)],
    );
    for (const table of [
      'agent_events',
      'agent_steps',
      'agent_results',
      'agent_messages',
      'agent_tasks',
    ]) {
      const where = ['agent_steps', 'agent_results'].includes(table)
        ? 'task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)'
        : table === 'agent_tasks'
          ? 'owner_id=$1'
          : 'session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)';
      await infra.pool.query(`DELETE FROM ${table} WHERE ${where}`, [owner]);
    }
    await infra.pool.query('DELETE FROM agent_sessions WHERE owner_id=$1', [owner]);
    await infra.pool.query('DELETE FROM audit WHERE user_id=ANY($1::uuid[])', [
      [owner, administrator],
    ]);
    await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[owner, administrator]]);
    for (const table of ['positions', 'quality_events_v2'])
      await infra.clickhouse.command({
        query: `ALTER TABLE ${table} DELETE WHERE sourceId={source:String}`,
        query_params: { source: sourceId },
        clickhouse_settings: { mutations_sync: '1' },
      });
    await infra.close();
  });

  it('rejects more than 100 explicit vessels with a visible limit and creates no task', async () => {
    const session = await post('/sessions', { title: 'Heatmap vessel limit' }).expect(201);
    const requestedMmsis = Array.from({ length: 101 }, (_, index) => String(413000000 + index));
    const response = await post(`/sessions/${session.body.id}/messages`, {
      content: `生成当前视野热力图：${requestedMmsis.join(' ')}`,
      mapContext,
    }).expect(400);
    expect(response.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: '热力图一次最多筛选 100 艘船舶，请缩小船舶范围后重试。',
        requestId: expect.any(String),
      },
    });
    const detail = await get(`/sessions/${session.body.id}`).expect(200);
    expect(detail.body.tasks).toEqual([]);
    expect(detail.body.messages).toEqual([]);
  });

  it.each(['昨天上午', '昨天8点到10点', '昨天到今天', '最近6小时之前'])(
    'asks for the complete time range of %s before executing',
    async (time) => {
      const { taskId } = await submit(`生成当前视野${time}的热力图`);
      const detail = await waitTask(taskId, 'awaiting_input');
      expect(detail.pendingInputRequests[0].fields).toEqual(['time']);
      expect(detail.task.toolCalls).toBe(0);
      expect(detail.task.modelCalls).toBe(0);
      expect(detail.heatmapResult).toBeNull();
    },
  );

  it('matches the manual heatmap API, deduplicates vessels and records a local skill execution', async () => {
    const { taskId, sessionId, detail } = await complete();
    const result = detail.heatmapResult as AgentHeatmapResult;
    expect(result.query).toEqual({ bbox, from, to, sourceId });
    expect(result.totalVessels).toBe(2);
    expect(result.cells).toHaveLength(2);
    expect(result.cells.map((cell) => cell.vesselCount).sort()).toEqual([1, 2]);
    const manual = await request(api.app.getHttpServer())
      .get('/api/v1/map/heatmap')
      .set('Cookie', cookie)
      .query({ bbox: bbox.join(','), from, to, sourceId })
      .expect(200);
    expect(result).toMatchObject(manual.body);
    expect(detail.task.modelCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(detail.task.summaryResultVersion).toBe(result.version);
    expect(detail.task.summaryInputRevision).toBe(result.inputRevision);
    expect(detail.task.toolCalls).toBe(3);
    expect(JSON.stringify(detail.steps)).toContain('ais-heatmap');
    const session = await get(`/sessions/${sessionId}`).expect(200);
    const summary = session.body.messages.find(
      (message: { role: string; taskId: string }) =>
        message.role === 'assistant' && message.taskId === taskId,
    );
    expect(summary.resultVersion).toBe(result.version);
    expect(summary.inputRevision).toBe(result.inputRevision);
  });

  it('persists an empty result as a successful query with an explicit empty summary', async () => {
    const { taskId } = await submit(goal, {
      mapContext: { ...mapContext, sourceId: `${sourceId}-empty` },
    });
    const detail = await waitTask(taskId, 'completed');
    expect(detail.heatmapResult.cells).toEqual([]);
    expect(detail.heatmapResult.totalVessels).toBe(0);
    expect(detail.task.summary).toContain('没有 AIS 数据');
    expect(detail.task.summaryResultVersion).toBe(1);
    expect(detail.task.modelCalls).toBe(0);
  });

  it('resumes missing region and ambiguous time on the same task with idempotent input', async () => {
    const { taskId, sessionId } = await submit('生成最近一段时间的 AIS 热力图', {});
    const waiting = await waitTask(taskId, 'awaiting_input');
    const input = waiting.pendingInputRequests[0] as AgentInputRequest;
    expect(input.fields).toEqual(expect.arrayContaining(['region', 'time']));
    expect(waiting.heatmapResult).toBeNull();
    const path = `/tasks/${taskId}/input-requests/${input.id}/responses`;
    const body = {
      action: 'accept',
      inputRevision: input.inputRevision,
      values: { bbox, timeRange: { from, to }, filters: { sourceId }, purpose: 'ais_heatmap' },
    };
    const key = randomUUID();
    await post(path, body, key).expect(200);
    const detail = await waitTask(taskId, 'completed');
    await post(path, body, key).expect(200);
    expect(detail.task.id).toBe(taskId);
    expect(detail.heatmapResult.inputRevision).toBe(1);
    expect(detail.heatmapResult.totalVessels).toBe(2);
    expect(detail.task.selection.heatmapTimeUnclear).toBeUndefined();
    expect(detail.pendingInputRequests).toEqual([]);
    expect((await get(`/sessions/${sessionId}`).expect(200)).body.tasks).toHaveLength(1);
    const events = await get(`/sessions/${sessionId}/events?cursor=0`).expect(200);
    expect(
      events.body.items.filter((event: { type: string }) => event.type === 'input.answered'),
    ).toHaveLength(1);
    expect(providerCalls).toBe(0);
  });

  it('explains and retries immutable snapshots without additional query or model calls', async () => {
    const { taskId, sessionId, detail } = await complete();
    const explanation = await post(`/sessions/${sessionId}/messages`, {
      content: '解释上次热力图',
    }).expect(202);
    const explained = await waitTask(explanation.body.task.id, 'completed');
    expect(explained.heatmapResult).toEqual(detail.heatmapResult);
    expect(explained.task.summary).toContain('已保存的热力图快照');
    expect(explained.task.toolCalls).toBe(0);
    expect(explained.task.modelCalls).toBe(0);
    expect(explained.task.summaryResultVersion).toBe(explained.heatmapResult.version);
    const key = randomUUID();
    const retry = await post(`/tasks/${taskId}/retry`, {}, key).expect(202);
    const retried = await waitTask(retry.body.task.id, 'completed');
    const replay = await post(`/tasks/${taskId}/retry`, {}, key).expect(202);
    expect(replay.body.task.id).toBe(retried.task.id);
    expect(retried.task.id).not.toBe(taskId);
    expect(retried.heatmapResult).toEqual(detail.heatmapResult);
    expect(retried.task.retryOfTaskId).toBe(taskId);
    expect(retried.task.toolCalls).toBe(1);
    const retrySteps = retried.steps as AgentStep[];
    expect(retrySteps.filter((step) => step.key.startsWith('skill:'))).toEqual([
      expect.objectContaining({
        key: 'skill:0:ais-heatmap:activate',
        output: expect.objectContaining({ kind: 'skill_activation' }),
      }),
    ]);
    expect(retrySteps.some((step) => step.key.startsWith('capability:'))).toBe(false);
    expect(retried.task.modelCalls).toBe(0);
    expect(retried.task.summaryResultVersion).toBe(1);
    expect(providerCalls).toBe(0);
  });

  it('retains version one after renewed input, returns exact history and clones the current snapshot', async () => {
    const original = await complete();
    await stopWorker();
    try {
      const { taskId, sessionId } = await submit();
      const workerId = randomUUID();
      const task = await claimAgentTask(infra, workerId, taskId);
      expect(task).not.toBeNull();
      const fence = [infra, taskId, workerId, task!.generation] as const;
      expect(await saveAgentHeatmapResult(...fence, original.detail.heatmapResult)).toBe(1);
      expect(
        await requestAgentInput(...fence, { fields: ['region'], reason: 'scope_changed' }),
      ).toBe(true);
      const waiting = await waitTask(taskId, 'awaiting_input');
      const input = waiting.pendingInputRequests[0] as AgentInputRequest;
      await post(`/tasks/${taskId}/input-requests/${input.id}/responses`, {
        action: 'accept',
        inputRevision: input.inputRevision,
        values: { bbox: [122, 22, 123, 23] },
      }).expect(200);
      startWorker();
      const completed = await waitTask(taskId, 'completed');
      expect(completed.heatmapResult.version).toBe(2);
      expect(completed.heatmapResult.totalVessels).toBe(0);
      expect(completed.task.summaryResultVersion).toBe(2);
      const historical = await get(`/tasks/${taskId}?resultVersion=1`).expect(200);
      expect(historical.body.heatmapResult).toEqual(original.detail.heatmapResult);
      await get(`/tasks/${taskId}?resultVersion=999`).expect(404);
      await get(`/tasks/${taskId}?resultVersion=0`).expect(400);
      await stopWorker();
      const child = await post(`/sessions/${sessionId}/messages`, {
        content: goal,
        mapContext,
      }).expect(202);
      const claimed = await claimAgentTask(infra, workerId, child.body.task.id);
      expect(claimed).not.toBeNull();
      const cloned = await reusePreviousAgentTask(
        infra,
        claimed!.id,
        workerId,
        claimed!.generation,
        taskId,
      );
      expect(cloned?.resultVersion).toBe(1);
      const cloneDetail = await get(`/tasks/${claimed!.id}`).expect(200);
      expect(cloneDetail.body.heatmapResult).toEqual({
        ...completed.heatmapResult,
        version: 1,
        inputRevision: 0,
      });
      expect(
        await finishAgentTask(infra, claimed!.id, workerId, claimed!.generation, {
          status: 'completed',
          summary: '复制已保存热力结果',
          summaryResultVersion: 2,
        }),
      ).toBe(false);
      expect(
        await finishAgentTask(infra, claimed!.id, workerId, claimed!.generation, {
          status: 'completed',
          summary: '复制已保存热力结果',
          summaryResultVersion: 1,
        }),
      ).toBe(true);
    } finally {
      if (!worker) startWorker();
    }
  });

  it('fences expired leases and old worker generations before result or summary writes', async () => {
    const original = await complete();
    await stopWorker();
    try {
      const { taskId } = await submit();
      const staleWorker = randomUUID();
      const stale = await claimAgentTask(infra, staleWorker, taskId);
      expect(stale).not.toBeNull();
      expect(
        await saveAgentHeatmapResult(infra, taskId, staleWorker, stale!.generation, {
          ...original.detail.heatmapResult,
          inputRevision: 1,
        }),
      ).toBeNull();
      await assertNoStoredResult(taskId);
      await infra.pool.query(
        "UPDATE agent_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
        [taskId],
      );
      expect(
        await saveAgentHeatmapResult(
          infra,
          taskId,
          staleWorker,
          stale!.generation,
          original.detail.heatmapResult,
        ),
      ).toBeNull();
      const currentWorker = randomUUID();
      const current = await claimAgentTask(infra, currentWorker, taskId);
      expect(current!.generation).toBeGreaterThan(stale!.generation);
      expect(
        await saveAgentHeatmapResult(
          infra,
          taskId,
          staleWorker,
          stale!.generation,
          original.detail.heatmapResult,
        ),
      ).toBeNull();
      expect(
        await finishAgentTask(infra, taskId, staleWorker, stale!.generation, {
          status: 'completed',
          summary: '过期摘要',
          summaryResultVersion: 1,
        }),
      ).toBe(false);
      await assertNoStoredResult(taskId);
      await post(`/tasks/${taskId}/cancel`, {}).expect(200);
      expect(
        await saveAgentHeatmapResult(
          infra,
          taskId,
          currentWorker,
          current!.generation,
          original.detail.heatmapResult,
        ),
      ).toBeNull();
      await assertNoStoredResult(taskId);
    } finally {
      startWorker();
    }
  });

  it('rejects late heatmap writes after administrator revocation and permission restoration', async () => {
    const original = await complete();
    await stopWorker();
    const adminLogin = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .set('X-Forwarded-For', loginIp)
      .send({ username: administrator, password })
      .expect(200);
    const adminCookie = (adminLogin.headers['set-cookie'] as unknown as string[])[0]!.split(
      ';',
    )[0]!;
    async function role(value: 'viewer' | 'operator') {
      await request(api.app.getHttpServer())
        .put(`/api/v1/users/${owner}`)
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', adminLogin.body.csrfToken)
        .send({ role: value, disabled: false })
        .expect(200);
    }
    try {
      const { taskId } = await submit();
      const workerId = randomUUID();
      const task = await claimAgentTask(infra, workerId, taskId);
      expect(task).not.toBeNull();
      await role('viewer');
      await request(api.app.getHttpServer())
        .get('/api/v1/map/heatmap')
        .set('Cookie', cookie)
        .query({ bbox: bbox.join(','), from, to, sourceId })
        .expect(401);
      expect(
        await saveAgentHeatmapResult(
          infra,
          taskId,
          workerId,
          task!.generation,
          original.detail.heatmapResult,
        ),
      ).toBeNull();
      await role('operator');
      await login();
      expect(
        await saveAgentHeatmapResult(
          infra,
          taskId,
          workerId,
          task!.generation,
          original.detail.heatmapResult,
        ),
      ).toBeNull();
      expect(
        await finishAgentTask(infra, taskId, workerId, task!.generation, {
          status: 'completed',
          summary: '撤权后摘要',
          summaryResultVersion: 1,
        }),
      ).toBe(false);
      const detail = await get(`/tasks/${taskId}`).expect(200);
      expect(detail.body.task.status).toBe('failed');
      expect(detail.body.task.errorCode).toBe('permission_changed');
      await assertNoStoredResult(taskId);
      expect(providerCalls).toBe(0);
    } finally {
      await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
      await login();
      startWorker();
    }
  });
});
