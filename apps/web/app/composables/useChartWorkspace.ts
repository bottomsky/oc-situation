import type {
  Bbox,
  MapResponse,
  TrackResponse,
  VesselDetail,
  VesselSummary,
  Page,
  SourceConfig,
} from '@ais/contracts';
import { queryString, trackFrame } from '../utils/display';
import { createRequestGeneration, visibleVesselRows } from '../utils/chartWorkspace';
export type ChartSource = SourceConfig & {
  lastReceivedAt?: string | null;
  lastError?: string | null;
};
export function useChartWorkspace() {
  const { api } = usePlatform();
  const route = useRoute();
  const leftTab = ref<'search' | 'layers' | 'playback' | 'intelligence' | 'heatmap'>('search');
  const nameCache = ref(new Map<string, string>());
  const rows = computed(() => visibleVesselRows(data.value?.items ?? [], nameCache.value));
  const searchRequests = createRequestGeneration();
  const detailRequests = createRequestGeneration();
  const trackRequests = createRequestGeneration();
  const {
    status: liveStatus,
    error: liveError,
    feedError,
    mapData,
    subscribeViewport,
  } = useFusionEvents();
  const data = ref<MapResponse | null>(null);
  const track = ref<TrackResponse | null>(null);
  const detail = ref<VesselDetail | null>(null);
  const sources = ref<ChartSource[]>([]);
  const sourceError = ref('');
  let sourceBusy = false;
  async function refreshSources() {
    if (sourceBusy) return;
    sourceBusy = true;
    try {
      const response = await api<ChartSource[]>('/sources');
      if (!disposed) {
        sources.value = response;
        sourceError.value = '';
      }
    } catch (e) {
      if (!disposed) sourceError.value = (e as Error).message;
    } finally {
      sourceBusy = false;
    }
  }
  const results = ref<VesselSummary[]>([]);
  const cursor = ref<string | null>(null);
  const sourceId = ref('');
  const hours = ref(24);
  const shipType = ref('');
  const search = ref('');
  const appliedSearch = ref('');
  const searchCompleted = ref(false);
  const busy = ref(false);
  const searchBusy = ref(false);
  const trackBusy = ref(false);
  const error = ref('');
  const detailError = ref('');
  const trackError = ref('');
  const searchError = ref('');
  const bbox = ref<Bbox>([-180, -85, 180, 85]);
  const zoom = ref(3);
  const lastSuccess = ref(0);
  const now = ref(Date.now());
  const paused = ref(false);
  const frameIndex = ref(0);
  const playing = ref(false);
  const from = ref(new Date(Date.now() - 86400000).toISOString().slice(0, 19));
  const to = ref(new Date().toISOString().slice(0, 19));
  const frame = computed(() => trackFrame(track.value, frameIndex.value));

  const stale = computed(() => lastSuccess.value > 0 && now.value - lastSuccess.value > 15000);
  let timer: ReturnType<typeof setInterval>;
  let playback: ReturnType<typeof setInterval>;
  let refreshQueued = false;
  let viewportGeneration = 0;
  let disposed = false;
  async function refresh() {
    if (busy.value) {
      refreshQueued = true;
      return;
    }
    const currentViewport = viewportGeneration;
    const startedAt = Date.now();
    busy.value = true;
    error.value = '';
    try {
      const response = await api<MapResponse>(
        '/map' +
          queryString({
            bbox: bbox.value.join(','),
            zoom: zoom.value,
            hours: hours.value,
            sourceId: sourceId.value || undefined,
            shipType: shipType.value || undefined,
          }),
      );
      if (!disposed && currentViewport === viewportGeneration && lastSuccess.value <= startedAt) {
        data.value = response;
        lastSuccess.value = Date.now();
      }
    } catch (e) {
      if (!disposed && currentViewport === viewportGeneration) error.value = (e as Error).message;
    } finally {
      busy.value = false;
      if (refreshQueued && !disposed) {
        refreshQueued = false;
        void refresh();
      }
    }
  }
  function viewport(bounds: Bbox, z: number) {
    bbox.value = bounds;
    zoom.value = Number.isFinite(z) ? Math.max(0, Math.min(22, z)) : zoom.value;
    subscribe();
    void refresh();
  }
  function subscribe() {
    viewportGeneration++;
    subscribeViewport({
      bbox: bbox.value.join(','),
      zoom: zoom.value,
      hours: hours.value,
      sourceId: sourceId.value || undefined,
      shipType: shipType.value || undefined,
    });
  }
  async function find(more = false) {
    if (more && (searchBusy.value || !cursor.value)) return;
    const current = searchRequests.next();
    const query = more ? appliedSearch.value : search.value.trim();
    const pageCursor = more ? cursor.value : null;
    if (!more) cursor.value = null;
    searchBusy.value = true;
    searchError.value = '';
    try {
      const page = await api<Page<VesselSummary>>(
        '/vessels' +
          queryString({
            query: query || undefined,
            limit: 20,
            cursor: pageCursor ?? undefined,
          }),
      );
      if (searchRequests.isCurrent(current)) {
        results.value = more ? [...results.value, ...page.items] : page.items;
        cursor.value = page.nextCursor;
        appliedSearch.value = query;
        searchCompleted.value = true;
        for (const item of page.items)
          if (item.staticFields.name) nameCache.value.set(item.mmsi, item.staticFields.name);
      }
    } catch (e) {
      if (searchRequests.isCurrent(current)) searchError.value = (e as Error).message;
    } finally {
      if (searchRequests.isCurrent(current)) searchBusy.value = false;
    }
  }
  async function select(mmsi: string) {
    const current = detailRequests.next();
    trackRequests.next();
    leftTab.value = 'search';
    detailError.value = '';
    detail.value = null;
    track.value = null;
    trackBusy.value = false;
    trackError.value = '';
    playing.value = false;
    try {
      const response = await api<VesselDetail>('/vessels/' + encodeURIComponent(mmsi));
      if (detailRequests.isCurrent(current)) {
        detail.value = response;
        if (response.staticFields.name) nameCache.value.set(mmsi, response.staticFields.name);
      }
    } catch (e) {
      if (detailRequests.isCurrent(current)) detailError.value = (e as Error).message;
    }
  }
  async function loadTrack() {
    const current = trackRequests.next();
    if (!detail.value) return;
    trackBusy.value = true;
    trackError.value = '';
    playing.value = false;
    try {
      const response = await api<TrackResponse>(
        '/vessels/' +
          detail.value.mmsi +
          '/track' +
          queryString({
            from: new Date(from.value + 'Z').toISOString(),
            to: new Date(to.value + 'Z').toISOString(),
            maxPoints: 5000,
          }),
      );
      if (trackRequests.isCurrent(current)) {
        track.value = response;
        frameIndex.value = 0;
      }
    } catch (e) {
      if (trackRequests.isCurrent(current)) trackError.value = (e as Error).message;
    } finally {
      if (trackRequests.isCurrent(current)) trackBusy.value = false;
    }
  }
  onMounted(async () => {
    let sourceTicks = 0;
    timer = setInterval(() => {
      now.value = Date.now();
      if (!paused.value && liveStatus.value !== 'live') void refresh();
      if (++sourceTicks % 6 === 0) void refreshSources();
    }, 5000);
    playback = setInterval(() => {
      if (playing.value && track.value) {
        if (frameIndex.value >= track.value.returned - 1) playing.value = false;
        else frameIndex.value++;
      }
    }, 600);
    await refreshSources();
    await refresh();
  });
  onBeforeUnmount(() => {
    disposed = true;
    searchRequests.next();
    detailRequests.next();
    trackRequests.next();
    viewportGeneration++;
    clearInterval(timer);
    clearInterval(playback);
  });
  watch([sourceId, hours, shipType], () => {
    subscribe();
    void refresh();
  });
  watch(mapData, (next) => {
    if (!paused.value && next) {
      data.value = next;
      lastSuccess.value = Date.now();
      error.value = '';
    }
  });
  watch(paused, (value) => {
    if (!value) {
      subscribe();
      void refresh();
    }
  });
  watch(liveStatus, (value) => {
    if (value === 'offline' && !paused.value) void refresh();
  });
  watch(
    () => [route.query.q, route.query.searchRevision],
    () => {
      search.value = typeof route.query.q === 'string' ? route.query.q.trim() : '';
      searchRequests.next();
      results.value = [];
      cursor.value = null;
      appliedSearch.value = '';
      searchCompleted.value = false;
      searchError.value = '';
      searchBusy.value = false;
      if (search.value && import.meta.client) {
        leftTab.value = 'search';
        void find(false);
      }
    },
    { immediate: true },
  );
  return {
    data,
    track,
    detail,
    sources,
    sourceError,
    refreshSources,
    results,
    cursor,
    sourceId,
    hours,
    shipType,
    search,
    appliedSearch,
    searchCompleted,
    busy,
    searchBusy,
    trackBusy,
    error,
    detailError,
    trackError,
    searchError,
    bbox,
    zoom,
    paused,
    frameIndex,
    playing,
    from,
    to,
    frame,
    stale,
    liveStatus,
    liveError,
    feedError,
    leftTab,
    rows,
    refresh,
    viewport,
    find,
    select,
    loadTrack,
  };
}
