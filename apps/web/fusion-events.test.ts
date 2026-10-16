import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref, watch } from 'vue';
import { startFusionEvents, useFusionEvents } from './app/composables/useFusionEvents';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function harness() {
  vi.useFakeTimers();
  const states = new Map<string, ReturnType<typeof ref>>();
  const mounted: (() => void)[] = [];
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 0;
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose: (() => void) | null = null;
    onerror?: () => void;
    send = vi.fn();
    constructor() {
      Socket.instances.push(this);
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(message: unknown) {
      this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  const api = vi.fn().mockResolvedValue({ items: [], nextCursor: '0' });
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost' });
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(initial()));
    return states.get(key);
  });
  vi.stubGlobal('usePlatform', () => ({ api, session: ref({ user: { id: 'operator' } }) }));
  vi.stubGlobal('onMounted', (callback: () => void) => mounted.push(callback));
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => cleanup.push(callback));
  const scope = effectScope();
  cleanup.push(() => scope.stop());
  scope.run(startFusionEvents);
  const state = useFusionEvents();
  for (const callback of mounted) callback();
  return { state, api, socket: Socket.instances[0]! };
}

describe('实时连接与事件补取的错误归属', () => {
  it('地图订阅拒绝不会被标为事件补取失败，成功补取也不会掩盖实时连接故障', async () => {
    const { state, api, socket } = harness();
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.message({ type: 'error', code: 'INVALID_SUBSCRIPTION' });
    expect(state.status.value).toBe('offline');
    expect(state.error.value).toContain('地图实时订阅参数无效');
    expect(state.feedError.value).toBe('');
    await vi.advanceTimersByTimeAsync(15000);
    expect(api).toHaveBeenCalledWith('/analysis/feed?cursor=0');
    expect(state.feedError.value).toBe('');
    expect(state.error.value).toContain('地图实时订阅参数无效');
  });

  it('事件补取失败独立显示，离线期间成功重试即可清除补取错误', async () => {
    const { state, api, socket } = harness();
    await vi.advanceTimersByTimeAsync(0);
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.close();
    api.mockRejectedValueOnce(new Error('事件查询超时'));
    await vi.advanceTimersByTimeAsync(15000);
    expect(state.feedError.value).toBe('事件查询超时');
    expect(state.error.value).toContain('实时连接已断开');
    await vi.advanceTimersByTimeAsync(15000);
    expect(state.feedError.value).toBe('');
    expect(state.error.value).toContain('实时连接已断开');
  });
});
