import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createInfrastructure,
  runMigrations,
  seedDemo,
  type Infrastructure,
} from '@ais/infrastructure';
import { runReplay } from './replay';
import type { TaskCommand } from '@ais/contracts';
const test = process.env.AIS_TEST_SCOPE === 'integration' ? it : it.skip;
let infra: Infrastructure;
beforeAll(async () => {
  if (process.env.AIS_TEST_SCOPE !== 'integration') return;
  infra = await createInfrastructure();
  await runMigrations(infra);
  await seedDemo(infra);
});
afterAll(async () => {
  if (infra) await infra.close();
});
async function replayFixture(checkpoint: unknown, runStatus = 'queued') {
  const runId = randomUUID();
  const sourceId = 'fixture-http';
  const jobId = '00000000-0000-4000-8000-000000000001';
  await infra.pool.query(
    'INSERT INTO runs(id,source_id,job_id,status,mode) VALUES($1,$2,$3,$4,$5)',
    [runId, sourceId, jobId, runStatus, 'replay'],
  );
  await infra.pool.query(
    'INSERT INTO replays(id,source_id,from_time,to_time,cleaning_version,status,checkpoint) VALUES($1,$2,$3,$4,1,$5,$6::jsonb)',
    [
      runId,
      sourceId,
      new Date(Date.now() - 60_000).toISOString(),
      new Date(Date.now() + 60_000).toISOString(),
      'queued',
      JSON.stringify(checkpoint),
    ],
  );
  const command: TaskCommand = {
    schemaVersion: 1,
    runId,
    sourceId,
    jobId,
    idempotencyKey: randomUUID(),
    mode: 'replay',
    requestedAt: new Date().toISOString(),
  };
  return command;
}
test('reports a missing persisted replay checkpoint as a visible failure instead of silently succeeding', async () => {
  const command = await replayFixture({ manifestId: 'deleted-checkpoint' });
  await expect(runReplay(infra, command)).rejects.toThrow('checkpoint');
  const result = await infra.pool.query('SELECT status,last_error FROM replays WHERE id=$1', [
    command.runId,
  ]);
  expect(result.rows[0]?.status).toBe('failed');
  expect(result.rows[0]?.last_error).toContain('checkpoint');
});
test('honors a cancelled replay run before reading archive objects', async () => {
  const command = await replayFixture({}, 'cancelled');
  await runReplay(infra, command);
  const result = await infra.pool.query('SELECT status FROM replays WHERE id=$1', [command.runId]);
  expect(result.rows[0]?.status).toBe('cancelled');
});
