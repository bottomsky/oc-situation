import { describe, expect, it } from 'vitest';
import { recoverDemoCollection, waitForDemoBus } from './demo-readiness';

describe('demo startup recovery', () => {
  it('starts collectors only after RAW drains and returns only after COMMANDS drains', async () => {
    const order: string[] = [];
    const states = [
      {
        status: 'paused' as const,
        ready: false,
        reasons: ['pressure:AIS_RAW', 'pressure:AIS_COMMANDS'],
        streams: [],
      },
      { status: 'paused' as const, ready: false, reasons: ['pressure:AIS_COMMANDS'], streams: [] },
      { status: 'paused' as const, ready: false, reasons: ['pressure:AIS_COMMANDS'], streams: [] },
      { status: 'ready' as const, ready: true, reasons: [], streams: [] },
    ];
    let attempt = 0;
    await recoverDemoCollection(
      async () => {
        order.push(`health:${attempt}`);
        return states[attempt++]!;
      },
      () => order.push('start-collectors'),
      { pollIntervalMs: 1, timeoutMs: 1000 },
    );
    order.push('publish-new-demo');
    expect(order).toEqual([
      'health:0',
      'health:1',
      'start-collectors',
      'health:2',
      'health:3',
      'publish-new-demo',
    ]);
  });

  it('keeps collectors stopped when RAW recovery times out', async () => {
    let started = false;
    await expect(
      recoverDemoCollection(
        async () => ({
          status: 'paused',
          ready: false,
          reasons: ['pressure:AIS_RAW'],
          streams: [],
        }),
        () => {
          started = true;
        },
        { pollIntervalMs: 1, timeoutMs: 5 },
      ),
    ).rejects.toThrow(/恢复等待超时.*pressure:AIS_RAW/);
    expect(started).toBe(false);
  });

  it('waits for consumers to drain historical pressure before allowing collection', async () => {
    let attempts = 0;
    const progress: string[] = [];
    await waitForDemoBus(
      async () => {
        attempts++;
        return attempts < 3
          ? { ready: false, reasons: ['pressure:AIS_RAW', 'pressure:AIS_COMMANDS'] }
          : { ready: true, reasons: [] };
      },
      { pollIntervalMs: 1, timeoutMs: 1000, onProgress: (message) => progress.push(message) },
    );
    expect(attempts).toBe(3);
    expect(progress).toHaveLength(1);
    expect(progress[0]).toContain('pressure:AIS_RAW');
  });

  it('fails with remaining pressure after a bounded recovery window', async () => {
    await expect(
      waitForDemoBus(async () => ({ ready: false, reasons: ['pressure:AIS_COMMANDS'] }), {
        pollIntervalMs: 1,
        timeoutMs: 5,
      }),
    ).rejects.toThrow(/恢复等待超时.*pressure:AIS_COMMANDS/);
  });

  it('rejects topology drift immediately instead of waiting for consumers', async () => {
    let attempts = 0;
    await expect(
      waitForDemoBus(async () => {
        attempts++;
        return { ready: false, reasons: ['drift:consumer:archiver', 'pressure:AIS_RAW'] };
      }),
    ).rejects.toThrow(/拓扑异常.*drift:consumer:archiver/);
    expect(attempts).toBe(1);
  });

  it('interrupts recovery when shutdown or a child exit aborts the shared signal', async () => {
    const shutdown = new AbortController();
    const waiting = waitForDemoBus(
      async () => {
        shutdown.abort();
        return { ready: false, reasons: ['pressure:AIS_RAW'] };
      },
      { signal: shutdown.signal, pollIntervalMs: 60_000 },
    );
    await expect(waiting).rejects.toThrow(/演示启动已中止/);
  });

  it('accepts warning health without clearing data or disabling pressure protection', async () => {
    await expect(
      waitForDemoBus(async () => ({ ready: true, reasons: [] })),
    ).resolves.toBeUndefined();
  });

  it('bounds the entire recovery window even when a health query never completes', async () => {
    await expect(waitForDemoBus(() => new Promise(() => {}), { timeoutMs: 5 })).rejects.toThrow(
      /恢复等待超时.*尚未取得总线状态/,
    );
  });

  it('interrupts an in-flight polling delay on a later child exit', async () => {
    const shutdown = new AbortController();
    const waiting = waitForDemoBus(async () => ({ ready: false, reasons: ['pressure:AIS_RAW'] }), {
      signal: shutdown.signal,
      pollIntervalMs: 60_000,
    });
    const timer = setTimeout(() => shutdown.abort(), 5);
    try {
      await expect(waiting).rejects.toThrow(/演示启动已中止/);
    } finally {
      clearTimeout(timer);
    }
  });
});
