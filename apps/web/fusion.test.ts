import { describe, expect, it, vi } from 'vitest';
import { createFeedSync, parseBbox } from './app/utils/fusion';
import { effectScope, nextTick, ref, watch } from 'vue';
import { startFusionEvents, useFusionEvents } from './app/composables/useFusionEvents';

it('切换账号先清旧实时会话，再恢复同小时窗口，新连接仍取得订阅且旧帧失效', async () => {
  vi.useFakeTimers();
  const sessions = ref({ user: { id: 'owner-a' } });
  const states = new Map<string, ReturnType<typeof ref>>();
  const mounted: (() => void)[] = [],
    unmounted: (() => void)[] = [];
  const connections: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    messages: unknown[] = [];
    constructor() {
      connections.push(this);
    }
    send(message: string) {
      this.messages.push(JSON.parse(message));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('location', { protocol: 'http:', host: 'fixture' });
  vi.stubGlobal('watch', watch);
  vi.stubGlobal('onMounted', (callback: () => void) => mounted.push(callback));
  vi.stubGlobal('onBeforeUnmount', (callback: () => void) => unmounted.push(callback));
  vi.stubGlobal('useState', (key: string, initial: () => unknown) => {
    if (!states.has(key)) states.set(key, ref(initial()));
    return states.get(key);
  });
  vi.stubGlobal('usePlatform', () => ({
    session: sessions,
    api: async () => ({ items: [], nextCursor: '0' }),
  }));
  const scope = effectScope();
  try {
    scope.run(() => {
      startFusionEvents();
      watch(
        () => sessions.value.user.id,
        () => {
          useFusionEvents().subscribeViewport({ bbox: '120,30,124,34', zoom: 6, hours: 0.25 });
        },
        { flush: 'sync' },
      );
    });
    mounted.forEach((callback) => callback());
    useFusionEvents().subscribeViewport({ bbox: '120,30,124,34', zoom: 6, hours: 0.25 });
    connections[0]!.open();
    sessions.value = { user: { id: 'owner-b' } };
    await nextTick();
    expect(connections).toHaveLength(2);
    connections[1]!.open();
    expect(connections[1]!.messages).toContainEqual(
      expect.objectContaining({
        type: 'viewport',
        query: expect.objectContaining({ hours: 0.25, mode: 'points' }),
      }),
    );
    connections[0]!.onmessage?.({
      data: JSON.stringify({
        type: 'ais.snapshot',
        version: 0,
        data: { items: [{ mmsi: 'old' }] },
      }),
    });
    expect(states.get('fusion-map-data')!.value).toBeNull();
  } finally {
    unmounted.forEach((callback) => callback());
    scope.stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

describe('融合事件可靠补取', () => {
  it('切换会话重置游标，旧请求返回时不能覆盖新会话进度', async () => {
    let resolveOld!: (value: { items: { id: string }[]; nextCursor: string }) => void;
    const old = new Promise<{ items: { id: string }[]; nextCursor: string }>((resolve) => {
      resolveOld = resolve;
    });
    const fetchPage = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValueOnce({ items: [{ id: 'new' }], nextCursor: '9' })
      .mockResolvedValueOnce({ items: [], nextCursor: '9' });
    const delivered = vi.fn();
    const sync = createFeedSync(fetchPage, delivered);
    const first = sync.refresh();
    sync.reset();
    await sync.refresh();
    resolveOld({ items: [{ id: 'old' }], nextCursor: '100' });
    await first;
    expect(sync.getCursor()).toBe('9');
    expect(delivered).toHaveBeenCalledTimes(1);
    expect(delivered).toHaveBeenCalledWith([{ id: 'new' }]);
  });
  it('逐页读取游标，重连从已交付位置继续，重复通知不会丢失下一页', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [{ id: 'a' }], nextCursor: '1' })
      .mockResolvedValueOnce({ items: [{ id: 'b' }], nextCursor: '2' })
      .mockResolvedValueOnce({ items: [], nextCursor: '2' })
      .mockResolvedValueOnce({ items: [{ id: 'c' }], nextCursor: '3' })
      .mockResolvedValueOnce({ items: [], nextCursor: '3' });
    const delivered: string[] = [];
    const sync = createFeedSync(fetchPage, (items: { id: string }[]) => {
      delivered.push(...items.map((x) => x.id));
    });
    await sync.refresh();
    await sync.refresh();
    expect(delivered).toEqual(['a', 'b', 'c']);
    expect(fetchPage.mock.calls.map((call) => call[0])).toEqual(['0', '1', '2', '2', '3']);
  });

  it('请求失败保留游标并可重试，不将失败视为成功空集', async () => {
    const fetchPage = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ items: [{ id: 'a' }], nextCursor: '1' })
      .mockResolvedValueOnce({ items: [], nextCursor: '1' });
    const delivered = vi.fn();
    const sync = createFeedSync(fetchPage, delivered);
    await expect(sync.refresh()).rejects.toThrow('offline');
    await sync.refresh();
    expect(fetchPage.mock.calls[1]?.[0]).toBe('0');
    expect(delivered).toHaveBeenCalledWith([{ id: 'a' }]);
  });
});

describe('专题范围输入', () => {
  it('支持跨日期变更线范围并拒绝非法经纬度', () => {
    expect(parseBbox('170,-10,-170,10')).toEqual([170, -10, -170, 10]);
    expect(() => parseBbox('181,0,190,10')).toThrow();
    expect(() => parseBbox('120,35,130,20')).toThrow();
    expect(() => parseBbox('120,,130,20')).toThrow();
  });
});
