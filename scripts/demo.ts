import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createInfrastructure,
  createRawEnvelope,
  publishRaw,
  runMigrations,
  seedDemo,
  flushOutbox,
  busHealth,
} from '@ais/infrastructure';
import { createFixtureServer } from '../tests/fixture-server/server';
import { createApi } from '../apps/api/src/app';
import { bootstrapAdmin, hashPassword } from '../apps/api/src/auth/service';
import { JobsService } from '../apps/api/src/jobs/service';
import { SystemController } from '../apps/api/src/system/controller';
import { startOperationsServer } from '../apps/api/src/system/operations';
import { seedFusionDemo } from './fusion-demo';
import { recoverDemoCollection } from './demo-readiness';
import { demoWorker, type demoWorkers } from './demo-workers';

if (process.env.NODE_ENV === 'production') throw new Error('Demo is restricted to development');
const root = resolve(import.meta.dirname, '..');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(root, '.data/playwright');
const children: ChildProcess[] = [];
const shutdown = new AbortController();
let failed = false;
function child(entry: string, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const proc = spawn(
    process.execPath,
    entry.endsWith('.ts') ? ['--import', 'tsx', entry, ...args] : [entry, ...args],
    {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: 'inherit',
      shell: false,
    },
  );
  children.push(proc);
  proc.once('error', () => {
    failed = true;
    shutdown.abort();
  });
  proc.once('exit', (code) => {
    if (!shutdown.signal.aborted) {
      failed = code !== 0;
      shutdown.abort();
    }
  });
}
function worker(role: keyof typeof demoWorkers) {
  const spec = demoWorker(role);
  child(spec.entry, spec.env);
}
const infra = await createInfrastructure();
await runMigrations(infra);
await seedDemo(infra);
const credentialPath = resolve(root, '.data/demo-admin.json');
await mkdir(resolve(root, '.data'), { recursive: true });
type Credentials = {
  username: string;
  password: string;
  operator: { username: string; password: string };
  viewer: { username: string; password: string };
};
let credentials: Credentials;
try {
  credentials = JSON.parse(await readFile(credentialPath, 'utf8')) as Credentials;
} catch {
  credentials = {
    username: 'demo-admin',
    password: randomBytes(24).toString('base64url'),
    operator: { username: 'demo-operator', password: randomBytes(24).toString('base64url') },
    viewer: { username: 'demo-viewer', password: randomBytes(24).toString('base64url') },
  };
}
await writeFile(credentialPath, JSON.stringify(credentials, null, 2), { mode: 0o600 });
await bootstrapAdmin(infra, {
  ADMIN_USERNAME: credentials.username,
  ADMIN_PASSWORD: credentials.password,
});
for (const role of ['operator', 'viewer'] as const) {
  const user = credentials[role];
  await infra.pool.query(
    'INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(username) DO NOTHING',
    [randomUUID(), user.username, await hashPassword(user.password), role],
  );
}
const fixture = createFixtureServer();
await new Promise<void>((ok, bad) => {
  fixture.once('error', bad);
  fixture.listen(13002, '127.0.0.1', ok);
});
worker('processor');
worker('writerPostgres');
worker('writerClickhouse');
worker('archiver');
if (process.env.AGENT_ENABLED === 'true') worker('agent');
const api = await createApi(infra, { scheduler: false });
await api.app.listen(13000, '127.0.0.1');
const operations = await startOperationsServer(api.app.get(SystemController));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => shutdown.abort());
try {
  await recoverDemoCollection(
    () => busHealth(infra),
    () => {
      worker('crawler');
      worker('collector');
    },
    { signal: shutdown.signal, onProgress: (message) => console.log(message) },
  );
  api.app.get(JobsService).start();
  try {
    await api.app.get(JobsService).dispatch('00000000-0000-4000-8000-000000000001', randomUUID());
  } catch (error) {
    if (!String(error).includes('active run')) throw error;
  }
  await flushOutbox(infra);
  // Historical demo observations enter the exact RAW → cleaner → independent writers pipeline.
  const now = Date.now();
  const data = Array.from({ length: 100 }, (_, t) =>
    Array.from({ length: 4 }, (_, vessel) => ({
      mmsi: String(413793000 + vessel),
      observedAt: new Date(now - (99 - t) * 15 * 60_000).toISOString(),
      lat: 32.5 + vessel * 0.12 + t * 0.005,
      lon: 123.5 + vessel * 0.1 + t * 0.007,
      sogKnots: t >= 90 ? 2.1 : 12.3,
      cogDegrees: 87.5,
      fields: { name: `SYNTHETIC DEMO ${vessel + 1}`, shipType: 70 },
    })),
  ).flat();
  await publishRaw(
    infra,
    await createRawEnvelope(infra, {
      sourceId: 'fixture-http',
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      adapterVersion: 'fixture-v1',
      runId: null,
      payload: { synthetic: true, data },
    }),
  );
  let ready = false;
  for (let attempt = 0; attempt < 60 && !shutdown.signal.aborted; attempt++) {
    const rows = await infra.pool.query(
      "SELECT count(*)::int AS count FROM positions_latest WHERE mmsi BETWEEN '413793000' AND '413793003'",
    );
    const ch = await infra.clickhouse.query({
      query:
        "SELECT count() AS count FROM positions FINAL WHERE mmsi='413793000' AND sourceId='fixture-http'",
      format: 'JSONEachRow',
    });
    const counts = await ch.json<{ count: string }>();
    if (rows.rows[0].count === 4 && Number(counts[0]?.count) >= 100) {
      ready = true;
      break;
    }
    await delay(1000);
  }
  if (!ready) throw new Error('Demo pipeline did not become queryable within 60 seconds');
  await seedFusionDemo(infra, now);
  worker('intelligence');
  worker('topicPortRestriction');
  worker('topicLowSpeed');
  worker('topicPredictions');
  await writeFile(
    resolve(root, '.data/demo-ready.json'),
    JSON.stringify({ ready: true, at: new Date().toISOString(), mmsi: '413793000' }),
  );
  if (!process.argv.includes('--backend-only'))
    child('node_modules/nuxt/bin/nuxt.mjs', {}, [
      'dev',
      'apps/web',
      '--host',
      '127.0.0.1',
      '--port',
      '13001',
    ]);
  console.log(
    '样例链路可查询。Web http://127.0.0.1:13001；本地登录凭证见 .data/demo-admin.json（未打印密码）。',
  );
  await new Promise<void>((ok) => {
    if (shutdown.signal.aborted) ok();
    else shutdown.signal.addEventListener('abort', () => ok(), { once: true });
  });
} finally {
  shutdown.abort();
  for (const proc of children) proc.kill('SIGTERM');
  await Promise.all(
    children.map(
      (proc) =>
        new Promise<void>((ok) => {
          if (proc.exitCode !== null || proc.signalCode !== null) ok();
          else {
            const timer = setTimeout(() => {
              if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL');
              ok();
            }, 10_000);
            timer.unref();
            proc.once('exit', () => {
              clearTimeout(timer);
              ok();
            });
          }
        }),
    ),
  );
  await operations.close();
  await api.stop();
  await infra.close();
  await new Promise<void>((ok) => fixture.close(() => ok()));
  if (failed) process.exitCode = 1;
}
