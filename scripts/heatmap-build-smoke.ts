import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { createServer as createPortProbe } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type Page } from 'playwright';
import { expect } from '@playwright/test';
import { hashPassword } from '../apps/api/src/auth/service';
import { hashToken } from '../apps/api/src/auth/security';
import { createE2eWebGateway } from './e2e-web-gateway';
import {
  createInfrastructure,
  runMigrations,
  saveHistoryBatch,
  type Infrastructure,
} from '../packages/infrastructure';
import type { AgentTask, PositionObservation } from '../packages/contracts';
import { HeatmapResultSchema, type AgentHeatmapResult } from '../packages/contracts/heatmap';

// Run `bun --no-env-file run heatmap:smoke` after the production build.
// Bun is the package runner; Playwright's Windows transport requires the Node runtime.
assert.equal(
  'Bun' in globalThis,
  false,
  'Use bun --no-env-file run heatmap:smoke so Playwright runs on Node',
);
assert.equal(process.env.AIS_HEATMAP_SMOKE, '1', 'Set AIS_HEATMAP_SMOKE=1 to run isolated smoke');
for (const [key, protocol, port] of [
  ['DATABASE_URL', 'postgresql:', '15433'],
  ['CLICKHOUSE_URL', 'http:', '18124'],
  ['NATS_URL', 'nats:', '14223'],
  ['S3_ENDPOINT', 'http:', '19001'],
] as const) {
  assert.ok(process.env[key], `Explicit ${key} is required`);
  const url = new URL(process.env[key]!);
  assert.equal(url.hostname, '127.0.0.1', `${key} must use the isolated loopback service`);
  assert.equal(url.protocol, protocol, `${key} uses an unexpected protocol`);
  assert.equal(url.port, port, `${key} must use isolated port ${port}`);
}
assert.equal(new URL(process.env.DATABASE_URL!).pathname, '/ais');
assert.equal(process.env.CLICKHOUSE_DATABASE, 'ais');
assert.equal(process.env.S3_BUCKET, 'ais-raw');
assert.ok(
  process.env.PLAYWRIGHT_BROWSERS_PATH,
  'Set PLAYWRIGHT_BROWSERS_PATH to the existing .data/playwright installation before starting Bun',
);
await access(chromium.executablePath());

const root = resolve(import.meta.dirname, '..');
const apiOrigin = 'http://127.0.0.1:13230';
const webOrigin = 'http://127.0.0.1:13231';
const browserOrigin = 'http://127.0.0.1:13232';
for (const port of [13230, 13231, 13232, 13238, 13239]) {
  const probe = createPortProbe();
  await new Promise<void>((done, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close((error) => (error ? reject(error) : done())));
  });
}
const node = spawnSync('node', ['-p', 'process.execPath'], {
  encoding: 'utf8',
  windowsHide: true,
  shell: false,
});
assert.equal(node.status, 0, 'Node is required to execute compiled artifacts');
const nodePath = node.stdout.trim();
const entries = [
  'apps/api/dist/main.mjs',
  'apps/agent/dist/main.mjs',
  'apps/agent/dist/check-skills.mjs',
  'apps/web/.output/server/index.mjs',
];
for (const entry of entries) await access(resolve(root, entry));
const check = spawnSync(nodePath, ['apps/agent/dist/check-skills.mjs'], {
  cwd: root,
  encoding: 'utf8',
  windowsHide: true,
  shell: false,
});
assert.equal(check.status, 0, 'Compiled skill catalog verification failed');
assert.deepEqual(
  check.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split('@')[0])
    .sort(),
  ['ais-heatmap', 'intelligence-search', 'ui-control', 'vessel-query', 'vessel-tracks'],
  'The compiled worker must bundle exactly the five built-in skills',
);

const children: { name: string; child: ChildProcess; logs: string }[] = [];
let startupError: Error | undefined;
let forbiddenNetwork = false;
let infra: Infrastructure | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let gateway: ReturnType<typeof createE2eWebGateway> | undefined;
let fixtureCreated = false;
let cleanupFailures: unknown[];
const loginAuditIds = new Set<string>();
const owner = randomUUID();
const password = randomUUID();
const sourceId = `heatmap-build-${randomUUID()}`;
const mmsi = String(960000000 + Math.floor(Math.random() * 999999));
const bbox: [number, number, number, number] = [121, 31, 124, 35];
const from = new Date(Date.now() - 3_600_000).toISOString();
const to = new Date(Date.now() - 60_000).toISOString();
const screenshot = resolve(root, '.data/heatmap-production.png');

function start(name: string, entry: string, env: NodeJS.ProcessEnv, imports: string[] = []) {
  const child = spawn(nodePath, [...imports, resolve(root, entry)], {
    cwd: root,
    // The artifacts are compiled; local HTTP deliberately uses non-Secure development cookies.
    env: { ...process.env, NODE_ENV: 'development', AGENT_ENABLED: 'true', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    windowsHide: true,
  });
  const item = { name, child, logs: '' };
  children.push(item);
  const record = (data: Buffer) => {
    const line = data.toString();
    if (line.includes('SMOKE_FORBIDDEN_MODEL_NETWORK')) forbiddenNetwork = true;
    item.logs = (item.logs + line).slice(-8000);
  };
  child.stdout?.on('data', record);
  child.stderr?.on('data', record);
  child.on('error', (error) => {
    startupError = error;
  });
}
function healthy() {
  if (startupError) throw startupError;
  assert.equal(forbiddenNetwork, false, 'Compiled worker attempted forbidden external fetch');
  for (const { name, child, logs } of children)
    assert.ok(child.exitCode === null && child.signalCode === null, `${name} exited: ${logs}`);
}
async function wait(url: string) {
  for (let index = 0; index < 60; index++) {
    healthy();
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* Wait for the compiled server to bind. */
    }
    await delay(500);
  }
  throw new Error(`Compiled service did not become ready: ${url}`);
}
async function stopChildren() {
  await Promise.all(
    children.map(async ({ child }) => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      for (let attempt = 0; attempt < 50; attempt++) {
        if (child.exitCode !== null || child.signalCode !== null) return;
        await delay(100);
      }
      child.kill('SIGKILL');
      await new Promise<void>((done) => {
        if (child.exitCode !== null || child.signalCode !== null) done();
        else child.once('exit', () => done());
      });
    }),
  );
}
type Detail = { task: AgentTask; heatmapResult: AgentHeatmapResult | null };
async function recordLoginAudit<T>(login: () => Promise<T>): Promise<T> {
  // This script requires exclusive use of the isolated database during each real login.
  const ipHash = hashToken('127.0.0.1');
  const before = await infra!.pool.query<{ id: string }>(
    "SELECT id FROM audit WHERE action='login_attempt' AND resource_id=$1",
    [ipHash],
  );
  const known = new Set(before.rows.map((row) => row.id));
  const started = (await infra!.pool.query('SELECT clock_timestamp() AS time')).rows[0].time;
  try {
    return await login();
  } finally {
    const after = await infra!.pool.query<{ id: string }>(
      "SELECT id FROM audit WHERE action='login_attempt' AND resource_type='authentication' AND resource_id=$1 AND created_at >= $2",
      [ipHash, started],
    );
    for (const row of after.rows) if (!known.has(row.id)) loginAuditIds.add(row.id);
  }
}

try {
  infra = await createInfrastructure();
  await runMigrations(infra);
  const runnable = await infra.pool.query(`SELECT
    (SELECT count(*) FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.enabled AND j.status='enabled' AND s.enabled AND j.mode<>'replay' AND j.schedule_seconds IS NOT NULL) AS jobs,
    (SELECT count(*) FROM outbox WHERE published_at IS NULL) AS outbox,
    (SELECT count(*) FROM agent_tasks WHERE status IN ('queued','running','waiting_result')) AS tasks`);
  for (const [kind, count] of Object.entries(runnable.rows[0]))
    assert.equal(
      Number(count),
      0,
      `Isolated database has other runnable ${kind}; refuse to start workers`,
    );
  await infra.pool.query(
    "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,'operator')",
    [owner, await hashPassword(password)],
  );
  fixtureCreated = true;
  await infra.pool.query(
    "INSERT INTO sources(id,name,kind,enabled,status) VALUES($1,'编译产物热力验证','fixture-http',false,'disabled')",
    [sourceId],
  );
  const positions: PositionObservation[] = [0, 1, 2].map((index) => ({
    schemaVersion: 1,
    cleaningVersion: 1,
    kind: 'position',
    eventId: `${sourceId}-${index}`,
    captureId: `${sourceId}-capture`,
    mmsi,
    sourceId,
    sourceKind: 'fixture-http',
    sourcePriority: 100,
    runId: null,
    observedAt: new Date(Date.parse(from) + (index + 1) * 60_000).toISOString(),
    receivedAt: from,
    lon: index === 2 ? 123.5 : 122.5,
    lat: 33,
    sogKnots: 1,
    cogDegrees: null,
    headingDegrees: null,
    rotDegPerMinute: null,
    navigationStatus: null,
    receptionType: 'UNKNOWN',
    quality: ['synthetic'],
  }));
  await saveHistoryBatch(infra, positions);
  start('API', entries[0]!, {
    API_HOST: '127.0.0.1',
    API_PORT: '13230',
    METRICS_HOST: '127.0.0.1',
    METRICS_PORT: '13238',
    WEB_ORIGINS: browserOrigin,
  });
  await wait('http://127.0.0.1:13238/ready');
  // Fail before a provider request can leave the worker, including accidental routing regressions.
  const fetchGuard = `const localFetch=globalThis.fetch;globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.hostname!=='127.0.0.1'){console.error('SMOKE_FORBIDDEN_MODEL_NETWORK');throw new Error('External fetch disabled in heatmap smoke');}return localFetch(input,init);};`;
  start(
    'Agent',
    entries[1]!,
    {
      INTERNAL_METRICS_PORT: '13239',
      METRICS_HOST: '127.0.0.1',
      DEEPSEEK_API_KEY: 'heatmap-smoke-placeholder-no-provider-access',
    },
    ['--import', `data:text/javascript,${encodeURIComponent(fetchGuard)}`],
  );
  await wait('http://127.0.0.1:13239/ready');
  start('Web', entries[3]!, { NITRO_HOST: '127.0.0.1', NITRO_PORT: '13231' });
  await wait(webOrigin);
  // Production Web needs a same-origin reverse proxy; NUXT_API_TARGET is not a runtime proxy.
  gateway = createE2eWebGateway({
    apiTarget: apiOrigin,
    frontendTarget: webOrigin,
    timeoutMs: 30_000,
  });
  await new Promise<void>((done, reject) => {
    gateway!.server.once('error', reject);
    gateway!.server.listen(13232, '127.0.0.1', done);
  });
  const login = await recordLoginAudit(() =>
    fetch(`${apiOrigin}/api/v1/auth/login`, {
      method: 'POST',
      headers: { Origin: browserOrigin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: owner, password }),
    }),
  );
  assert.equal(login.status, 200, 'Compiled API login failed');
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie, 'Compiled API omitted session cookie');
  const { csrfToken } = (await login.json()) as { csrfToken: string };
  async function api<T>(path: string, body?: unknown): Promise<T> {
    healthy();
    const response = await fetch(`${apiOrigin}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Cookie: cookie!,
        Origin: browserOrigin,
        'X-CSRF-Token': csrfToken,
        'Idempotency-Key': randomUUID(),
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `Compiled API ${path} failed with ${response.status}`);
    return response.json() as Promise<T>;
  }
  async function completed(taskId: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      const detail = await api<Detail>(`/agent/tasks/${taskId}`);
      assert.equal(detail.task.modelCalls, 0, 'Heatmap unexpectedly used a model');
      if (detail.task.status === 'completed') {
        assert.equal(detail.task.toolCalls, 3, 'Expected activation, reference and local query');
        assert.ok(detail.heatmapResult, 'Completed task omitted heatmap');
        assert.equal(detail.task.summaryResultVersion, detail.heatmapResult.version);
        return detail;
      }
      assert.ok(
        !['failed', 'cancelled', 'awaiting_input'].includes(detail.task.status),
        `Heatmap did not complete: ${detail.task.status}/${detail.task.errorCode ?? ''}`,
      );
      await delay(500);
    }
    throw new Error('Compiled worker heatmap timed out');
  }
  const params = new URLSearchParams({ bbox: bbox.join(','), from, to, sourceId });
  const manual = HeatmapResultSchema.parse(await api(`/map/heatmap?${params}`));
  assert.equal(manual.totalVessels, 1);
  assert.equal(manual.cells.length, 2);
  const session = await api<{ id: string }>('/agent/sessions', { title: '编译产物热力验证' });
  const submitted = await api<{ task: AgentTask }>(`/agent/sessions/${session.id}/messages`, {
    content: `生成当前视野 ${from} 至 ${to} 的 AIS 热力图`,
    mapContext: { bbox, sourceId, capturedAt: new Date().toISOString() },
  });
  const detail = await completed(submitted.task.id);
  const snapshot = detail.heatmapResult!;
  assert.deepEqual(snapshot.query, manual.query);
  assert.deepEqual(snapshot.cells, manual.cells);
  assert.deepEqual(snapshot.grid, manual.grid);
  assert.equal(snapshot.totalVessels, manual.totalVessels);
  console.log(
    'Compiled API and worker passed: heatmap matches manual API; 0 model / 3 tool calls.',
  );

  browser = await chromium.launch({
    headless: true,
    timeout: 20_000,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  context.setDefaultTimeout(20_000);
  context.setDefaultNavigationTimeout(45_000);
  page = await context.newPage();
  await page.goto(`${browserOrigin}/login`);
  await page.getByLabel('用户名', { exact: true }).fill(owner);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await recordLoginAudit(async () => {
    const response = page!.waitForResponse(
      (value) => value.url().endsWith('/auth/login') && value.request().method() === 'POST',
    );
    await page!.getByRole('button', { name: /进入工作空间/ }).click();
    assert.equal((await response).status(), 200, 'Compiled browser login failed');
  });
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45_000,
  });
  console.log('Compiled browser login and map initialization passed.');
  if (!(await page.getByTestId('chart-left-panel').isVisible()))
    await page.getByRole('button', { name: '打开人工操控面板', exact: true }).click();
  await page.getByRole('tab', { name: '图层控制', exact: true }).click();
  await page
    .getByTestId('chart-left-panel')
    .getByLabel(/^数据来源/)
    .selectOption(sourceId);
  await page.getByRole('button', { name: '折叠操作面板', exact: true }).click();
  const composer = page.getByTestId('chart-agent-composer');
  const responsePromise = page.waitForResponse(
    (response) => response.url().endsWith('/messages') && response.request().method() === 'POST',
  );
  await composer.getByLabel('分析问题或继续追问').fill('生成当前视野过去24小时的 AIS 热力图');
  await composer.getByRole('button', { name: '发送分析问题', exact: true }).click();
  const accepted = await responsePromise;
  assert.equal(accepted.status(), 202, 'Browser message submission failed');
  const browserTask = (await accepted.json()) as { task: AgentTask };
  const browserResult = await completed(browserTask.task.id);
  assert.equal(browserResult.heatmapResult!.query.sourceId, sourceId);
  assert.equal(browserResult.heatmapResult!.totalVessels, 1);
  await expect(page.getByRole('region', { name: 'AIS 热力图结果', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示', { timeout: 20_000 });
  await expect(page.getByTestId('heatmap-legend')).toContainText('全区 1 艘');
  console.log(
    'Browser heatmap task completed and automatically displayed its result card and legend.',
  );
  await page.reload();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true', {
    timeout: 45_000,
  });
  const reopen = page.getByRole('button', { name: '打开智能体对话', exact: true });
  if (await reopen.isVisible()) await reopen.click();
  await expect(page.getByRole('button', { name: '在海图展示此快照', exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('heatmap-legend')).toHaveCount(0);
  await page.getByRole('button', { name: '在海图展示此快照', exact: true }).click();
  await expect(page.getByTestId('heatmap-legend')).toContainText('海图已展示', { timeout: 20_000 });
  await mkdir(resolve(root, '.data'), { recursive: true });
  await page.screenshot({ path: screenshot, fullPage: true });
  healthy();
  console.log(
    'Compiled skills/API/worker/web/browser heatmap smoke passed; model calls=0, tool calls=3.',
  );
  console.log(`Screenshot: ${screenshot}`);
} catch (error) {
  if (page) {
    await mkdir(resolve(root, '.data'), { recursive: true });
    await page
      .screenshot({ path: resolve(root, '.data/heatmap-production-failure.png'), fullPage: true })
      .catch(() => {});
  }
  throw error;
} finally {
  const shutdown = await Promise.allSettled([browser?.close(), gateway?.close(), stopChildren()]);
  if (infra) {
    try {
      if (fixtureCreated) {
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
        await infra.pool.query(
          "DELETE FROM audit WHERE action='login_attempt' AND id=ANY($1::uuid[])",
          [[...loginAuditIds]],
        );
        await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
        await infra.pool.query('DELETE FROM sources WHERE id=$1', [sourceId]);
        for (const table of ['positions', 'quality_events_v2'])
          await infra.clickhouse.command({
            query: `ALTER TABLE ${table} DELETE WHERE sourceId={source:String}`,
            query_params: { source: sourceId },
            clickhouse_settings: { mutations_sync: '1' },
          });
      }
    } finally {
      await infra.close();
    }
  }
  cleanupFailures = shutdown
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
}
if (cleanupFailures.length)
  throw new AggregateError(cleanupFailures, 'Smoke process cleanup failed');
