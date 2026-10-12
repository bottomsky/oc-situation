import { expect, it } from 'vitest';
import { DurableBatch } from './batch';
it('acknowledges a complete persisted batch and flushes pending data on close', async () => {
  const events: string[] = [];
  const batch = new DurableBatch<number>(
    2,
    10_000,
    async (items) => {
      events.push(`write:${items.join(',')}`);
    },
    (item) => events.push(`ack:${item}`),
    () => events.push('failed'),
  );
  await batch.add(1);
  expect(events).toEqual([]);
  await batch.add(2);
  expect(events).toEqual(['write:1,2', 'ack:1', 'ack:2']);
  await batch.add(3);
  await batch.close();
  expect(events.at(-1)).toBe('ack:3');
});
it('preserves failed batch messages for broker retry and never acknowledges partial writes', async () => {
  const acked: number[] = [];
  const failed: number[] = [];
  const batch = new DurableBatch<number>(
    2,
    10_000,
    async () => {
      throw new Error('connection lost');
    },
    (item) => acked.push(item),
    (items) => failed.push(...items),
  );
  await batch.add(1);
  await batch.add(2);
  await batch.close();
  expect(acked).toEqual([]);
  expect(failed).toEqual([1, 2]);
});
it('flushes by a timer while serializing overlapping writes', async () => {
  const persisted: number[] = [];
  const batch = new DurableBatch<number>(
    1000,
    10,
    async (items) => {
      persisted.push(...items);
    },
    () => {},
    () => {},
  );
  await batch.add(1);
  await new Promise((resolve) => setTimeout(resolve, 35));
  await batch.close();
  expect(persisted).toEqual([1]);
});
