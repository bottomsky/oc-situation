import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { IntelligenceSourceSchema } from '../contracts/intelligence';
import {
  registerIntelligenceSources,
  collectIntelligenceSource,
  collectIntelligenceDueSources,
  ingestionBackoffSeconds,
} from './intelligence-ingestion';

describe('independent durable intelligence collection', () => {
  let infra: Infrastructure;
  const ids: string[] = [];
  const make = async (enabled = true) => {
    const id = `collector-${randomUUID()}`;
    ids.push(id);
    const source = IntelligenceSourceSchema.parse({
      sourceId: id,
      name: 'Synthetic collection',
      kind: 'fixture',
      enabled,
      pollSeconds: 10,
    });
    await registerIntelligenceSources(infra, [source]);
    return source;
  };
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
  });
  afterAll(async () => {
    if (!infra) return;
    await infra.pool.query('DELETE FROM intelligence_sources WHERE id=ANY($1::text[])', [ids]);
    await infra.close();
  });
  it('registers idempotently while retaining administrator settings', async () => {
    const source = await make(false);
    await infra.pool.query(
      "UPDATE intelligence_sources SET config=jsonb_set(config,'{pollSeconds}','3600') WHERE id=$1",
      [source.sourceId],
    );
    expect(await registerIntelligenceSources(infra, [{ ...source, enabled: true }])).toBe(0);
    expect(
      (
        await infra.pool.query('SELECT config FROM intelligence_sources WHERE id=$1', [
          source.sourceId,
        ])
      ).rows[0].config,
    ).toMatchObject({ enabled: false, pollSeconds: 3600 });
  });
  it('allows only one collector and rechecks due time after obtaining its lock', async () => {
    const source = await make();
    let calls = 0;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const collect = async () => {
      calls++;
      entered();
      await barrier;
      return { imported: 2, unchanged: 3 };
    };
    const first = collectIntelligenceSource(infra, source.sourceId, collect);
    await started;
    expect(await collectIntelligenceSource(infra, source.sourceId, collect)).toBeNull();
    release();
    expect((await first)?.status).toBe('succeeded');
    expect(await collectIntelligenceSource(infra, source.sourceId, collect)).toBeNull();
    expect(calls).toBe(1);
    const rows = await infra.pool.query(
      'SELECT status,imported,unchanged FROM intelligence_ingestion_runs WHERE source_id=$1',
      [source.sourceId],
    );
    expect(rows.rows).toEqual([{ status: 'succeeded', imported: 2, unchanged: 3 }]);
  });
  it('backs off failed batches and resets their health after recovery', async () => {
    const source = await make();
    const failed = await collectIntelligenceSource(infra, source.sourceId, async () => {
      throw new Error('synthetic outage');
    });
    expect(failed?.status).toBe('failed');
    const before = (
      await infra.pool.query(
        'SELECT consecutive_failures,last_successful_at,next_poll_at>now() AS delayed FROM intelligence_sources WHERE id=$1',
        [source.sourceId],
      )
    ).rows[0];
    expect(before).toMatchObject({
      consecutive_failures: 1,
      last_successful_at: null,
      delayed: true,
    });
    expect(ingestionBackoffSeconds(60, 3)).toBe(240);
    await infra.pool.query('UPDATE intelligence_sources SET next_poll_at=now() WHERE id=$1', [
      source.sourceId,
    ]);
    await collectIntelligenceSource(infra, source.sourceId, async () => ({ imported: 0 }));
    expect(
      (
        await infra.pool.query(
          'SELECT consecutive_failures,last_successful_at IS NOT NULL AS recovered,last_error FROM intelligence_sources WHERE id=$1',
          [source.sourceId],
        )
      ).rows[0],
    ).toEqual({ consecutive_failures: 0, recovered: true, last_error: null });
  });
  it('lets a healthy source finish while another source waits for its timeout', async () => {
    const slow = await make(),
      fast = await make();
    await collectIntelligenceDueSources(
      infra,
      async (source, signal) => {
        if (source.sourceId === slow.sourceId)
          await new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }),
          );
        return { imported: 1 };
      },
      { concurrency: 2, timeoutMs: 100, sourceIds: [slow.sourceId, fast.sourceId] },
    );
    const rows = (
      await infra.pool.query(
        'SELECT source_id,status,finished_at FROM intelligence_ingestion_runs WHERE source_id=ANY($1::text[])',
        [[slow.sourceId, fast.sourceId]],
      )
    ).rows;
    expect(rows.find((r) => r.source_id === fast.sourceId)?.status).toBe('succeeded');
    expect(rows.find((r) => r.source_id === slow.sourceId)?.status).toBe('failed');
    expect(
      new Date(rows.find((r) => r.source_id === fast.sourceId)!.finished_at).getTime(),
    ).toBeLessThan(
      new Date(rows.find((r) => r.source_id === slow.sourceId)!.finished_at).getTime(),
    );
  });
});
