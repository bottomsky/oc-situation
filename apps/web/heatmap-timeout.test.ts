import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { usePlatform } from './app/composables/usePlatform';
import { useAisHeatmap } from './app/composables/useAisHeatmap';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-15T00:00:00Z'));
  // Node's native AbortSignal.timeout uses internal timers; route them through the fake clock.
  vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), milliseconds);
    return controller.signal;
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function harness() {
  const identity = ref({ user: { id: 'operator', role: 'operator' } });
  vi.stubGlobal('useState', (key: string) => (key === 'session' ? identity : ref('')));
  const platform = usePlatform();
  vi.stubGlobal('usePlatform', () => platform);
  let signal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      signal = options.signal as AbortSignal;
      return new Promise<Response>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
      });
    }),
  );
  const scope = effectScope();
  const state = scope.run(() => useAisHeatmap())!;
  return { state, platform, signal: () => signal!, stop: () => scope.stop() };
}
const query = {
  bbox: [110, 10, 130, 30] as [number, number, number, number],
  from: '2026-10-14T00:00:00Z',
  to: '2026-10-15T00:00:00Z',
};
it('热图超过15秒保持活跃，30秒时超时', async () => {
  const h = harness();
  const request = h.state.generate(query);
  await vi.advanceTimersByTimeAsync(16000);
  expect(h.signal().aborted).toBe(false);
  expect(h.state.loading.value).toBe(true);
  await vi.advanceTimersByTimeAsync(14000);
  await request;
  expect(h.signal().aborted).toBe(true);
  expect(h.state.loading.value).toBe(false);
  expect(h.state.error.value).toContain('请求超时');
  h.stop();
});
it('热图等待超过15秒后关闭仍立即中止，不显示迟到错误', async () => {
  const h = harness();
  const request = h.state.generate(query);
  await vi.advanceTimersByTimeAsync(16000);
  expect(h.signal().aborted).toBe(false);
  h.state.close();
  expect(h.signal().aborted).toBe(true);
  await request;
  expect(h.state.loading.value).toBe(false);
  expect(h.state.error.value).toBe('');
  h.stop();
});
it('普通API仍在15秒超时', async () => {
  const h = harness();
  const request = h.platform.api('/sources').catch((error: Error) => error.message);
  await vi.advanceTimersByTimeAsync(14999);
  expect(h.signal().aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.signal().aborted).toBe(true);
  expect(await request).toContain('请求超时');
  h.stop();
});
