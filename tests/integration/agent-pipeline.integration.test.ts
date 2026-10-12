import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { PositionObservation, TopicDefinitionId } from '../../packages/contracts';
import { IntelligenceInputSchema } from '../../packages/contracts/intelligence';
import {
  createInfrastructure,
  runMigrations,
  saveHistoryBatch,
  saveLatestBatch,
  type Infrastructure,
} from '../../packages/infrastructure';
import { saveIntelligenceEvent } from '../../packages/infrastructure/fusion-data';
import {
  cancelAgentTask,
  claimAgentTask,
  createAgentSession,
  getAgentSession,
  getAgentTaskContext,
  readAgentEvents,
  submitAgentMessage,
} from '../../packages/infrastructure/agent';
import {
  AGENT_CONSUMER,
  AGENT_STREAM,
  ensureAgentBus,
  processAgentTask,
  publishRunnableAgentTasks,
  runAgentWorker,
} from '../../apps/agent';

function sse(delta: Record<string, unknown>, reason: string) {
  const envelope = {
    id: 'pipeline-fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
  };
  return new Response(
    `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('agent durable queue and real local algorithms', () => {
  let infra: Infrastructure;
  const owner = randomUUID();
  const prefix = `agent-pipeline-${randomUUID()}`;
  const mmsi = String(980000000 + Math.floor(Math.random() * 999999));
  const bbox: [number, number, number, number] = [145.1, 25.1, 145.9, 25.9];
  const from = new Date(Date.now() - 20 * 60_000).toISOString();
  let documentId: string;
  let topicCount: number;
  const bodies: string[] = [];
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await ensureAgentBus(infra);
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
      [owner],
    );
    await infra.pool.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2::jsonb)', [
      prefix,
      JSON.stringify({
        sourceId: prefix,
        name: 'Agent pipeline fixture',
        kind: 'manual',
        enabled: false,
      }),
    ]);
    const document = await saveIntelligenceEvent(
      infra,
      IntelligenceInputSchema.parse({
        sourceId: prefix,
        externalId: 'restriction',
        version: 1,
        category: 'port-restriction',
        title: 'Sensitive local notice title',
        summary: 'Sensitive local notice summary',
        publishedAt: from,
        effectiveFrom: from,
        effectiveTo: null,
        bbox,
        mmsis: [mmsi],
        paragraphs: [{ id: 'local-paragraph', text: 'Sensitive original notice paragraph' }],
        raw: { localSecret: 'never-external' },
      }),
    );
    documentId = document.id;
    const positions: PositionObservation[] = [0, 1, 2].map((index) => ({
      schemaVersion: 1,
      cleaningVersion: 1,
      kind: 'position',
      eventId: `${prefix}-${index}`,
      captureId: `${prefix}-capture`,
      mmsi,
      sourceId: prefix,
      sourceKind: 'fixture-http',
      sourcePriority: 100,
      runId: null,
      receivedAt: from,
      observedAt: new Date(Date.parse(from) + index * 60_000).toISOString(),
      lat: 25.5,
      lon: 145.5,
      sogKnots: 1,
      cogDegrees: 0,
      headingDegrees: null,
      rotDegPerMinute: null,
      navigationStatus: null,
      receptionType: 'UNKNOWN',
      quality: [],
    }));
    await saveLatestBatch(infra, positions);
    await saveHistoryBatch(infra, positions);
    topicCount = Number(
      (await infra.pool.query('SELECT count(*) FROM topic_instances')).rows[0].count,
    );
  });
  afterAll(async () => {
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
    await infra.pool.query('DELETE FROM users WHERE id=$1', [owner]);
    const archives = await infra.pool.query(
      'SELECT object_key FROM intelligence_archives WHERE source_id=$1',
      [prefix],
    );
    for (const archive of archives.rows)
      await infra.s3.send(
        new DeleteObjectCommand({ Bucket: infra.config.s3Bucket, Key: archive.object_key }),
      );
    await infra.pool.query(
      'DELETE FROM fusion_ready_outbox WHERE id IN (SELECT id FROM intelligence_events WHERE source_id=$1)',
      [prefix],
    );
    for (const table of ['intelligence_relations', 'intelligence_reviews'])
      await infra.pool.query(
        `DELETE FROM ${table} WHERE event_id IN (SELECT id FROM intelligence_events WHERE source_id=$1)`,
        [prefix],
      );
    await infra.pool.query('DELETE FROM intelligence_events WHERE source_id=$1', [prefix]);
    await infra.pool.query('DELETE FROM intelligence_archives WHERE source_id=$1', [prefix]);
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=$1', [prefix]);
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
    const identifiers = await infra.pool.query(
      'DELETE FROM vessel_identifiers WHERE identifier=$1 RETURNING vessel_id',
      [mmsi],
    );
    for (const row of identifiers.rows)
      await infra.pool.query('DELETE FROM vessel_objects WHERE id=$1', [row.vessel_id]);
    await infra.clickhouse.command({
      query: 'ALTER TABLE positions DELETE WHERE sourceId={source:String}',
      query_params: { source: prefix },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await infra.close();
  });

  function provider(
    algorithm: TopicDefinitionId,
    beforeSummary?: () => Promise<void>,
  ): typeof fetch {
    let calls = 0;
    return async (_input, init) => {
      bodies.push(String(init?.body));
      if (++calls === 1)
        return sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'choose',
                type: 'function',
                function: { name: 'create_task', arguments: JSON.stringify({ algorithm }) },
              },
              {
                index: 1,
                id: 'run',
                type: 'function',
                function: { name: 'run_analysis', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        );
      await beforeSummary?.();
      return sse(
        {
          role: 'assistant',
          content:
            '观测事实：V1 存在三个区域内观测点 [E1]。规则匹配：已按所选算法完成 [E1]。推测与限制：共现无法确定因果，需要人工核验。',
        },
        'stop',
      );
    };
  }
  async function deliver(taskId: string, fetcher: typeof fetch) {
    await publishRunnableAgentTasks(infra);
    const consumer = await infra.js.consumers.get(AGENT_STREAM, AGENT_CONSUMER);
    const messages = await consumer.fetch({ max_messages: 100, expires: 1000 });
    let delivered = false;
    try {
      for await (const message of messages) {
        const job = message.json<{ taskId: string }>();
        if (job.taskId === taskId) {
          expect(
            await processAgentTask(infra, taskId, { apiKey: 'synthetic-key', fetch: fetcher }),
          ).toBe(true);
          delivered = true;
        }
        message.ack();
        if (delivered) break;
      }
    } finally {
      await messages.close();
    }
    expect(delivered).toBe(true);
  }
  for (const [algorithm, goal] of [
    ['port-restriction', '分析港口限制'],
    ['area-low-speed-notice', '分析区域低速活动'],
  ] as const) {
    it(`${algorithm}: dispatches via NATS and saves non-empty immutable evidence and versioned summary`, async () => {
      const session = await createAgentSession(infra, owner, goal);
      const { task } = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
        content: `${goal} ${mmsi} ${prefix}`,
        bbox,
        historyHours: 24,
      });
      await deliver(task.id, provider(algorithm));
      const completed = (await getAgentTaskContext(infra, task.id))!;
      expect(completed.task.status, completed.task.error ?? 'task status').toBe('completed');
      expect(completed.task).toMatchObject({
        definitionId: algorithm,
        resultVersion: 1,
        summaryResultVersion: 1,
        modelCalls: 2,
      });
      expect(completed.results).toHaveLength(1);
      expect(completed.results[0]).toMatchObject({ documentId, mmsi, definitionId: algorithm });
      expect(completed.results[0]!.evidence.ais).toHaveLength(3);
      expect(completed.results[0]!.evidence.documents[0]!.raw).toEqual({
        localSecret: 'never-external',
      });
      expect(completed.steps.some((step) => step.key === 'input_snapshot')).toBe(true);
      expect(
        Number((await infra.pool.query('SELECT count(*) FROM topic_instances')).rows[0].count),
      ).toBe(topicCount);
      const feed = (await readAgentEvents(infra, owner, session.id, '0', 200))!;
      expect(feed.items.at(-1)?.type).toBe('task.completed');
      expect(
        (await readAgentEvents(infra, owner, session.id, feed.nextCursor, 200))?.items,
      ).toEqual([]);
      expect((await getAgentSession(infra, owner, session.id))?.messages.at(-1)?.content).toContain(
        '[E1]',
      );
      for (const body of bodies)
        for (const value of [
          mmsi,
          prefix,
          '145.5',
          '25.5',
          from,
          'Sensitive original',
          'never-external',
          documentId,
          task.id,
        ])
          expect(body).not.toContain(value);
    });
  }
  it('recovers an expired claim and reuses previous evidence without issuing a new data query', async () => {
    const session = await createAgentSession(infra, owner, 'Recover');
    const first = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      bbox,
      historyHours: 24,
    });
    const abandoned = (await claimAgentTask(infra, 'dead-worker', first.task.id))!;
    await infra.pool.query(
      "UPDATE agent_tasks SET lease_until=now()-interval '1 second' WHERE id=$1",
      [first.task.id],
    );
    await deliver(first.task.id, provider('port-restriction'));
    const restored = (await getAgentTaskContext(infra, first.task.id))!;
    expect(restored.task.generation).toBe(abandoned.generation + 1);
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '解释上次证据',
      bbox,
      historyHours: 24,
    });
    await processAgentTask(infra, next.task.id, {
      apiKey: 'synthetic-key',
      fetch: async () =>
        sse(
          {
            role: 'assistant',
            content:
              '观测事实：复核上次 V1 的三个观测点 [E1]。规则匹配：港口限制规则 [E1]。推测与限制：需要人工核验。',
          },
          'stop',
        ),
    });
    const followup = (await getAgentTaskContext(infra, next.task.id))!;
    expect(followup.task.status, followup.task.error ?? 'followup').toBe('completed');
    expect(followup.task.from).toBe(restored.task.from);
    expect(followup.task.to).toBe(restored.task.to);
    expect(followup.results).toEqual(restored.results);
    expect(followup.steps.find((step) => step.key === 'input_snapshot')?.output).toEqual(
      restored.steps.find((step) => step.key === 'input_snapshot')?.output,
    );
  });
  it('preserves the local goal across missing-region clarification', async () => {
    const session = await createAgentSession(infra, owner, 'Clarification');
    const first = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析区域低速活动',
      historyHours: 24,
    });
    expect(first.task.status).toBe('awaiting_input');
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '已确认区域，请执行',
      bbox,
      historyHours: 24,
    });
    await deliver(next.task.id, provider('area-low-speed-notice'));
    const completed = (await getAgentTaskContext(infra, next.task.id))!;
    expect(completed.task.status, completed.task.error ?? 'clarification').toBe('completed');
    expect(completed.task.definitionId).toBe('area-low-speed-notice');
    expect(completed.results).toHaveLength(1);
  });
  it('continues the newest budget-limited result instead of an older completed algorithm', async () => {
    const session = await createAgentSession(infra, owner, 'Continue budget');
    const port = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析港口限制',
      bbox,
      historyHours: 24,
    });
    await processAgentTask(infra, port.task.id, {
      apiKey: 'synthetic-key',
      fetch: provider('port-restriction'),
    });
    const slow = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析低速活动',
      bbox,
      historyHours: 24,
    });
    await processAgentTask(infra, slow.task.id, {
      apiKey: 'synthetic-key',
      fetch: provider('area-low-speed-notice'),
      maxModelCalls: 1,
    });
    const partial = (await getAgentTaskContext(infra, slow.task.id))!;
    expect(partial.task.status).toBe('awaiting_input');
    expect(partial.task.resultVersion).toBe(1);
    const next = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '继续',
      bbox,
      historyHours: 24,
    });
    const requests: string[] = [];
    await processAgentTask(infra, next.task.id, {
      apiKey: 'synthetic-key',
      fetch: async (_url, init) => {
        requests.push(String(init?.body));
        return sse(
          {
            role: 'assistant',
            content:
              '观测事实：V1 有三个低速观测点 [E1]。规则匹配：完成低速共现分析 [E1]。推测与限制：共现无法确定因果。',
          },
          'stop',
        );
      },
    });
    const completed = (await getAgentTaskContext(infra, next.task.id))!;
    expect(completed.task.status, completed.task.error ?? 'budget continuation').toBe('completed');
    expect(completed.task.definitionId).toBe('area-low-speed-notice');
    expect(completed.results).toEqual(partial.results);
    expect(completed.task.from).toBe(partial.task.from);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toContain('area-low-speed-notice');
  });
  it('cancellation during the final provider response fences summary publication', async () => {
    const session = await createAgentSession(infra, owner, 'Cancel');
    const { task } = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '分析低速活动',
      bbox,
      historyHours: 24,
    });
    await deliver(
      task.id,
      provider('area-low-speed-notice', async () => {
        await cancelAgentTask(infra, owner, task.id);
      }),
    );
    const cancelled = (await getAgentTaskContext(infra, task.id))!;
    expect(cancelled.task.status).toBe('cancelled');
    expect(cancelled.task.summary).toBeNull();
    expect(cancelled.results).toHaveLength(1);
    expect(
      cancelled.messages.some(
        (message) => message.taskId === task.id && message.role === 'assistant',
      ),
    ).toBe(false);
  });
  it('keeps the worker alive across slow model responses and processes the next queued message', async () => {
    const session = await createAgentSession(infra, owner, 'Slow worker conversation');
    const submitted = [];
    for (const content of ['你好', '你能做什么'])
      submitted.push(
        await submitAgentMessage(infra, owner, session.id, randomUUID(), {
          content,
          historyHours: 24,
        }),
      );
    const controller = new AbortController();
    let providerCalls = 0;
    let workerDone = false;
    let failure: unknown = null;
    const worker = runAgentWorker(infra, controller.signal, {
      enabled: true,
      apiKey: 'synthetic-test-key',
      maxRecords: 50000,
      fetch: async () => {
        providerCalls++;
        // Longer than the pull iterator's 1000ms expiry and two 500ms heartbeat intervals.
        await delay(2200);
        return sse({ role: 'assistant', content: '您好，我可以协助海上情报研判。' }, 'stop');
      },
    })
      .catch((error) => {
        failure = error;
      })
      .finally(() => {
        workerDone = true;
      });
    try {
      const deadline = Date.now() + 15000;
      while (!workerDone && Date.now() < deadline) {
        if ((await getAgentTaskContext(infra, submitted[1]!.task.id))?.task.status === 'completed')
          break;
        await delay(100);
      }
    } finally {
      controller.abort();
      await worker;
    }
    expect(failure).toBeNull();
    expect(providerCalls).toBe(2);
    for (const entry of submitted) {
      const saved = (await getAgentTaskContext(infra, entry.task.id))!;
      expect(saved.task.status).toBe('completed');
      expect(saved.task.modelCalls).toBe(1);
      expect(saved.task.resultVersion).toBe(0);
      expect(
        saved.messages.filter(
          (message) => message.taskId === entry.task.id && message.role === 'assistant',
        ),
      ).toHaveLength(1);
    }
  });
});
