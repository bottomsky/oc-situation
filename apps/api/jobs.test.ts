import { expect, it } from 'vitest';
import { JobsService } from './src/jobs/service';
import type { Infrastructure } from '@ais/infrastructure';
import { ServiceUnavailableException } from '@nestjs/common';
import { testBusHealth } from '../../tests/helpers/bus-health';
it('queues durable run and outbox atomically; transport publication is deferred', async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM jobs'))
        return {
          rows: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              source_id: 'test',
              mode: 'collect',
              enabled: true,
              status: 'enabled',
              source_enabled: true,
            },
          ],
        };
      if (sql.includes('FROM runs')) return { rows: [] };
      if (sql.includes('INSERT INTO runs'))
        return {
          rows: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              job_id: '11111111-1111-4111-8111-111111111111',
              source_id: 'test',
              status: 'queued',
              mode: 'collect',
              requested_at: new Date(),
              counters: {},
            },
          ],
        };
      return { rows: [] };
    },
    release: () => {},
  };
  const infra = {
    pool: { connect: async () => client },
    jsm: testBusHealth(),
  } as unknown as Infrastructure;
  const result = await new JobsService(infra).dispatch(
    '11111111-1111-4111-8111-111111111111',
    '33333333-3333-4333-8333-333333333333',
  );
  expect(result).toBeDefined();
  expect(statements[0]).toBe('BEGIN');
  expect(statements.some((s) => s.includes('INSERT INTO outbox'))).toBe(true);
  expect(statements.at(-1)).toBe('COMMIT');
});

function dispatchFixture(options: { pressure?: string; existing?: boolean; active?: boolean }) {
  const statements: string[] = [];
  let released = false;
  const run = {
    id: '22222222-2222-4222-8222-222222222222',
    job_id: '11111111-1111-4111-8111-111111111111',
    source_id: 'test',
    status: 'queued',
    mode: 'collect',
    requested_at: new Date(),
  };
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes('FROM jobs'))
        return {
          rows: [{ id: run.job_id, source_id: 'test', mode: 'collect', source_enabled: true }],
        };
      if (sql.startsWith('SELECT') && sql.includes('idempotency_key'))
        return { rows: options.existing ? [run] : [] };
      if (sql.includes('FROM runs')) return { rows: options.active ? [{ id: run.id }] : [] };
      if (sql.includes('INSERT INTO runs')) return { rows: [run] };
      return { rows: [] };
    },
    release: () => {
      released = true;
    },
  };
  const infra = {
    pool: { connect: async () => client },
    jsm: testBusHealth(options.pressure),
  } as unknown as Infrastructure;
  return { service: new JobsService(infra), statements, run, released: () => released };
}

it.each(['AIS_RAW', 'AIS_NORMALIZED', 'AIS_COMMANDS'])(
  'rejects new dispatch with 503 and rolls back before persisting work when %s is pressured',
  async (pressure) => {
    const fixture = dispatchFixture({ pressure });
    let error: unknown;
    try {
      await fixture.service.dispatch(fixture.run.job_id, '33333333-3333-4333-8333-333333333333');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect(String(error)).toContain(`pressure:${pressure}`);
    expect(fixture.statements.some((sql) => sql.startsWith('INSERT'))).toBe(false);
    expect(fixture.statements.at(-1)).toBe('ROLLBACK');
    expect(fixture.released()).toBe(true);
  },
);

it('returns an existing idempotent run even when collection is paused', async () => {
  const fixture = dispatchFixture({ pressure: 'AIS_COMMANDS', existing: true });
  const result = await fixture.service.dispatch(
    fixture.run.job_id,
    '33333333-3333-4333-8333-333333333333',
  );
  expect(result.runId).toBe(fixture.run.id);
  expect(fixture.statements.some((sql) => sql.startsWith('INSERT'))).toBe(false);
  expect(fixture.statements.at(-1)).toBe('COMMIT');
});

it('retains the active-run conflict before checking collection pressure', async () => {
  const fixture = dispatchFixture({ pressure: 'AIS_RAW', active: true });
  await expect(
    fixture.service.dispatch(fixture.run.job_id, '33333333-3333-4333-8333-333333333333'),
  ).rejects.toThrow('active run');
  expect(fixture.statements.at(-1)).toBe('ROLLBACK');
});
