/** Each message owns its ACK heartbeat until its source operation finishes. */
export async function dispatchBounded<T>(
  input: AsyncIterable<T>,
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const active = new Set<Promise<void>>();
  try {
    for await (const item of input) {
      while (active.size >= concurrency) await Promise.race(active);
      const task = handler(item).finally(() => active.delete(task));
      active.add(task);
    }
  } finally {
    await Promise.allSettled(active);
  }
}
