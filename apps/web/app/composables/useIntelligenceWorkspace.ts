import type {
  Bbox,
  IntelligenceEvent,
  IntelligencePlot,
  IntelligenceRelation,
  IntelligenceSource,
  IntelligenceGeoObject,
} from '@ais/contracts';
import { queryString } from '../utils/display';
export function useIntelligenceWorkspace() {
  const { api } = usePlatform();
  const items = ref<IntelligenceEvent[]>([]);
  const sources = ref<IntelligenceSource[]>([]);
  const objects = ref<IntelligenceGeoObject[]>([]);
  const selectedIds = ref<string[]>([]);
  const plottedIds = ref<string[]>([]);
  const hiddenIds = ref<string[]>([]);
  const plot = ref<IntelligencePlot>({ type: 'FeatureCollection', features: [], items: [] });
  const detail = ref<{
    event: IntelligenceEvent;
    relations: IntelligenceRelation[];
    history: unknown[];
  } | null>(null);
  const activeId = ref('');
  const busy = ref(false);
  const error = ref('');
  const feedback = ref('');
  const cursor = ref<string | null>(null);
  const includeCandidates = ref(false);
  const viewportOnly = ref(false);
  const bounds = ref<Bbox>([-180, -85, 180, 85]);
  const layerVisibility = reactive({
    location: true,
    object: true,
    impact: true,
    candidate: true,
    directory: true,
  });
  const filters = reactive({
    keyword: '',
    category: '',
    sourceId: '',
    reviewStatus: '',
    status: '',
    from: '',
    to: '',
    objectId: '',
  });
  let appliedQuery: Record<string, string> = {};
  let generation = 0;
  let detailGeneration = 0;
  let disposed = false;
  let plotGeneration = 0;
  let queue: Promise<void> = Promise.resolve();
  const visiblePlot = computed(() => ({
    ...plot.value,
    features: plot.value.features.filter((f) => !hiddenIds.value.includes(f.properties.eventId)),
  }));
  async function load(more = false) {
    const current = ++generation;
    busy.value = true;
    error.value = '';
    try {
      const query = more
        ? { ...appliedQuery }
        : Object.fromEntries(Object.entries(filters).filter(([, value]) => value));
      for (const field of ['from', 'to'])
        if (query[field])
          query[field] = new Date(
            query[field] + (query[field].endsWith('Z') ? '' : 'Z'),
          ).toISOString();
      const response = await api<{ items: IntelligenceEvent[]; nextCursor: string | null }>(
        '/intelligence/events' +
          queryString({
            ...query,
            latest: 'true',
            limit: 30,
            cursor: more ? (cursor.value ?? undefined) : undefined,
            bbox: viewportOnly.value ? bounds.value.join(',') : undefined,
          }),
      );
      if (current === generation && !disposed) {
        if (!more) appliedQuery = { ...query };
        items.value = more ? [...items.value, ...response.items] : response.items;
        cursor.value = response.nextCursor;
      }
    } catch (e) {
      if (current === generation) error.value = (e as Error).message;
    } finally {
      if (current === generation) busy.value = false;
    }
  }
  function toggleSelection(id: string) {
    selectedIds.value = selectedIds.value.includes(id)
      ? selectedIds.value.filter((v) => v !== id)
      : [...selectedIds.value, id];
  }
  async function refreshPlot() {
    const current = ++plotGeneration;
    const response = await api<IntelligencePlot>('/intelligence/plot', {
      method: 'POST',
      body: { eventIds: plottedIds.value, includeCandidates: includeCandidates.value },
    });
    if (disposed || current !== plotGeneration) return;
    plot.value = response;
    feedback.value = plot.value.items
      .filter((v) => !v.featureCount)
      .map((v) => `${v.title}：${v.reason || '没有可定位位置'}`)
      .join('；');
  }
  async function persist() {
    if (disposed) return;
    await api('/intelligence/plot-set', {
      method: 'PUT',
      body: { eventIds: plottedIds.value, hiddenEventIds: hiddenIds.value },
    });
  }
  async function mutate(action: () => void) {
    const operation = queue.then(async () => {
      if (disposed) return;
      const previous = {
        plotted: [...plottedIds.value],
        hidden: [...hiddenIds.value],
        plot: plot.value,
        feedback: feedback.value,
      };
      error.value = '';
      try {
        action();
        await refreshPlot();
        await persist();
      } catch (e) {
        plottedIds.value = previous.plotted;
        hiddenIds.value = previous.hidden;
        plot.value = previous.plot;
        feedback.value = previous.feedback;
        error.value = (e as Error).message;
      }
    });
    queue = operation.catch(() => {});
    await operation;
  }
  async function add(ids = selectedIds.value) {
    await mutate(() => {
      plottedIds.value = [...new Set([...plottedIds.value, ...ids])];
      hiddenIds.value = hiddenIds.value.filter((id) => !ids.includes(id));
    });
  }
  async function remove(ids = selectedIds.value) {
    await mutate(() => {
      plottedIds.value = plottedIds.value.filter((id) => !ids.includes(id));
      hiddenIds.value = hiddenIds.value.filter((id) => !ids.includes(id));
    });
  }
  async function hide(ids = selectedIds.value) {
    await mutate(() => {
      hiddenIds.value = [
        ...new Set([...hiddenIds.value, ...ids.filter((id) => plottedIds.value.includes(id))]),
      ];
    });
  }
  async function clear() {
    await mutate(() => {
      plottedIds.value = [];
      hiddenIds.value = [];
    });
  }
  async function select(id: string, plotIt = true) {
    activeId.value = id;
    const current = ++detailGeneration;
    error.value = '';
    detail.value = null;
    try {
      const response = await api<NonNullable<typeof detail.value>>(
        '/intelligence/events/' + encodeURIComponent(id),
      );
      if (current === detailGeneration && !disposed) detail.value = response;
      if (plotIt && current === detailGeneration && !disposed) await add([id]);
    } catch (e) {
      if (current === detailGeneration) error.value = (e as Error).message;
    }
  }
  function resetDetail() {
    detailGeneration++;
    activeId.value = '';
    detail.value = null;
    error.value = '';
  }
  async function safeRefreshPlot() {
    try {
      await refreshPlot();
    } catch (e) {
      if (!disposed) error.value = (e as Error).message;
    }
  }
  async function restore() {
    try {
      const set = await api<{ eventIds: string[]; hiddenEventIds: string[] }>(
        '/intelligence/plot-set',
      );
      if (disposed) return;
      plottedIds.value = set.eventIds;
      hiddenIds.value = set.hiddenEventIds.filter((id) => set.eventIds.includes(id));
      await safeRefreshPlot();
    } catch (e) {
      if (!disposed) error.value = (e as Error).message;
    }
    const results = await Promise.allSettled([
      api<IntelligenceSource[]>('/intelligence/sources'),
      api<{ items: IntelligenceGeoObject[] }>('/intelligence/objects'),
    ]);
    if (disposed) return;
    if (results[0].status === 'fulfilled') sources.value = results[0].value;
    else error.value = (results[0].reason as Error).message;
    if (results[1].status === 'fulfilled') objects.value = results[1].value.items ?? [];
    else error.value = (results[1].reason as Error).message;
  }
  function viewport(bbox: Bbox) {
    bounds.value = bbox;
    if (viewportOnly.value) void load();
  }
  onMounted(() => {
    void load();
    queue = restore();
  });
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    detailGeneration++;
    plotGeneration++;
  });
  return {
    items,
    sources,
    objects,
    filters,
    cursor,
    selectedIds,
    plottedIds,
    hiddenIds,
    activeId,
    detail,
    busy,
    error,
    feedback,
    plot,
    visiblePlot,
    includeCandidates,
    layerVisibility,
    viewportOnly,
    load,
    toggleSelection,
    add,
    remove,
    hide,
    clear,
    select,
    resetDetail,
    restore,
    refreshPlot: safeRefreshPlot,
    viewport,
  };
}
