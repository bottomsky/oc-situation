export class DurableBatch<T> {
  private items: T[] = [];
  private pending: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private maxSize: number,
    intervalMs: number,
    private write: (items: readonly T[]) => Promise<void>,
    private ack: (item: T) => void,
    private failed: (items: readonly T[], error: unknown) => void,
  ) {
    this.timer = setInterval(() => {
      void this.flush();
    }, intervalMs);
    this.timer.unref();
  }
  async add(item: T): Promise<void> {
    if (this.closed) throw new Error('Batch already closed');
    this.items.push(item);
    if (this.items.length >= this.maxSize) await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.items.length) {
      await this.pending;
      return;
    }
    const batch = this.items.splice(0);
    this.pending = this.pending.then(async () => {
      try {
        await this.write(batch);
        for (const item of batch) this.ack(item);
      } catch (error) {
        this.failed(batch, error);
      }
    });
    await this.pending;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.flush();
  }
}
