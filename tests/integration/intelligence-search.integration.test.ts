import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateBucketCommand } from '@aws-sdk/client-s3';
import request from 'supertest';
import {
  createInfrastructure,
  runMigrations,
  saveIntelligenceEvent,
  type Infrastructure,
} from '../../packages/infrastructure';
import {
  IntelligenceInputSchema,
  type IntelligenceEvent,
} from '../../packages/contracts/intelligence';
import { IntelligenceSourceSchema } from '../../packages/contracts/intelligence';
import {
  searchIntelligence,
  searchAgentIntelligence,
  resolveIntelligenceObjects,
} from '../../packages/infrastructure/intelligence-search';
import { createApi } from '../../apps/api/src/app';
import { hashPassword } from '../../apps/api/src/auth/service';
import { runAgentWorker } from '../../apps/agent';
import { intelligenceSelection } from '../../packages/domain/intelligence-intent';
import { chromium } from 'playwright';

describe('indexed intelligence and real local tool workflow', () => {
  let infra: Infrastructure;
  let api: Awaited<ReturnType<typeof createApi>>;
  let cookie: string, csrf: string, password: string;
  const owner = randomUUID(),
    prefix = `search-${randomUUID()}`;
  const sources = { public: `${prefix}-public`, internal: `${prefix}-internal` };
  const origin = 'http://127.0.0.1:13001';
  const now = new Date();
  const published = new Date(now.getTime() - 3600_000).toISOString();
  const abort = new AbortController();
  let worker: Promise<void> | undefined, workerError: unknown;
  const bodies: string[] = [];
  const previousEnabled = process.env.AGENT_ENABLED;
  let navigation: IntelligenceEvent;

  async function event(
    externalId: string,
    title: string,
    extra: Record<string, unknown> = {},
    sourceId = sources.public,
  ) {
    return saveIntelligenceEvent(
      infra,
      IntelligenceInputSchema.parse({
        sourceId,
        externalId,
        version: 1,
        category: 'incident',
        reviewStatus: 'candidate',
        title,
        summary: `${title}。这是已归档的来源线索，尚待核实。`,
        publishedAt: published,
        effectiveFrom: published,
        effectiveTo: null,
        originalUrl: 'https://example.org/news/' + externalId,
        paragraphs: [{ id: 'p1', text: title }],
        raw: { timeBasis: 'publication', requiresEffectiveTimeReview: true },
        ...extra,
      }),
    );
  }
  function post(path: string, body: object) {
    return request(api.app.getHttpServer())
      .post('/api/v1/agent' + path)
      .set('Cookie', cookie)
      .set('Origin', origin)
      .set('X-CSRF-Token', csrf)
      .set('Idempotency-Key', randomUUID())
      .send(body);
  }
  const get = (path: string) =>
    request(api.app.getHttpServer())
      .get('/api/v1' + path)
      .set('Cookie', cookie);
  async function completed(id: string) {
    for (let attempt = 0; attempt < 120; attempt++) {
      if (workerError) throw workerError;
      const detail = await get('/agent/tasks/' + id).expect(200);
      if (detail.body.task.status === 'completed') return detail.body;
      if (detail.body.task.status === 'failed') throw new Error(JSON.stringify(detail.body.task));
      await delay(100);
    }
    throw new Error('Intelligence worker did not finish');
  }
  function sse(delta: object, reason: string) {
    const envelope = {
      id: 'intelligence-fixture',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'deepseek-flash',
    };
    return new Response(
      `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  }
  const provider: typeof fetch = async (_url, init) => {
    bodies.push(String(init?.body));
    const body = JSON.parse(String(init?.body));
    const payload = JSON.parse(body.messages.at(-1).content);
    const tools = payload.completedTools ?? [];
    const reads = payload.completedReadReferences ?? [];
    const evidence = payload.publicEvidence as { reference: string; kind: string }[];
    const calls: { name: string; args: object }[] = [];
    if (!tools.includes('search_intelligence'))
      calls.push({ name: 'search_intelligence', args: {} });
    if (!tools.includes('get_intelligence_source_status'))
      calls.push({ name: 'get_intelligence_source_status', args: {} });
    for (const item of evidence.slice(0, 3))
      if (!reads.includes(item.reference))
        calls.push({
          name: item.kind === 'marine' ? 'read_marine_forecast' : 'read_intelligence',
          args: { reference: item.reference },
        });
    if (calls.length)
      return sse(
        {
          role: 'assistant',
          tool_calls: calls.map((call, index) => ({
            index,
            id: `call-${index}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        },
        'tool_calls',
      );
    return sse(
      {
        role: 'assistant',
        content: `检索发现：候选线索提供了相关海事情报 [${evidence[0]!.reference}]。\n来源与时间：参见本地来源卡片。\n局限：待审核资料不代表已确认影响。`,
      },
      'stop',
    );
  };

  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    infra = await createInfrastructure();
    await runMigrations(infra);
    await infra.s3
      .send(new CreateBucketCommand({ Bucket: infra.config.s3Bucket }))
      .catch((error: { name: string }) => {
        if (!['BucketAlreadyExists', 'BucketAlreadyOwnedByYou'].includes(error.name)) throw error;
      });
    for (const [visibility, id] of Object.entries(sources)) {
      const source = IntelligenceSourceSchema.parse({
        sourceId: id,
        name: '情报检索测试源',
        kind: 'api',
        adapter: 'rss',
        visibility: visibility === 'public' ? 'public' : 'internal',
        endpoint: 'https://example.org/feed',
        allowedHosts: ['example.org'],
        authorizationConfirmed: true,
        enabled: true,
      });
      await infra.pool.query(
        'INSERT INTO intelligence_sources(id,config,last_successful_at) VALUES($1,$2::jsonb,now())',
        [id, JSON.stringify(source)],
      );
    }
    await event('collision', '上海港货船碰撞事故');
    await event('collision-en', 'Cargo vessel collision near port');
    await event('mention', '东海航运事故报道', { category: 'other' });
    navigation = await event('warning', '沪航警 海上作业公告', {
      category: 'navigation-warning',
      raw: { timeBasis: 'publication' },
      relations: [
        {
          kind: 'applies-to',
          geometry: { type: 'Point', coordinates: [123, 28] },
          basis: '来源明确坐标',
          paragraphIds: ['p1'],
          reviewStatus: 'candidate',
          origin: 'source',
        },
      ],
    });
    await event('unknown-date', '无发布时间公告', {
      category: 'notice',
      raw: { timeBasis: 'unknown', publicationTimeKnown: false, requiresEffectiveTimeReview: true },
    });
    await event('withdrawn', '撤回的货船碰撞事故', { status: 'withdrawn' });
    await event('rejected', '被拒绝的货船碰撞事故', { reviewStatus: 'rejected' });
    await event('private', '内部绝密事故记录', {}, sources.internal);
    const historical = await event('historical', '过去的台风记录', {
      category: 'weather',
      publishedAt: new Date(now.getTime() - 60 * 86400_000).toISOString(),
      effectiveFrom: new Date(now.getTime() - 60 * 86400_000).toISOString(),
    });
    await event('historical', '过去的台风记录修订', {
      category: 'weather',
      version: 2,
      supersedesId: historical.id,
      publishedAt: historical.publishedAt,
      effectiveFrom: historical.effectiveFrom,
    });
    password = randomUUID();
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,$2,'operator')",
      [owner, await hashPassword(password)],
    );
    api = await createApi(infra, { scheduler: false, origins: [origin] });
    const login = await request(api.app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ username: owner, password })
      .expect(200);
    cookie = (login.headers['set-cookie'] as unknown as string[])[0]!.split(';')[0]!;
    csrf = login.body.csrfToken;
    worker = runAgentWorker(infra, abort.signal, {
      enabled: true,
      apiKey: 'synthetic-model-key',
      maxRecords: 50000,
      fetch: provider,
    }).catch((error: unknown) => {
      workerError = error;
    });
  });
  afterAll(async () => {
    abort.abort();
    await worker;
    await api?.stop();
    if (previousEnabled === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = previousEnabled;
    if (!infra) return;
    for (const table of [
      'agent_events',
      'agent_steps',
      'agent_results',
      'agent_messages',
      'agent_tasks',
    ]) {
      const where = ['agent_steps', 'agent_results'].includes(table)
        ? 'task_id IN(SELECT id FROM agent_tasks WHERE owner_id=$1)'
        : table === 'agent_tasks'
          ? 'owner_id=$1'
          : 'session_id IN(SELECT id FROM agent_sessions WHERE owner_id=$1)';
      await infra.pool.query(`DELETE FROM ${table} WHERE ${where}`, [owner]);
    }
    await infra.pool.query('DELETE FROM agent_sessions WHERE owner_id=$1', [owner]);
    await infra.pool.query('DELETE FROM audit WHERE user_id=$1', [owner]);
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    await infra.pool.query(
      'DELETE FROM fusion_ready_outbox WHERE id IN(SELECT id FROM intelligence_events WHERE source_id=ANY($1::text[]))',
      [Object.values(sources)],
    );
    await infra.pool.query(
      'DELETE FROM intelligence_relations WHERE event_id IN(SELECT id FROM intelligence_events WHERE source_id=ANY($1::text[]))',
      [Object.values(sources)],
    );
    await infra.pool.query(
      'DELETE FROM intelligence_reviews WHERE event_id IN(SELECT id FROM intelligence_events WHERE source_id=ANY($1::text[]))',
      [Object.values(sources)],
    );
    await infra.pool.query('DELETE FROM intelligence_events WHERE source_id=ANY($1::text[])', [
      Object.values(sources),
    ]);
    await infra.pool.query('DELETE FROM intelligence_archives WHERE source_id=ANY($1::text[])', [
      Object.values(sources),
    ]);
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=ANY($1::text[])', [
      Object.values(sources),
    ]);
    await infra.close();
  });

  it('searches Chinese short terms and English equivalents while excluding withdrawn/rejected records', async () => {
    const short = await searchIntelligence(infra, { keyword: '航警', sourceIds: [sources.public] });
    expect(short.items.map((item) => item.id)).toContain(navigation.id);
    const result = await searchIntelligence(infra, {
      keyword: '船舶事故',
      sourceIds: [sources.public],
    });
    expect(result.items.some((item) => item.title === 'Cargo vessel collision near port')).toBe(
      true,
    );
    expect(
      result.items.every((item) => item.status !== 'withdrawn' && item.reviewStatus !== 'rejected'),
    ).toBe(true);
    expect(result.items.find((item) => item.externalId === 'collision')?.effectiveFrom).toBeNull();
  });
  it('preserves independent historical windows and latest source revisions', async () => {
    expect(
      (await searchIntelligence(infra, { keyword: '台风', sourceIds: [sources.public] })).items,
    ).toHaveLength(0);
    const result = await searchIntelligence(infra, {
      keyword: '台风',
      sourceIds: [sources.public],
      from: new Date(now.getTime() - 90 * 86400_000).toISOString(),
      to: now.toISOString(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.version).toBe(2);
  });
  it('separates known geometry from place mentions and never invents a location', async () => {
    const spec = {
      sourceIds: [sources.public],
      bbox: [120, 23, 130, 34] as [number, number, number, number],
      locationKeyword: '东海',
    };
    const result = await searchIntelligence(infra, spec);
    expect(result.items.find((item) => item.id === navigation.id)?.matchBasis).toBe('geometry');
    expect(result.items.find((item) => item.externalId === 'mention')).toMatchObject({
      matchBasis: 'mention',
      geometry: null,
    });
    expect((await searchIntelligence(infra, { sourceIds: [sources.public] })).items[0]!.id).toBe(
      navigation.id,
    );
    const unknown = (
      await searchIntelligence(infra, { sourceIds: [sources.public], keyword: '无发布时间' })
    ).items[0]!;
    expect(unknown.publishedAt).toBeNull();
    expect(unknown.timeBasis).toBe('unknown');
    expect(unknown.effectiveFrom).toBeNull();
    expect(
      (
        await searchIntelligence(infra, {
          sourceIds: [sources.public],
          keyword: '无发布时间',
          timeMode: 'effective',
        })
      ).items,
    ).toHaveLength(0);
  });
  it('keeps provider update, event occurrence and collection time distinct', async () => {
    const occurred = new Date(now.getTime() - 7200_000).toISOString();
    await event('earthquake', 'USGS 地震事件', {
      category: 'environment',
      effectiveFrom: occurred,
      raw: { timeBasis: 'effective', publishedTimeBasis: 'provider-updated' },
    });
    const result = await searchIntelligence(infra, {
      keyword: '地震',
      category: 'environment',
      sourceIds: [sources.public],
    });
    expect(result.items[0]).toMatchObject({
      publishedAt: null,
      observedAt: published,
      effectiveFrom: occurred,
      timeBasis: 'effective',
    });
    expect(result.items[0]!.collectedAt).not.toBe(published);
  });
  it('resolves registered location aliases locally and preserves ambiguous candidates', async () => {
    const objectIds = [`${prefix}-port-a`, `${prefix}-port-b`];
    try {
      for (let index = 0; index < objectIds.length; index++) {
        await infra.pool.query(
          "INSERT INTO intelligence_objects(id,kind,name,data) VALUES($1,'port',$2,$3::jsonb)",
          [
            objectIds[index],
            `${prefix}港口${index}`,
            JSON.stringify({ aliases: [`${prefix}共同别名`] }),
          ],
        );
      }
      expect(await resolveIntelligenceObjects(infra, `查${prefix}港口0情报`)).toEqual([
        { id: objectIds[0], name: `${prefix}港口0` },
      ]);
      expect(await resolveIntelligenceObjects(infra, `查${prefix}共同别名情报`)).toHaveLength(2);
    } finally {
      await infra.pool.query('DELETE FROM intelligence_objects WHERE id=ANY($1)', [objectIds]);
    }
  });
  it('paginates a frozen query and rejects reuse of a cursor under different filters', async () => {
    const spec = { keyword: '船舶事故', sourceIds: [sources.public] };
    const first = await searchIntelligence(infra, spec, { limit: 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await searchIntelligence(infra, spec, { limit: 1, cursor: first.nextCursor! });
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    expect(second.asOf).toBe(first.asOf);
    await expect(
      searchIntelligence(infra, { ...spec, keyword: '航警' }, { cursor: first.nextCursor! }),
    ).rejects.toThrow('Cursor does not belong');
    const apiResult = await get(
      '/intelligence/search?keyword=%E8%88%AA%E8%AD%A6&sourceIds=' + sources.public,
    ).expect(200);
    expect(apiResult.body.items[0].id).toBe(navigation.id);
    await get('/intelligence/search?from=2026-10-13T00:00:00Z&to=2026-10-12T00:00:00Z').expect(400);
  });
  it('handles named-region intelligence and marine scopes independently from previous AIS selection', async () => {
    const named = intelligenceSelection('东海近期有哪些航行警告', now);
    const snapshot = await searchAgentIntelligence(infra, { ...named, bbox: [-10, -10, 0, 0] });
    expect(
      snapshot.evidence.some((item) => item.kind === 'event' && item.event.id === navigation.id),
    ).toBe(true);
    const marine = await searchAgentIntelligence(infra, {
      purpose: 'intelligence_search',
      intelligenceQuery: { kind: 'marine', samplePointId: 'not-covered' },
      intelligenceTimeRange: {
        from: now.toISOString(),
        to: new Date(now.getTime() + 86400_000).toISOString(),
      },
    });
    expect(marine.evidence).toEqual([]);
    expect(marine.coverageNotes.join(' ')).toContain('没有覆盖');
  });
  it('uses the trigram index for selective text retrieval on a realistic stored collection', async () => {
    await infra.pool.query(
      `INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event)
      SELECT $1::text||':index:'||n,$2::text,'index-'||n,1,$3::timestamptz,$3::timestamptz,
        jsonb_build_object('id',$1::text||':index:'||n,'sourceId',$2::text,'externalId','index-'||n,'version',1,
          'title',CASE WHEN n=5000 THEN 'quartzmarkerxy rare bulletin' ELSE 'unrelated bulletin '||n END,
          'summary',repeat(md5(n::text),20),'paragraphs','[]'::jsonb,'raw','{}'::jsonb,
          'status','active','reviewStatus','confirmed','category','other','publishedAt',$3::text,'effectiveFrom',$3::text,'effectiveTo',NULL)
      FROM generate_series(1,5000) n`,
      [prefix, sources.public, published],
    );
    await infra.pool.query('VACUUM ANALYZE intelligence_events');
    const plan = await infra.pool.query(
      "EXPLAIN (FORMAT JSON) SELECT id FROM intelligence_events WHERE search_text ILIKE '%quartzmarkerxy%'",
    );
    expect(JSON.stringify(plan.rows)).toContain('intelligence_events_search_trgm');
    const result = await searchIntelligence(infra, {
      keyword: 'quartzmarkerxy',
      sourceIds: [sources.public],
    });
    expect(result.total).toBe(1);
    expect(result.items[0]!.title).toContain('quartzmarkerxy');
  });
  it('executes real local search tools and stores cited evidence without starting a collection', async () => {
    const before = (await infra.pool.query('SELECT count(*) FROM intelligence_ingestion_runs'))
      .rows[0].count;
    const session = await post('/sessions', { title: '本地情报验证' }).expect(201);
    const submission = await post(`/sessions/${session.body.id}/messages`, {
      content: '最近有什么航运事故',
    }).expect(202);
    const detail = await completed(submission.body.task.id);
    expect(detail.task.intent).toBe('intelligence_search');
    expect(detail.intelligenceResult.kind).toBe('intelligence_search');
    expect(detail.task.summary).toMatch(/\[I\d+\]/);
    expect(detail.steps.map((step: { name: string }) => step.name)).toContain(
      'search_intelligence',
    );
    expect(detail.steps.map((step: { name: string }) => step.name)).toContain('read_intelligence');
    expect(
      (await infra.pool.query('SELECT count(*) FROM intelligence_ingestion_runs')).rows[0].count,
    ).toBe(before);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('内部绝密');
      expect(body).not.toContain(sources.internal);
      expect(body).not.toContain(sources.public);
      expect(body).not.toContain(owner);
      expect(body).not.toContain('https://example.org');
    }
    const messages = (await get('/agent/sessions/' + session.body.id).expect(200)).body.messages;
    expect(
      messages.findLast((message: { role: string }) => message.role === 'assistant').resultVersion,
    ).toBe(detail.task.resultVersion);
    const fixed = await get(
      `/agent/tasks/${detail.task.id}?resultVersion=${detail.task.resultVersion}`,
    ).expect(200);
    expect(fixed.body.intelligenceResult.evidence).toEqual(detail.intelligenceResult.evidence);
  });

  it.runIf(process.env.AIS_INTELLIGENCE_BROWSER === '1')(
    'reads a cited source in the real browser with real local API and worker',
    async () => {
      await api.app.listen(0, '127.0.0.1');
      const address = api.app.getHttpServer().address() as { port: number };
      const browser = await chromium.launch({
        executablePath: chromium.executablePath(),
        headless: true,
      });
      try {
        const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
        await context.route('**/api/v1/**', async (route) => {
          const url = new URL(route.request().url());
          const response = await route.fetch({
            url: `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
            headers: { ...route.request().headers(), origin },
          });
          await route.fulfill({ response });
        });
        await context.routeWebSocket('**/api/v1/live*', (socket) => socket.close());
        const page = await context.newPage();
        await page.goto(origin + '/login');
        await page.getByLabel('用户名', { exact: true }).fill(owner);
        await page.getByLabel('密码', { exact: true }).fill(password);
        await page.getByRole('button', { name: /进入工作空间/ }).click();
        const input = page.getByTestId('chart-agent-composer').getByLabel('分析问题或继续追问');
        await input.waitFor();
        await input.fill('东海近期有哪些航行警告');
        await input.press('Enter');
        await page
          .getByRole('button', { name: /查看情报来源 \[I\d+\]/ })
          .first()
          .waitFor({ timeout: 20_000 });
        await page
          .getByRole('button', { name: /查看情报来源 \[I\d+\]/ })
          .first()
          .click();
        const source = page.getByRole('dialog', { name: '查看情报引用' });
        await source.waitFor();
        await source
          .getByText(/沪航警/)
          .first()
          .waitFor();
        expect(await source.innerText()).toContain('沪航警');
        await page.screenshot({
          path: '.data/intelligence-search-live-browser.png',
          fullPage: true,
        });
      } finally {
        await browser.close();
      }
    },
  );
});
