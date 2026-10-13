import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { chromium } from 'playwright';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import { ensureAgentBus, runAgentWorker } from '../../apps/agent';
import {
  createInfrastructure,
  runMigrations,
  saveLatestBatch,
} from '../../packages/infrastructure';
import type { Infrastructure } from '../../packages/infrastructure';
import type { AgentInputRequest, AgentTask, PositionObservation } from '../../packages/contracts';

describe('real API, durable input responses and queue worker', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  let cookie: string;
  let csrf: string;
  let ownerPassword: string;
  const owner = randomUUID();
  const origin = 'http://127.0.0.1:13001';
  const sourceId = `input-flow-${randomUUID()}`;
  const mmsi = String(980000000 + Math.floor(Math.random() * 999999));
  const bbox = [120, 20, 121, 21];
  let workerAbort = new AbortController();
  let worker: Promise<void> | undefined;
  let workerError: unknown;
  const priorEnabled = process.env.AGENT_ENABLED;
  let providerCalls = 0;
  function startWorker() {
    worker = runAgentWorker(infra, workerAbort.signal, {
      enabled: true,
      apiKey: 'local-query-verification-no-provider',
      maxRecords: 50000,
      fetch: async () => {
        providerCalls++;
        throw new Error('Query workflow must remain local');
      },
    }).catch((error: unknown) => {
      workerError = error;
    });
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
  async function waitTask(id: string, status: AgentTask['status']) {
    for (let index = 0; index < 100; index++) {
      if (workerError) throw workerError;
      const response = await get(`/tasks/${id}`).expect(200);
      if (response.body.task.status === status) return response.body;
      if (response.body.task.status === 'failed')
        throw new Error(JSON.stringify(response.body.task));
      await delay(100);
    }
    throw new Error(`Task ${id} did not reach ${status}`);
  }
  async function submit(content: string, extra: Record<string, unknown> = {}) {
    const session = await post('/sessions', { title: 'Input flow verification' }).expect(201);
    const message = await post(`/sessions/${session.body.id}/messages`, {
      content,
      ...extra,
    }).expect(202);
    return { sessionId: session.body.id as string, taskId: message.body.task.id as string };
  }

  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    await ensureAgentBus(infra);
    const password = randomUUID();
    ownerPassword = password;
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,'operator')",
      [owner, await hashPassword(password)],
    );
    const now = new Date().toISOString();
    const position: PositionObservation = {
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: `${sourceId}-latest`,
      captureId: `${sourceId}-capture`,
      mmsi,
      sourceId,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      observedAt: now,
      receivedAt: now,
      lat: 20.5,
      lon: 120.5,
      sogKnots: 1,
      cogDegrees: null,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'UNKNOWN',
      quality: ['synthetic'],
    };
    await saveLatestBatch(infra, [position]);
    api = await createApi(infra, { scheduler: false, origins: [origin] });
    const login = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: owner, password })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    csrf = login.body.csrfToken;
    startWorker();
  });

  afterAll(async () => {
    workerAbort.abort();
    await worker;
    await api?.stop();
    if (priorEnabled === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = priorEnabled;
    if (!infra) return;
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
    await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [owner]);
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await infra.pool.query('DELETE FROM positions_latest WHERE source_id=$1', [sourceId]);
    await infra.close();
  });

  it('uses a send-time viewport snapshot and completes a local vessel query without a model', async () => {
    const { taskId } = await submit('当前视野有哪些船舶', {
      mapContext: { bbox, capturedAt: new Date().toISOString(), sourceId, hours: 24 },
    });
    const detail = await waitTask(taskId, 'completed');
    expect(detail.task.bbox).toEqual(bbox);
    expect(detail.queryResult.total).toBe(1);
    expect(detail.queryResult.items[0].mmsi).toBe(mmsi);
    expect(detail.task.modelCalls).toBe(0);
    expect(providerCalls).toBe(0);
    expect(detail.pendingInputRequests).toEqual([]);
  });

  it('answers through HTTP, resumes the same task and safely retries a lost response', async () => {
    const { taskId, sessionId } = await submit('查询区域内有哪些船舶');
    const waiting = await waitTask(taskId, 'awaiting_input');
    const input = waiting.pendingInputRequests[0] as AgentInputRequest;
    expect(input.fields).toContain('region');
    // Human waiting has no execution timeout; recover with a fresh worker instance.
    await infra.pool.query(
      "UPDATE agent_input_requests SET created_at=now()-interval '181 seconds' WHERE id=$1",
      [input.id],
    );
    workerAbort.abort();
    await worker;
    workerAbort = new AbortController();
    startWorker();
    const key = randomUUID();
    const body = {
      action: 'accept',
      inputRevision: input.inputRevision,
      values: { bbox, filters: { sourceId, hours: 24 }, purpose: 'vessel_list' },
    };
    const path = `/tasks/${taskId}/input-requests/${input.id}/responses`;
    const accepted = await post(path, body, key).expect(200);
    expect(accepted.body.task.id).toBe(taskId);
    const detail = await waitTask(taskId, 'completed');
    const replay = await post(path, body, key).expect(200);
    expect(replay.body.task.id).toBe(taskId);
    expect(detail.queryResult.total).toBe(1);
    const snapshot = await get(`/sessions/${sessionId}`).expect(200);
    expect(snapshot.body.tasks).toHaveLength(1);
    expect(snapshot.body.pendingInputRequests).toEqual([]);
    const events = await get(`/sessions/${sessionId}/events?cursor=0`).expect(200);
    expect(
      events.body.items.filter((event: { type: string }) => event.type === 'input.answered'),
    ).toHaveLength(1);
  });

  it('supports two separate input rounds on one task', async () => {
    const { taskId, sessionId } = await submit('请帮我完成查询');
    const initial = await waitTask(taskId, 'awaiting_input');
    const first = initial.pendingInputRequests[0] as AgentInputRequest;
    await post(`/tasks/${taskId}/input-requests/${first.id}/responses`, {
      action: 'accept',
      inputRevision: first.inputRevision,
      values: { purpose: 'vessel_detail' },
    }).expect(200);
    const secondState = await waitTask(taskId, 'awaiting_input');
    const second = secondState.pendingInputRequests[0] as AgentInputRequest;
    expect(second.id).not.toBe(first.id);
    expect(second.fields).toContain('vessels');
    await post(`/tasks/${taskId}/input-requests/${second.id}/responses`, {
      action: 'accept',
      inputRevision: second.inputRevision,
      values: { mmsis: [mmsi] },
    }).expect(200);
    const completed = await waitTask(taskId, 'completed');
    expect(completed.queryResult.items[0].mmsi).toBe(mmsi);
    expect((await get(`/sessions/${sessionId}`).expect(200)).body.tasks).toHaveLength(1);
    expect(providerCalls).toBe(0);
  });

  it('does not accept cancelled or unauthenticated input submissions', async () => {
    const { taskId } = await submit('查询区域内有哪些船舶');
    const waiting = await waitTask(taskId, 'awaiting_input');
    const input = waiting.pendingInputRequests[0] as AgentInputRequest;
    const path = `/tasks/${taskId}/input-requests/${input.id}/responses`;
    await request(api.app.getHttpServer())
      .post(`/api/v1/agent${path}`)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('Idempotency-Key', randomUUID())
      .send({ action: 'accept', inputRevision: input.inputRevision, values: { bbox } })
      .expect(403);
    await post(`/tasks/${taskId}/cancel`, {}).expect(200);
    await post(path, {
      action: 'accept',
      inputRevision: input.inputRevision,
      values: { bbox },
    }).expect(409);
    expect((await get(`/tasks/${taskId}`).expect(200)).body.task.status).toBe('cancelled');
  });

  it.runIf(process.env.AIS_INPUT_BROWSER === '1')(
    'completes the dialog with a real API and worker, and recovers a waiting request after refresh',
    async () => {
      // The page is the real Nuxt app; only the destination of its API traffic changes.
      await api.app.listen(0, '127.0.0.1');
      const address = api.app.getHttpServer().address() as { port: number };
      const apiOrigin = `http://127.0.0.1:${address.port}`;
      const password = randomUUID();
      ownerPassword = password;
      await infra.pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
        owner,
        await hashPassword(password),
      ]);
      const browser = await chromium.launch({
        executablePath: chromium.executablePath(),
        headless: true,
      });
      try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await context.route('**/api/v1/**', async (route) => {
          const url = new URL(route.request().url());
          const response = await route.fetch({
            url: `${apiOrigin}${url.pathname}${url.search}`,
            headers: { ...route.request().headers(), origin },
          });
          await route.fulfill({ response });
        });
        await context.routeWebSocket('**/api/v1/live*', (socket) => socket.close());
        const page = await context.newPage();
        await page.goto(`${origin}/login`);
        await page.getByLabel('用户名', { exact: true }).fill(owner);
        await page.getByLabel('密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: /进入工作空间/ }).click();
        const composer = page.getByTestId('chart-agent-composer');
        const input = composer.getByLabel('分析问题或继续追问');
        await input.waitFor({ state: 'visible' });
        const acceptedMessage = page.waitForResponse(
          (response) =>
            response.url().endsWith('/messages') && response.request().method() === 'POST',
        );
        await input.fill('请帮我完成查询');
        await input.press('Enter');
        const submitted = (await (await acceptedMessage).json()) as { task: AgentTask };
        const dialog = page.getByRole('dialog', { name: '补充任务条件' });
        await dialog.waitFor({ state: 'visible' });
        await dialog.getByRole('button', { name: '收起', exact: true }).click();
        await page.reload();
        await composer.getByRole('button', { name: '打开智能体对话', exact: true }).click();
        const card = page.getByLabel('待补充条件');
        await card.waitFor({ state: 'visible' });
        expect(await dialog.isVisible()).toBe(false);
        await card.getByRole('button', { name: '继续选择', exact: true }).click();
        await dialog.getByLabel('任务目标').selectOption('vessel_detail');
        await dialog.getByLabel('搜索船舶').fill(mmsi);
        await dialog.getByRole('button', { name: '搜索', exact: true }).click();
        await dialog.getByRole('checkbox').first().check();
        const acceptedAnswer = page.waitForResponse(
          (response) =>
            response.url().endsWith('/responses') && response.request().method() === 'POST',
        );
        await dialog.getByRole('button', { name: '确认并继续', exact: true }).click();
        const answer = (await (await acceptedAnswer).json()) as { task: AgentTask };
        expect(answer.task.id).toBe(submitted.task.id);
        await page.getByLabel('船舶查询结果').waitFor({ state: 'visible', timeout: 20_000 });
        expect(await page.getByLabel('船舶查询结果').innerText()).toContain(mmsi);
        const completed = await waitTask(submitted.task.id, 'completed');
        expect(completed.task.modelCalls).toBe(0);
        expect(providerCalls).toBe(0);
        await page.screenshot({
          path: '.data/agent-input-verification/live-browser.png',
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
    },
  );

  it('invalidates a waiting request through the real administrator API even after permission is restored', async () => {
    const { taskId } = await submit('查询区域内有哪些船舶');
    const waiting = await waitTask(taskId, 'awaiting_input');
    const input = waiting.pendingInputRequests[0] as AgentInputRequest;
    const administrator = randomUUID();
    const password = randomUUID();
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,'admin')",
      [administrator, await hashPassword(password)],
    );
    const login = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: administrator, password })
      .expect(200);
    const adminCookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    async function role(value: 'viewer' | 'operator') {
      await request(api.app.getHttpServer())
        .put(`/api/v1/users/${owner}`)
        .set('Cookie', adminCookie)
        .set('Origin', origin)
        .set('X-CSRF-Token', login.body.csrfToken)
        .send({ role: value, disabled: false })
        .expect(200);
    }
    try {
      await role('viewer');
      await role('operator');
      const restored = await request(api.app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('Origin', origin)
        .send({ username: owner, password: ownerPassword })
        .expect(200);
      cookie = (restored.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
      csrf = restored.body.csrfToken;
      const detail = await get(`/tasks/${taskId}`).expect(200);
      expect(detail.body.task.status).toBe('failed');
      expect(detail.body.task.errorCode).toBe('permission_changed');
      expect(detail.body.pendingInputRequests).toEqual([]);
      await post(`/tasks/${taskId}/input-requests/${input.id}/responses`, {
        action: 'accept',
        inputRevision: input.inputRevision,
        values: { bbox },
      }).expect(409);
    } finally {
      await infra.pool.query("UPDATE users SET role='operator' WHERE id=$1", [owner]);
      await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [administrator]);
      await infra.pool.query('DELETE FROM users WHERE id=$1', [administrator]);
    }
  });
});
