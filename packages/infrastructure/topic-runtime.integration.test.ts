import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createInfrastructure, type Infrastructure } from './clients';
import { CreateTopicInstanceSchema, type TopicDataset } from '../contracts/topics';
import {
  claimTopicRun,
  completeTopicRun,
  createTopicInstance,
  getAnalysisRevisions,
  getTopicRun,
  listTopicRuns,
  queueTopicRun,
  listTopicInstances,
  readLiveAnalysisFeed,
  recordTopicReady,
  saveTopicInput,
  scheduleTopicRuns,
  setTopicState,
} from './topics';
import { evaluateTopic } from '../domain/topics';
import { ensureAnalysisBus, ensureTopicConsumer, topicDurableName } from '../../apps/topics/index';
import { ensureFusionBus } from './fusion-data';

let infra: Infrastructure;
const ids: string[] = [];
beforeAll(async () => {
  infra = await createInfrastructure();
  await ensureFusionBus(infra);
  await ensureAnalysisBus(infra);
});
afterAll(async () => {
  if (!infra) return;
  for (const id of ids) {
    try {
      await infra.jsm.consumers.delete('FUSION_READY', topicDurableName(id));
    } catch {
      /* May not have created a consumer. */
    }
    await infra.pool.query('DELETE FROM analysis_feed WHERE instance_id=$1', [id]);
    await infra.pool.query(
      'DELETE FROM analysis_revisions WHERE result_id IN (SELECT id FROM analysis_results WHERE instance_id=$1)',
      [id],
    );
    await infra.pool.query('DELETE FROM analysis_results WHERE instance_id=$1', [id]);
    await infra.pool.query('DELETE FROM topic_event_receipts WHERE instance_id=$1', [id]);
    await infra.pool.query('DELETE FROM topic_runs WHERE instance_id=$1', [id]);
    await infra.pool.query('DELETE FROM topic_instances WHERE id=$1', [id]);
  }
  await infra.close();
});
async function instance() {
  const value = await createTopicInstance(
    infra,
    CreateTopicInstanceSchema.parse({
      definitionId: 'port-restriction',
      name: `integration-${randomUUID()}`,
      enabled: true,
      config: { bbox: [120, 20, 123, 24] },
    }),
  );
  ids.push(value.id);
  return value;
}
it('persists warmup, coalesces duplicate/high-rate arrivals and fences an expired lease and a disabled generation', async () => {
  const topic = await instance();
  const run = await queueTopicRun(infra, topic.id, 'warmup', 'warmup');
  expect((await queueTopicRun(infra, topic.id, 'warmup', 'warmup'))?.id).toBe(run?.id);
  const first = await claimTopicRun(infra, undefined, topic.id);
  expect(first).not.toBeNull();
  await infra.pool.query(
    "UPDATE topic_runs SET lease_until=now()-interval '1 second' WHERE id=$1",
    [run!.id],
  );
  const second = await claimTopicRun(infra, undefined, topic.id);
  expect(second?.token).not.toBe(first?.token);
  expect(await completeTopicRun(infra, first!, [])).toBe(false);
  const now = new Date().toISOString();
  const dataset: TopicDataset = {
    from: second!.run.from,
    to: second!.run.to,
    queriedAt: now,
    ais: [],
    intelligence: [],
  };
  await saveTopicInput(infra, second!, dataset);
  expect(await completeTopicRun(infra, second!, [])).toBe(true);
  expect((await getTopicRun(infra, run!.id))?.inputSnapshot).toEqual(dataset);
  for (let i = 0; i < 30; i++)
    await recordTopicReady(infra, topic.id, { id: `event-${i}`, from: now, to: now });
  await recordTopicReady(infra, topic.id, { id: 'event-1', from: now, to: now });
  await scheduleTopicRuns(infra);
  const queued = (await listTopicRuns(infra, topic.id)).filter((r) => r.status === 'queued');
  expect(queued).toHaveLength(1);
  expect(
    (
      await infra.pool.query(
        'SELECT count(*)::int AS count FROM topic_event_receipts WHERE instance_id=$1',
        [topic.id],
      )
    ).rows[0].count,
  ).toBe(30);
  const pending = await claimTopicRun(infra, undefined, topic.id);
  expect(pending).not.toBeNull();
  const disabled = await setTopicState(infra, topic.id, false);
  expect(disabled?.checkpoint).toBe(second!.run.to);
  expect(await completeTopicRun(infra, pending!, [])).toBe(false);
  const resumed = await setTopicState(infra, topic.id, true);
  expect(resumed?.checkpoint).toBe(second!.run.to);
  await setTopicState(infra, topic.id, false);
});
it('creates independent durable subscriptions with fan-out, and verifies concurrent bootstrap', async () => {
  const first = await instance();
  const second = await instance();
  await Promise.all([ensureAnalysisBus(infra), ensureAnalysisBus(infra)]);
  const consumers = await Promise.all([
    ensureTopicConsumer(infra, first.id),
    ensureTopicConsumer(infra, second.id),
  ]);
  const eventId = randomUUID();
  await infra.js.publish(
    'fusion.ready',
    JSON.stringify({
      id: eventId,
      kind: 'ais',
      from: new Date().toISOString(),
      to: new Date().toISOString(),
      recordIds: [],
      createdAt: new Date().toISOString(),
    }),
    { msgID: eventId },
  );
  for (const consumer of consumers) {
    let found = false;
    for (let i = 0; i < 1000; i++) {
      const message = await consumer.next({ expires: 1000 });
      if (!message) break;
      const event = message.json<{ id: string }>();
      message.ack();
      if (event.id === eventId) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  }
  await setTopicState(infra, first.id, false);
  await setTopicState(infra, second.id, false);
});
it('records immutable result revisions and hides old-generation notifications from the live feed', async () => {
  const topic = await instance();
  await queueTopicRun(infra, topic.id, randomUUID(), 'manual');
  const lease = await claimTopicRun(infra, undefined, topic.id);
  const time = new Date(Date.now() - 60_000).toISOString();
  const data: TopicDataset = {
    from: lease!.run.from,
    to: lease!.run.to,
    queriedAt: new Date().toISOString(),
    ais: [
      {
        recordId: 'point',
        mmsi: '413123456',
        occurredAt: time,
        longitude: 121,
        latitude: 22,
        speedOverGround: 2,
        shipType: 70,
        raw: {},
      },
    ],
    intelligence: [
      {
        id: 'doc',
        sourceId: 'test',
        externalId: 'external',
        version: 1,
        status: 'active',
        kind: 'port-restriction',
        title: '限制',
        effectiveFrom: lease!.run.from,
        effectiveTo: null,
        bbox: [120, 20, 123, 24],
        vesselTypes: [70],
        mmsis: [],
        paragraphs: [{ id: 'p1', text: '原始限制' }],
        raw: { original: '原始限制' },
      },
    ],
  };
  await saveTopicInput(infra, lease!, data);
  const [result] = evaluateTopic(topic, data);
  expect(result).toBeDefined();
  await completeTopicRun(infra, lease!, [result!]);
  expect(await getAnalysisRevisions(infra, result!.id)).toHaveLength(1);
  const feed = await readLiveAnalysisFeed(infra);
  expect(feed.items.some((e) => e.resultId === result!.id)).toBe(true);
  await setTopicState(infra, topic.id, false);
  const after = await readLiveAnalysisFeed(infra);
  expect(after.items.some((e) => e.resultId === result!.id)).toBe(false);
  expect(Number(after.nextCursor)).toBeGreaterThan(0);
});
it('does not let a new incremental run skip an unfinished historical checkpoint', async () => {
  const topic = await instance();
  const checkpoint = new Date(Date.now() - 3 * 86400_000).toISOString();
  await infra.pool.query("UPDATE topic_instances SET checkpoint=$2,status='warming' WHERE id=$1", [
    topic.id,
    checkpoint,
  ]);
  await queueTopicRun(infra, topic.id, randomUUID(), 'incremental');
  const lease = await claimTopicRun(infra, undefined, topic.id);
  await saveTopicInput(infra, lease!, {
    from: lease!.run.from,
    to: lease!.run.to,
    queriedAt: new Date().toISOString(),
    ais: [],
    intelligence: [],
  });
  await completeTopicRun(infra, lease!, []);
  const current = (await listTopicInstances(infra)).find((i) => i.id === topic.id);
  expect(current?.checkpoint).toBe(checkpoint);
  expect(current?.status).toBe('warming');
  await setTopicState(infra, topic.id, false);
});
it('bounds a long-lived notice to the instance monitoring horizon', async () => {
  const topic = await instance();
  await recordTopicReady(infra, topic.id, {
    id: randomUUID(),
    from: '2000-01-01T00:00:00.000Z',
    to: new Date().toISOString(),
  });
  const row = (
    await infra.pool.query('SELECT pending_from FROM topic_instances WHERE id=$1', [topic.id])
  ).rows[0];
  expect(new Date(row.pending_from).getTime()).toBe(
    Date.parse(topic.createdAt) - topic.config.historyHours * 3_600_000,
  );
  await setTopicState(infra, topic.id, false);
});
it('replays both sides of a delayed AIS observation to recover a low-speed window', async () => {
  const topic = await createTopicInstance(
    infra,
    CreateTopicInstanceSchema.parse({
      definitionId: 'area-low-speed-notice',
      name: `late-${randomUUID()}`,
      enabled: true,
      config: { bbox: [120, 20, 123, 24], windowMinutes: 60, minPositions: 3 },
    }),
  );
  ids.push(topic.id);
  const now = new Date().toISOString();
  await infra.pool.query("UPDATE topic_instances SET checkpoint=$2,status='ready' WHERE id=$1", [
    topic.id,
    now,
  ]);
  const at = Date.now() - 90 * 60_000;
  const lateAt = new Date(at).toISOString();
  await recordTopicReady(infra, topic.id, { id: randomUUID(), from: lateAt, to: lateAt });
  await scheduleTopicRuns(infra, 'area-low-speed-notice');
  const run = (await listTopicRuns(infra, topic.id)).find((r) => r.status === 'queued')!;
  expect(Date.parse(run.from)).toBeLessThanOrEqual(at - 60 * 60_000);
  expect(Date.parse(run.to)).toBeGreaterThanOrEqual(at + 2 * 60_000);
  expect(Date.parse(run.to)).toBeLessThanOrEqual(Date.now());
  const input: TopicDataset = {
    from: run.from,
    to: run.to,
    queriedAt: now,
    ais: [0, 1, 2].map((minute) => ({
      recordId: `p-${minute}`,
      mmsi: '413123456',
      occurredAt: new Date(at + minute * 60_000).toISOString(),
      longitude: 121,
      latitude: 22,
      speedOverGround: 2,
      shipType: 70,
      raw: { minute },
    })),
    intelligence: [
      {
        id: 'notice',
        sourceId: 'source',
        externalId: 'late-notice',
        version: 1,
        status: 'active',
        kind: 'notice',
        title: '区域公告',
        effectiveFrom: run.from,
        effectiveTo: null,
        bbox: [120, 20, 123, 24],
        vesselTypes: [],
        mmsis: [],
        paragraphs: [{ id: 'p', text: '观察区域' }],
        raw: {},
      },
    ],
  };
  expect(evaluateTopic(topic, input)).toHaveLength(1);
  await setTopicState(infra, topic.id, false);
});
it('claims oldest runnable work across instances so the oldest busy instance cannot starve a peer', async () => {
  const older = await instance();
  const newer = await instance();
  await infra.pool.query(
    "UPDATE topic_instances SET created_at=CASE WHEN id=$1 THEN '1970-01-01'::timestamptz ELSE '1980-01-01'::timestamptz END WHERE id=ANY($2::uuid[])",
    [older.id, [older.id, newer.id]],
  );
  const first = await queueTopicRun(infra, older.id, randomUUID());
  const waiting = await queueTopicRun(infra, newer.id, randomUUID());
  await infra.pool.query(
    "UPDATE topic_runs SET created_at=CASE WHEN id=$1 THEN '1990-01-01'::timestamptz ELSE '2000-01-01'::timestamptz END WHERE id=ANY($2::uuid[])",
    [first!.id, [first!.id, waiting!.id]],
  );
  const initial = await claimTopicRun(infra, 'port-restriction');
  expect(initial?.instance.id).toBe(older.id);
  await saveTopicInput(infra, initial!, {
    from: initial!.run.from,
    to: initial!.run.to,
    queriedAt: new Date().toISOString(),
    ais: [],
    intelligence: [],
  });
  await completeTopicRun(infra, initial!, []);
  const replenished = await queueTopicRun(infra, older.id, randomUUID());
  await infra.pool.query("UPDATE topic_runs SET created_at='2010-01-01' WHERE id=$1", [
    replenished!.id,
  ]);
  const next = await claimTopicRun(infra, 'port-restriction');
  expect(next?.instance.id).toBe(newer.id);
  await setTopicState(infra, older.id, false);
  await setTopicState(infra, newer.id, false);
});
it('retains a complete behavioral window while splitting a long incremental range', async () => {
  const topic = await createTopicInstance(
    infra,
    CreateTopicInstanceSchema.parse({
      definitionId: 'area-low-speed-notice',
      name: `split-${randomUUID()}`,
      enabled: true,
      config: { bbox: [120, 20, 123, 24], historyHours: 1, windowMinutes: 60, minPositions: 3 },
    }),
  );
  ids.push(topic.id);
  await infra.pool.query(
    "UPDATE topic_instances SET checkpoint=now(),status='ready',created_at=now()-interval '1 day' WHERE id=$1",
    [topic.id],
  );
  const now = Date.now();
  await recordTopicReady(infra, topic.id, {
    id: randomUUID(),
    from: new Date(now - 4 * 3600_000).toISOString(),
    to: new Date(now - 2 * 3600_000).toISOString(),
  });
  await scheduleTopicRuns(infra, 'area-low-speed-notice');
  const run = (await listTopicRuns(infra, topic.id)).find((r) => r.status === 'queued')!;
  const data: TopicDataset = {
    from: run.from,
    to: run.to,
    queriedAt: new Date().toISOString(),
    ais: [45, 90, 104].map((minute) => ({
      recordId: `p-${minute}`,
      mmsi: '413123456',
      occurredAt: new Date(Date.parse(run.from) + minute * 60_000).toISOString(),
      longitude: 121,
      latitude: 22,
      speedOverGround: 2,
      shipType: 70,
      raw: { minute },
    })),
    intelligence: [
      {
        id: 'notice',
        sourceId: 'source',
        externalId: 'split-notice',
        version: 1,
        status: 'active',
        kind: 'notice',
        title: '区域公告',
        effectiveFrom: run.from,
        effectiveTo: null,
        bbox: [120, 20, 123, 24],
        vesselTypes: [],
        mmsis: [],
        paragraphs: [{ id: 'p', text: '观察区域' }],
        raw: {},
      },
    ],
  };
  expect(evaluateTopic(topic, data)).toHaveLength(1);
  await setTopicState(infra, topic.id, false);
});
