import { expect, it } from 'vitest';
import { SystemController } from './controller';
import { startOperationsServer } from './operations';
import type { Infrastructure } from '@ais/infrastructure';
it('scrapes finite business aggregates through the actual metrics HTTP endpoint', async () => {
  const calls: string[] = [];
  const infra = {
    pool: {
      query: async (sql: string) => {
        calls.push(sql);
        return {
          rows: [
            {
              queued: 2,
              running: 1,
              completed: 3,
              failed: 4,
              cancelled: 0,
              duration_seconds: 42,
              pending: 5,
              lag_seconds: 17,
              failures: 6,
              route_receipts: 7,
              event_receipts: 8,
              focus_failures: 9,
            },
          ],
        };
      },
    },
  } as unknown as Infrastructure;
  const system = new SystemController(infra),
    server = await startOperationsServer(system, { port: 0 });
  try {
    const address = server.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('ais_route_plans{status="queued"} 2');
    expect(body).toContain('ais_route_plan_duration_seconds_sum 42');
    expect(body).toContain('ais_event_sync_pending 5');
    expect(body).toContain('ais_event_sync_lag_seconds 17');
    expect(body).toContain('ais_event_sync_failed_attempts 6');
    expect(body).toContain('ais_business_operation_receipts{kind="route"} 7');
    expect(body).toContain('ais_focus_ui_failures 9');
    expect(calls.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/owner=|coordinates=|task_id=/);
  } finally {
    await server.close();
  }
});

it('returns 503 from the scrape endpoint when durable aggregates cannot be read', async () => {
  const system = new SystemController({
    pool: {
      query: async () => {
        throw new Error('database unavailable');
      },
    },
  } as unknown as Infrastructure);
  const server = await startOperationsServer(system, { port: 0 });
  try {
    const address = server.server.address() as { port: number };
    const response = await fetch(`http://127.0.0.1:${address.port}/metrics`);
    expect(response.status).toBe(503);
  } finally {
    await server.close();
  }
});
