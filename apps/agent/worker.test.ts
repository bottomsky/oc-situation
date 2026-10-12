import { describe, expect, it } from 'vitest';
import * as worker from './index';

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
