import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getBusinessSkillCatalog } from './business-capabilities';
import { AckPolicy, RetentionPolicy, StorageType } from '@nats-io/jetstream';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import * as worker from './index';

// Node's promise timers bypass Vitest's clock. Keep cancellation semantics while
// routing this unit test's delays through the fakeable global timer functions.
vi.mock('node:timers/promises', () => ({
  setTimeout: (ms: number, value: unknown, options?: { signal?: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const signal = options?.signal;
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(new Error('aborted'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve(value);
      }, ms);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    }),
}));

describe('worker 安全故障分类', () => {
  it('心跳漏报保留阶段与类别，日志不包含原错误字段', () => {
    const error = Object.assign(new Error('heartbeats missed'), {
      name: 'JetStreamError',
      apiKey: 'secret-key',
      authorization: 'private-token',
    });
    const details = worker.agentWorkerFailure?.(error, 'fetch') ?? {};
    expect(details).toEqual({ stage: 'fetch', kind: 'nats_heartbeat' });
    expect(JSON.stringify(details)).not.toContain('secret-key');
    expect(JSON.stringify(details)).not.toContain('private-token');
    expect(JSON.stringify(details)).not.toContain('heartbeats missed');
  });
  it.each([
    [{ code: '57014', message: 'sensitive sql and password' }, 'database_timeout'],
    [{ code: '55P03', message: 'sensitive sql and password' }, 'database_lock_timeout'],
    [{ code: 'ECONNREFUSED', message: 'sensitive connection URL' }, 'connection_refused'],
    [{ code: '__proto__', message: 'private arbitrary code' }, 'unexpected'],
    [{ name: 'JetStreamApiError', message: 'private API text' }, 'nats_api'],
    [new Error('unknown private failure'), 'unexpected'],
  ])('仅返回白名单类别：%s', (error, kind) => {
    expect(worker.agentWorkerFailure?.(error, 'publish') ?? {}).toEqual({ stage: 'publish', kind });
  });
});

describe('worker pull heartbeat recovery', () => {
  beforeAll(async () => {
    await getBusinessSkillCatalog();
  });
  afterEach(() => vi.useRealTimers());
  const heartbeat = () => Object.assign(new Error('heartbeats missed'), { name: 'JetStreamError' });
  function infrastructure(fetch: ReturnType<typeof vi.fn>) {
    const get = vi.fn(async () => ({ fetch }));
    const infra = {
      jsm: {
        streams: {
          info: vi.fn(async () => ({
            config: {
              storage: StorageType.File,
              retention: RetentionPolicy.Workqueue,
              subjects: [worker.AGENT_SUBJECT],
            },
          })),
        },
        consumers: {
          info: vi.fn(async () => ({
            config: { ack_policy: AckPolicy.Explicit, filter_subject: worker.AGENT_SUBJECT },
          })),
        },
      },
      js: { consumers: { get }, publish: vi.fn() },
      pool: { query: vi.fn(async () => ({ rows: [] })) },
    } as unknown as Infrastructure;
    return { infra, get };
  }
  const options = {
    enabled: true,
    apiKey: 'fixture',
    maxModelCalls: 1,
    maxToolCalls: 1,
    maxRecords: 10,
  };
  it('reacquires the consumer after iterator heartbeat loss and releases an already received job', async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const message = { nak: vi.fn() };
    const close = vi.fn(async () => {});
    const fetch = vi
      .fn()
      .mockResolvedValueOnce({
        close,
        async *[Symbol.asyncIterator]() {
          yield message;
          throw heartbeat();
        },
      })
      .mockImplementationOnce(async () => ({
        close: vi.fn(async () => {}),
        async *[Symbol.asyncIterator]() {
          signal.abort();
          yield* [];
        },
      }));
    const { infra, get } = infrastructure(fetch);
    const running = worker.runAgentWorker(infra, signal.signal, options);
    await vi.advanceTimersByTimeAsync(249);
    expect(get).toHaveBeenCalledTimes(1);
    expect(message.nak).toHaveBeenCalledWith(5000);
    expect(close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await running;
    expect(get).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('caps repeated heartbeat backoff at five seconds and aborts during backoff immediately', async () => {
    vi.useFakeTimers();
    const signal = new AbortController();
    const times: number[] = [];
    const fetch = vi.fn(async () => {
      times.push(Date.now());
      throw heartbeat();
    });
    const { infra, get } = infrastructure(fetch);
    const running = worker.runAgentWorker(infra, signal.signal, options);
    await vi.advanceTimersByTimeAsync(0);
    for (const ms of [250, 500, 1000, 2000, 4000, 5000, 5000])
      await vi.advanceTimersByTimeAsync(ms);
    expect(times.slice(1).map((t, i) => t - times[i]!)).toEqual([
      250, 500, 1000, 2000, 4000, 5000, 5000,
    ]);
    signal.abort();
    await running;
    expect(get).toHaveBeenCalledTimes(8);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not suppress configuration or protocol failures as transient heartbeat errors', async () => {
    const signal = new AbortController();
    const fetch = vi.fn(async () => {
      throw Object.assign(new Error('consumer configuration drift'), { name: 'JetStreamApiError' });
    });
    const { infra, get } = infrastructure(fetch);
    await expect(worker.runAgentWorker(infra, signal.signal, options)).rejects.toMatchObject({
      details: { stage: 'fetch', kind: 'nats_api' },
    });
    expect(get).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
