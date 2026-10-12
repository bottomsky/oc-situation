import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { AnalysisResult, TopicDefinition, TopicInstance } from '@ais/contracts';
const root = resolve(import.meta.dirname, '..');
const children: ChildProcess[] = [];
function start(entry: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: false,
  });
  children.push(child);
  return child;
}
async function wait(url: string) {
  for (let n = 0; n < 30; n++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch {
      /* process startup */
    }
    await delay(1000);
  }
  throw new Error(`Compiled server unavailable: ${url}`);
}
try {
  start('apps/api/dist/main.mjs', {
    API_PORT: '13200',
    METRICS_PORT: '13201',
    WEB_ORIGINS: 'http://127.0.0.1:13202',
  });
  await wait('http://127.0.0.1:13201/ready');
  const credentials = JSON.parse(
    await readFile(resolve(root, '.data/demo-admin.json'), 'utf8'),
  ) as { username: string; password: string };
  const login = await fetch('http://127.0.0.1:13200/api/v1/auth/login', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:13202', 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: credentials.username, password: credentials.password }),
  });
  if (!login.ok) throw new Error(`Compiled API authentication failed: ${login.status}`);
  const cookie = login.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Compiled API omitted session');
  const vessel = await fetch('http://127.0.0.1:13200/api/v1/vessels/413793000', {
    headers: { Cookie: cookie },
  });
  if (!vessel.ok) throw new Error('Compiled API failed persisted vessel query');
  async function readApi<T>(path: string): Promise<T> {
    const response = await fetch('http://127.0.0.1:13200/api/v1' + path, {
      headers: { Cookie: cookie! },
      signal: AbortSignal.timeout(15000),
    });
    assert.ok(response.ok, `Compiled API ${path} failed: ${response.status}`);
    return response.json() as Promise<T>;
  }
  const topics = await readApi<{ definitions: TopicDefinition[]; instances: TopicInstance[] }>(
    '/topics',
  );
  assert.ok(Array.isArray(topics.definitions), 'Compiled API omitted topic definitions');
  assert.ok(Array.isArray(topics.instances), 'Compiled API omitted topic instances');
  for (const [definitionId, name] of [
    ['port-restriction', '演示：港口限制船舶识别'],
    ['area-low-speed-notice', '演示：区域低速活动与公告关联'],
  ] as const) {
    const definition = topics.definitions.find((item) => item.id === definitionId);
    assert.ok(definition?.available, `Compiled API topic definition unavailable: ${definitionId}`);
    assert.ok(definition.version, `Compiled API topic definition omitted version: ${definitionId}`);
    const instance = topics.instances.find(
      (item) => item.definitionId === definitionId && item.name === name,
    );
    assert.ok(instance, `Compiled API omitted seeded demo topic: ${definitionId}`);
    const response = await readApi<{ items: AnalysisResult[] }>(
      '/analysis/results?instanceId=' + encodeURIComponent(instance.id) + '&limit=100',
    );
    assert.ok(Array.isArray(response.items), 'Compiled API returned invalid analysis list');
    const result = response.items.find(
      (item) => item.definitionId === definitionId && item.status !== 'withdrawn',
    );
    assert.ok(result, `Compiled API omitted persisted demo result: ${definitionId}`);
    const detail = await readApi<AnalysisResult>(
      '/analysis/results/' + encodeURIComponent(result.id),
    );
    assert.equal(detail.id, result.id, 'Compiled API returned a different result detail');
    assert.equal(
      detail.instanceId,
      instance.id,
      'Compiled API returned evidence from another topic',
    );
    assert.ok(
      Number.isInteger(detail.revision) && detail.revision > 0,
      'Result revision is missing',
    );
    assert.ok(detail.definitionVersion, 'Result algorithm version is missing');
    const evidence = detail.evidence;
    assert.ok(Array.isArray(evidence?.ais) && evidence.ais.length, 'Result omitted AIS evidence');
    assert.ok(
      evidence.ais.every(
        (point) =>
          point.recordId &&
          Number.isFinite(point.longitude) &&
          Number.isFinite(point.latitude) &&
          point.raw,
      ),
      'Result AIS evidence omitted original records or coordinates',
    );
    assert.ok(
      Array.isArray(evidence.documents) &&
        evidence.documents.some(
          (document) =>
            document.sourceId === 'fixture-intelligence' &&
            document.paragraphs?.some((paragraph) => paragraph.id && paragraph.text),
        ),
      'Result omitted the seeded announcement and original text',
    );
    assert.ok(
      Array.isArray(evidence.steps) &&
        evidence.steps.some((step) => step.rule && step.outcome && step.references.length),
      'Result omitted traceable algorithm steps',
    );
  }
  start('apps/web/.output/server/index.mjs', {
    NITRO_HOST: '127.0.0.1',
    NITRO_PORT: '13202',
    NUXT_API_TARGET: 'http://127.0.0.1:13200',
  });
  await wait('http://127.0.0.1:13202');
  console.log(
    'Node 24 compiled API authentication, persisted vessel and both fusion topics/evidence, and Nuxt production server smoke passed',
  );
} finally {
  for (const child of children) child.kill('SIGTERM');
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((ok) => {
          if (child.exitCode !== null || child.signalCode !== null) ok();
          else {
            const timer = setTimeout(() => {
              if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
              ok();
            }, 5000);
            timer.unref();
            child.once('exit', () => {
              clearTimeout(timer);
              ok();
            });
          }
        }),
    ),
  );
}
