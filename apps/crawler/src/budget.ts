import { setTimeout as delay } from 'node:timers/promises';

/** A single run shares this budget across robots, redirects, retries and browser resources. */
export class RequestBudget {
  private active = 0;
  private nextAt = 0;
  private waiters: Array<() => void> = [];
  private reservation = Promise.resolve();
  constructor(
    private readonly perMinute: number,
    private readonly concurrency: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = (ms, signal) => delay(ms, undefined, { signal }),
  ) {}
  async run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.active >= this.concurrency) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => { signal?.removeEventListener('abort', wake); this.waiters = this.waiters.filter((item) => item !== wake); resolve(); };
        this.waiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    signal?.throwIfAborted();
    this.active++;
    try {
      const reserve = this.reservation.then(async () => {
        const wait = this.nextAt - this.now();
        if (wait > 0) await this.sleep(wait, signal);
        signal?.throwIfAborted();
        this.nextAt = this.now() + 60000 / this.perMinute;
      });
      this.reservation = reserve.catch(() => undefined);
      await reserve;
      return await request();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
