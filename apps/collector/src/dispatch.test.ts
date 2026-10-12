import { expect, it } from 'vitest';
import { dispatchBounded } from './dispatch';

it('processes a short source while a continuous source is active and drains both', async () => {
  let finish!: () => void;
  const continuous = new Promise<void>((resolve) => { finish = resolve; });
  const seen: number[] = [];
  const input = (async function* () { yield 1; yield 2; })();
  const done = dispatchBounded(input, 8, async (item) => {
    seen.push(item);
    if (item === 1) await continuous;
    else finish();
  });
  await done;
  expect(seen).toEqual([1, 2]);
});

it('never exceeds its bounded actor count', async () => {
  let active = 0;
  let peak = 0;
  await dispatchBounded((async function* () { for (let i=0;i<25;i++) yield i; })(), 3, async () => {
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  });
  expect(peak).toBe(3);
});
