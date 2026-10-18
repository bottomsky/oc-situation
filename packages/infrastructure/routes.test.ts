import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { createRoutePlan } from './routes';
import type { RouteInfrastructure } from './routes';
it('rejects disabled planning before any database write or connection', async () => {
  vi.stubEnv('ROUTE_PLANNING_ENABLED', 'false');
  const connect = vi.fn(() => {
    throw new Error('database touched');
  });
  try {
    await expect(
      createRoutePlan(
        { pool: { connect } } as unknown as RouteInfrastructure,
        { id: randomUUID(), role: 'operator' },
        {
          operationId: randomUUID(),
          waypoints: [
            [0, 0],
            [1, 0],
          ],
        },
      ),
    ).rejects.toMatchObject({ code: 'planning_disabled', status: 503 });
    expect(connect).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});
it('includes connection acquisition in the deadline and releases a late connection without claiming', async () => {
  const { executeRoutePlan } = await import('./route-planning');
  let resolveConnection: (value: unknown) => void = () => {};
  const query = vi.fn();
  const release = vi.fn();
  const pool = {
    query,
    connect: () =>
      new Promise((resolve) => {
        resolveConnection = resolve;
      }),
  };
  const started = Date.now();
  await executeRoutePlan({ pool } as unknown as RouteInfrastructure, randomUUID(), {
    timeoutMs: 10,
  });
  expect(Date.now() - started).toBeLessThan(500);
  resolveConnection({ query, release });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(query).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
}, 1000);

it('caps scheduler work at two and waits for in-flight work during stop', async () => {
  const { RoutePlanningScheduler } = await import('./route-planning');
  let started = 0,
    finished = 0;
  let unblock: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const pool = {
    query: async (sql: string, values?: unknown[]) => ({
      rows: sql.startsWith('SELECT id')
        ? Array.from({ length: Number(values?.[0]) }, (_, i) => ({ id: String(i) }))
        : [],
    }),
    connect: async () => ({
      release: () => {
        finished++;
      },
      query: async (sql: string) => {
        if (sql.startsWith("UPDATE route_plans SET status='running'")) {
          started++;
          return { rows: [{ id: String(started), dataset_version: 'qa' }] };
        }
        if (sql === 'SELECT status FROM route_plans WHERE id=$1')
          return { rows: [{ status: 'running' }] };
        if (sql.startsWith('SELECT navigation_status'))
          return { rows: [{ navigation_status: 'ready' }] };
        if (sql.includes('AS valid')) {
          await gate;
          return { rows: [{ valid: false }] };
        }
        return { rows: [] };
      },
    }),
  };
  const scheduler = new RoutePlanningScheduler({ pool } as unknown as RouteInfrastructure);
  await scheduler.tick();
  for (let i = 0; i < 20 && started < 2; i++)
    await new Promise((resolve) => setTimeout(resolve, 1));
  await scheduler.tick();
  expect(started).toBe(2);
  let stopped = false;
  const stopping = scheduler.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(stopped).toBe(false);
  expect(finished).toBe(0);
  unblock();
  await stopping;
  expect(finished).toBe(2);
  await scheduler.tick();
  expect(started).toBe(2);
});
