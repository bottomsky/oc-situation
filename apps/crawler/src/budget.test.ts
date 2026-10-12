import { expect, it } from 'vitest';
import { RequestBudget } from './budget';

it('counts every outgoing hop and resource under one per-minute budget', async () => {
  let now = 0;
  const waits: number[] = [];
  const budget = new RequestBudget(30, 2, () => now, async (ms) => { waits.push(ms); now += ms; });
  for (let i = 0; i < 4; i++) await budget.run(async () => undefined);
  expect(now).toBe(6000);
  expect(waits).toEqual([2000, 2000, 2000]);
});

it('shares concurrency and rejects an aborted waiter', async () => {
  const budget = new RequestBudget(60000, 1);
  let release!: () => void;
  const first = budget.run(() => new Promise<void>((resolve) => { release = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stop = new AbortController();
  const second = budget.run(async () => undefined, stop.signal);
  stop.abort();
  release();
  await first;
  await expect(second).rejects.toThrow();
});
