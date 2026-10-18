import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import {
  createOperationalEvent,
  updateOperationalEvent,
  mergeOperationalEvents,
  getOperationalEvent,
  getOperationalEventSources,
  getOperationalEventHistory,
  listOperationalEvents,
} from './operational-event-store';
import {
  enqueueOperationalEventSource,
  processOperationalEventSync,
  enqueueIntelligenceOperationalEvent,
} from './operational-event-sync';
import {
  OperationalEventFieldsSchema,
  CreateOperationalEventSchema,
  UpdateOperationalEventSchema,
  OperationalEventQuerySchema,
  type OperationalEventSourceSnapshot,
} from '../contracts/operational-events';
import { reviewIntelligenceEvent, writeRelation } from './intelligence-store';

describe('durable operational events and independently synchronized evidence', () => {
  let infra: Infrastructure;
  const actor = { id: randomUUID(), role: 'operator' },
    viewer = { id: randomUUID(), role: 'viewer' };
  const prefix = randomUUID();
  const snapshot = (
    key: string,
    title = 'source',
    version = 1,
  ): OperationalEventSourceSnapshot => ({
    key: `${prefix}:${key}`,
    kind: 'analysis',
    sourceId: prefix,
    externalId: key,
    version,
    status: 'active',
    reviewStatus: 'confirmed',
    fields: OperationalEventFieldsSchema.parse({ title }),
  });
  async function enqueue(value: OperationalEventSourceSnapshot) {
    const c = await infra.pool.connect();
    try {
      await c.query('BEGIN');
      await enqueueOperationalEventSource(c, value);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async function eventFor(key: string) {
    return (
      await infra.pool.query('SELECT event_id FROM operational_event_sources WHERE source_key=$1', [
        `${prefix}:${key}`,
      ])
    ).rows[0].event_id as string;
  }
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    await infra.pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,'fixture','operator'),($3,$4,'fixture','viewer')",
      [actor.id, `events-${actor.id}`, viewer.id, `events-${viewer.id}`],
    );
  });
  afterAll(async () => {
    await infra?.close();
  });
  it('applies duplicate and reordered source snapshots once and retains independent lifecycle', async () => {
    const value = snapshot('ordering');
    await enqueue(value);
    await enqueue(value);
    await enqueue({
      ...value,
      version: 2,
      status: 'withdrawn',
      fields: { ...value.fields, title: 'new' },
    });
    await enqueue({ ...value, fields: { ...value.fields, title: 'old' } });
    await Promise.all([processOperationalEventSync(infra), processOperationalEventSync(infra)]);
    const id = await eventFor('ordering');
    expect(await getOperationalEvent(infra, id)).toMatchObject({
      title: 'new',
      status: 'active',
      severity: 'unknown',
      geometry: null,
    });
    expect((await getOperationalEventSources(infra, id))[0]).toMatchObject({
      version: 2,
      status: 'withdrawn',
      revision: 2,
    });
    const history = await getOperationalEventHistory(infra, id);
    expect(history).toHaveLength(2);
  });
  it('preserves overrides, releases fields and routes late updates through merged ids', async () => {
    const leftSource = snapshot('left');
    leftSource.fields.summary = 'summary from primary';
    await enqueue(leftSource);
    await enqueue(snapshot('right'));
    await processOperationalEventSync(infra);
    const left = await eventFor('left'),
      right = await eventFor('right');
    const edited = await updateOperationalEvent(
      infra,
      right,
      UpdateOperationalEventSchema.parse({
        operationId: randomUUID(),
        expectedRevision: 1,
        fields: { title: 'manual' },
      }),
      actor,
    );
    expect(edited.overrides).toEqual({ title: 'manual' });
    const result = await mergeOperationalEvents(
      infra,
      left,
      {
        operationId: randomUUID(),
        targetId: right,
        expectedRevision: 1,
        targetExpectedRevision: edited.revision,
        primarySourceKey: `${prefix}:left`,
      },
      actor,
    );
    expect(result.summary).toBe('summary from primary');
    await enqueue(snapshot('left', 'late', 2));
    await processOperationalEventSync(infra);
    expect(await getOperationalEvent(infra, left)).toMatchObject({
      id: right,
      title: 'manual',
      revision: result.revision + 1,
    });
    const released = await updateOperationalEvent(
      infra,
      right,
      UpdateOperationalEventSchema.parse({
        operationId: randomUUID(),
        expectedRevision: result.revision + 1,
        releaseOverrides: ['title'],
      }),
      actor,
    );
    expect(released.title).toBe('late');
    expect(await getOperationalEventSources(infra, right)).toHaveLength(2);
  });
  it('commits receipt and audit atomically, recovers before canceled fence and rejects conflicting keys', async () => {
    const input = CreateOperationalEventSchema.parse({
      operationId: randomUUID(),
      title: 'idempotent',
    });
    await expect(
      createOperationalEvent(infra, input, actor, {
        beforeWrite: async () => {
          throw new Error('canceled');
        },
      }),
    ).rejects.toThrow('canceled');
    expect(
      (
        await infra.pool.query('SELECT * FROM operational_event_operations WHERE operation_id=$1', [
          input.operationId,
        ])
      ).rowCount,
    ).toBe(0);
    const [a, b] = await Promise.all([
      createOperationalEvent(infra, input, actor),
      createOperationalEvent(infra, input, actor),
    ]);
    expect(a.id).toBe(b.id);
    expect(
      await createOperationalEvent(infra, input, actor, {
        beforeWrite: async () => {
          throw new Error('canceled');
        },
      }),
    ).toEqual(a);
    await expect(
      createOperationalEvent(infra, { ...input, title: 'different' }, actor),
    ).rejects.toThrow('different input');
    expect(
      (
        await infra.pool.query(
          "SELECT * FROM audit WHERE resource_id=$1 AND action='event.create'",
          [a.id],
        )
      ).rowCount,
    ).toBe(1);
    await expect(
      createOperationalEvent(infra, { ...input, operationId: randomUUID() }, viewer),
    ).rejects.toThrow('permission');
    await expect(
      updateOperationalEvent(
        infra,
        a.id,
        UpdateOperationalEventSchema.parse({
          operationId: randomUUID(),
          expectedRevision: 99,
          fields: { title: 'stale' },
        }),
        actor,
      ),
    ).rejects.toThrow('revision');
  });
  it('rechecks a task fence before commit and rolls back event audit and receipt', async () => {
    const input = CreateOperationalEventSchema.parse({
      operationId: randomUUID(),
      title: `late fence ${randomUUID()}`,
    });
    let checks = 0;
    await expect(
      createOperationalEvent(infra, input, actor, {
        beforeWrite: async () => {
          if (++checks === 2) throw new Error('task expired');
        },
      }),
    ).rejects.toThrow('task expired');
    expect(checks).toBe(2);
    expect(
      (
        await infra.pool.query('SELECT 1 FROM operational_event_operations WHERE operation_id=$1', [
          input.operationId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await infra.pool.query("SELECT 1 FROM operational_events WHERE data->>'title'=$1", [
          input.title,
        ])
      ).rowCount,
    ).toBe(0);
  });
  it('filters exact circle before total and pagination and includes intersecting lines', async () => {
    const keyword = `circle-${randomUUID()}`;
    for (const geometry of [
      { type: 'Point', coordinates: [120, 30] },
      { type: 'Point', coordinates: [125, 30] },
      {
        type: 'LineString',
        coordinates: [
          [119, 30],
          [121, 30],
        ],
      },
    ])
      await createOperationalEvent(
        infra,
        CreateOperationalEventSchema.parse({ operationId: randomUUID(), title: keyword, geometry }),
        actor,
      );
    const q = OperationalEventQuerySchema.parse({
      keyword,
      circle: { kind: 'circle', center: [120, 30], radiusMeters: 1000 },
      limit: 1,
    });
    const page = await listOperationalEvents(infra, q);
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
  });
  it('propagates same-version review and relation revisions without changing immutable original', async () => {
    const sourceId = `events-source-${prefix}`,
      id = `evidence-${prefix}`;
    const event = {
      id,
      sourceId,
      externalId: 'a',
      version: 1,
      status: 'active',
      category: 'notice',
      reviewStatus: 'candidate',
      title: 'Evidence',
      summary: 'source',
      effectiveFrom: new Date().toISOString(),
      mmsis: [],
      paragraphs: [{ id: 'p', text: 'immutable' }],
      raw: {},
    };
    await infra.pool.query('INSERT INTO intelligence_sources(id,config) VALUES($1,$2)', [
      sourceId,
      JSON.stringify({ sourceId }),
    ]);
    await infra.pool.query(
      'INSERT INTO intelligence_events(id,source_id,external_id,version,published_at,effective_from,event) VALUES($1,$2,$3,1,now(),now(),$4)',
      [id, sourceId, 'a', event],
    );
    const c = await infra.pool.connect();
    try {
      await c.query('BEGIN');
      await enqueueIntelligenceOperationalEvent(c, id);
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await processOperationalEventSync(infra);
    await reviewIntelligenceEvent(infra, id, 'confirmed', actor.id);
    await writeRelation(
      infra,
      id,
      {
        kind: 'occurs-at',
        geometry: { type: 'Point', coordinates: [120, 30] },
        basis: 'confirmed location',
        paragraphIds: ['p'],
        reviewStatus: 'confirmed',
        origin: 'manual',
      },
      actor.id,
    );
    await processOperationalEventSync(infra);
    const source = (
      await infra.pool.query('SELECT data FROM operational_event_sources WHERE source_key=$1', [
        JSON.stringify(['intelligence', sourceId, 'a']),
      ])
    ).rows[0].data;
    expect(source).toMatchObject({ reviewStatus: 'confirmed', version: 1 });
    expect(source.fields.geometry).not.toBeNull();
    expect(
      (await infra.pool.query('SELECT event FROM intelligence_events WHERE id=$1', [id])).rows[0]
        .event,
    ).toEqual(event);
  });
});
