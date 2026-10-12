import type { AnalysisFeedItem, MapResponse } from '@ais/contracts';
import { createFeedSync } from '../utils/fusion';

export interface ViewportQuery {
  bbox: string;
  zoom: number;
  hours: number;
  sourceId?: string;
  shipType?: string;
}

let socket: WebSocket | null = null;
let viewport: ViewportQuery | null = null;
let version = 0;

/** The app shell owns one authenticated socket; pages consume shared state. */
export function useFusionEvents() {
  const status = useState<'connecting' | 'live' | 'offline'>('fusion-status', () => 'offline');
  const error = useState('fusion-error', () => '');
  const analysisVersion = useState('fusion-analysis-version', () => 0);
  const mapData = useState<MapResponse | null>('fusion-map-data', () => null);
  function subscribeViewport(query: ViewportQuery) {
    viewport = query;
    version++;
    if (socket?.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'viewport', query, version }));
  }
  return { status, error, analysisVersion, mapData, subscribeViewport };
}

export function startFusionEvents() {
  const { api, session } = usePlatform();
  const { status, error, analysisVersion, mapData } = useFusionEvents();
  let stopped = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let retry = 0;
  let sessionGeneration = 0;
  const sync = createFeedSync<AnalysisFeedItem>(
    (cursor) => api('/analysis/feed?cursor=' + encodeURIComponent(cursor)),
    () => {
      analysisVersion.value++;
    },
  );
  async function catchUp() {
    const current = sessionGeneration;
    try {
      await sync.refresh();
      if (current === sessionGeneration && status.value === 'live') error.value = '';
    } catch (e) {
      if (current === sessionGeneration) error.value = (e as Error).message;
    }
  }
  function connect() {
    if (stopped || !session.value || socket) return;
    status.value = 'connecting';
    const active = new WebSocket(
      `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/v1/live?cursor=${encodeURIComponent(sync.getCursor())}`,
    );
    socket = active;
    active.onopen = () => {
      if (socket !== active) return;
      retry = 0;
      status.value = 'live';
      if (viewport) active.send(JSON.stringify({ type: 'viewport', query: viewport, version }));
      void catchUp();
    };
    active.onmessage = (event) => {
      if (socket !== active) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'analysis.updated') void catchUp();
        if (message.type === 'error') {
          status.value = 'offline';
          error.value = '实时数据暂不可用，已切换接口补取';
          active.close();
          return;
        }
        if (message.version !== version) return;
        if (message.type === 'ais.snapshot') mapData.value = message.data as MapResponse;
        if (message.type === 'ais.delta' && mapData.value) {
          const key = (item: MapResponse['items'][number]) =>
            item.kind === 'point' ? `point:${item.mmsi}` : `cluster:${item.clusterId}`;
          const items = new Map(mapData.value.items.map((item) => [key(item), item]));
          for (const id of message.remove as string[]) items.delete(id);
          for (const item of message.upsert as MapResponse['items']) items.set(key(item), item);
          mapData.value = {
            ...mapData.value,
            items: [...items.values()],
            total: message.total,
            sampled: message.sampled,
            truncated: message.truncated,
            generatedAt: message.generatedAt,
          };
        }
      } catch {
        status.value = 'offline';
        error.value = '实时事件格式异常，将通过接口补取更新';
        active.close();
        void catchUp();
      }
    };
    active.onerror = () => active.close();
    active.onclose = () => {
      if (socket === active) socket = null;
      status.value = 'offline';
      if (!stopped && session.value)
        reconnect = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    };
  }
  function disconnect() {
    clearTimeout(reconnect);
    const active = socket;
    socket = null;
    if (active) {
      active.onclose = null;
      active.close();
    }
    status.value = 'offline';
  }
  const stopWatch = watch(
    () => session.value?.user.id,
    (id) => {
      sessionGeneration++;
      sync.reset();
      disconnect();
      mapData.value = null;
      viewport = null;
      version++;
      error.value = '';
      if (id) {
        connect();
        void catchUp();
      }
    },
  );
  onMounted(() => {
    connect();
    if (session.value) void catchUp();
    fallback = setInterval(() => {
      if (session.value) void catchUp();
    }, 15000);
  });
  onBeforeUnmount(() => {
    stopped = true;
    sessionGeneration++;
    sync.reset();
    stopWatch();
    clearInterval(fallback);
    disconnect();
  });
}
