import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import {
  ONLINE_BASE_LAYER_OPACITIES,
  ONLINE_SEAMARK_LAYER_ID,
  ONLINE_SEAMARK_SOURCE_ID,
  ONLINE_VECTOR_SOURCE_ID,
  type OnlineChartConfig,
} from './onlineChartStyle';

export type OnlineChartStatus = 'disabled' | 'loading' | 'ready' | 'fallback';
export interface OnlineChartState {
  base: OnlineChartStatus;
  seamarks: OnlineChartStatus;
  baseRetriesRemaining: number;
  seamarkRetriesRemaining: number;
}
type SourceEvent = {
  sourceId?: string;
  tile?: unknown;
};
type ChartEvent = 'sourcedata' | 'sourcedataloading' | 'error' | 'render' | 'movestart' | 'moveend';
interface OnlineChartMap {
  getLayer(id: string): unknown;
  getSource(id: string): unknown;
  isSourceLoaded(id: string): boolean;
  setPaintProperty(id: string, name: string, value: unknown): unknown;
  triggerRepaint(): unknown;
  getStyle(): StyleSpecification;
  addSource(id: string, source: SourceSpecification): unknown;
  removeSource(id: string): unknown;
  addLayer(layer: LayerSpecification, beforeId?: string): unknown;
  removeLayer(id: string): unknown;
  on(type: ChartEvent, listener: (event: SourceEvent) => void): unknown;
  off(type: ChartEvent, listener: (event: SourceEvent) => void): unknown;
}

/** Keep each online group transparent until real viewport tiles have reached a render. */
export function createOnlineChartCoverage(
  map: OnlineChartMap,
  config: OnlineChartConfig,
  onState: (state: OnlineChartState) => void,
  options: { timeoutMs?: number } = {},
) {
  const groups = [
    {
      key: 'base' as const,
      sourceId: ONLINE_VECTOR_SOURCE_ID,
      rootSourceId: ONLINE_VECTOR_SOURCE_ID,
      enabled: config.enabled,
      layers: ONLINE_BASE_LAYER_OPACITIES,
      state: (config.enabled ? 'loading' : 'disabled') as OnlineChartStatus,
      hasTile: false,
      pending: true,
      generation: 0,
      retries: 2,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      timerRevision: 0,
    },
    {
      key: 'seamarks' as const,
      sourceId: ONLINE_SEAMARK_SOURCE_ID,
      rootSourceId: ONLINE_SEAMARK_SOURCE_ID,
      enabled: config.seamarksEnabled,
      layers: [{ id: ONLINE_SEAMARK_LAYER_ID, property: 'raster-opacity', readyValue: 1 }],
      state: (config.seamarksEnabled ? 'loading' : 'disabled') as OnlineChartStatus,
      hasTile: false,
      pending: true,
      generation: 0,
      retries: 2,
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      timerRevision: 0,
    },
  ];
  let disposed = false;
  let moving = false;
  function clearDeadline(group: (typeof groups)[number]) {
    clearTimeout(group.timer);
    group.timer = undefined;
    ++group.timerRevision;
  }
  function startDeadline(group: (typeof groups)[number]) {
    if (moving || disposed || group.state !== 'loading' || group.timer !== undefined) return;
    const revision = ++group.timerRevision;
    group.timer = setTimeout(() => {
      if (!disposed && revision === group.timerRevision && group.state === 'loading')
        change(group, 'fallback');
    }, options.timeoutMs ?? 15_000);
    // Node-based tooling must not remain alive solely for a map's pending viewport.
    if (typeof group.timer === 'object' && 'unref' in group.timer) group.timer.unref();
  }
  const snapshot = (): OnlineChartState => ({
    base: groups[0]!.state,
    seamarks: groups[1]!.state,
    baseRetriesRemaining: groups[0]!.retries,
    seamarkRetriesRemaining: groups[1]!.retries,
  });
  function change(group: (typeof groups)[number], next: OnlineChartStatus) {
    if (disposed || group.state === next) return;
    group.state = next;
    if (next !== 'loading') clearDeadline(group);
    else startDeadline(group);
    // Synchronous paint updates are applied together by the following MapLibre frame.
    for (const layer of group.layers)
      if (map.getLayer(layer.id))
        map.setPaintProperty(layer.id, layer.property, next === 'ready' ? layer.readyValue : 0);
    onState(snapshot());
  }
  function sourceChanged(event: SourceEvent) {
    const group = groups.find((item) => item.sourceId === event.sourceId);
    if (!group || group.state === 'fallback' || group.state === 'disabled') return;
    if (event.tile) group.hasTile = true;
    group.pending = true;
  }
  function sourceLoading(event: SourceEvent) {
    const group = groups.find((item) => item.sourceId === event.sourceId);
    if (!group || group.state === 'fallback' || group.state === 'disabled') return;
    group.pending = true;
    change(group, 'loading');
  }
  function fail(event: SourceEvent) {
    const group = groups.find((item) => item.sourceId === event.sourceId);
    if (group && group.enabled) change(group, 'fallback');
  }
  function check() {
    if (disposed || moving) return;
    for (const group of groups) {
      if (group.state !== 'loading' || !group.pending) continue;
      if (!group.hasTile) continue;
      // loaded() alone also accepts errored tiles; fallback is latched above until manual retry.
      if (map.getSource(group.sourceId) && map.isSourceLoaded(group.sourceId)) {
        group.pending = false;
        change(group, 'ready');
      }
    }
  }
  function moveStart() {
    moving = true;
    for (const group of groups) {
      clearDeadline(group);
      if (group.state === 'ready') change(group, 'loading');
    }
  }
  function moveEnd() {
    moving = false;
    for (const group of groups) {
      group.pending = true;
      startDeadline(group);
    }
    map.triggerRepaint();
  }
  const listeners: [ChartEvent, (event: SourceEvent) => void][] = [
    ['sourcedata', sourceChanged],
    ['sourcedataloading', sourceLoading],
    ['error', fail],
    ['render', check],
    ['movestart', moveStart],
    ['moveend', moveEnd],
  ];
  for (const group of groups)
    if (
      group.enabled &&
      (!map.getSource(group.sourceId) || !group.layers.every((v) => map.getLayer(v.id)))
    )
      group.state = 'fallback';
  onState(snapshot());
  for (const group of groups) startDeadline(group);
  if (groups.some((group) => group.enabled))
    for (const [type, listener] of listeners) map.on(type, listener);
  return {
    retry(key: 'base' | 'seamarks') {
      const group = groups.find((item) => item.key === key)!;
      if (disposed || group.state !== 'fallback' || group.retries === 0) return false;
      const style = map.getStyle();
      const source = style.sources[group.sourceId];
      const ids = new Set(group.layers.map((layer) => layer.id));
      const layers = style.layers.filter((layer) => ids.has(layer.id));
      if (!source || layers.length !== ids.size) return false;
      const last = style.layers.findLastIndex((layer) => ids.has(layer.id));
      const beforeId = style.layers[last + 1]?.id;
      const previousId = group.sourceId;
      --group.retries;
      ++group.generation;
      group.sourceId = `${group.rootSourceId}-g${group.generation}`;
      group.hasTile = false;
      group.pending = true;
      change(group, 'loading');
      try {
        // Only this online group is replaced. A new source ID makes old asynchronous
        // completions unambiguously obsolete while retaining the Map and business data.
        for (const layer of layers) map.removeLayer(layer.id);
        map.removeSource(previousId);
        map.addSource(group.sourceId, source);
        for (const layer of layers) {
          if ('source' in layer && layer.source === previousId) layer.source = group.sourceId;
          const opacity = group.layers.find((entry) => entry.id === layer.id)!;
          layer.paint = { ...layer.paint, [opacity.property]: 0 } as LayerSpecification['paint'];
          map.addLayer(layer, beforeId);
        }
        map.triggerRepaint();
      } catch {
        change(group, 'fallback');
      }
      return true;
    },
    dispose() {
      disposed = true;
      for (const group of groups) clearDeadline(group);
      for (const [type, listener] of listeners) map.off(type, listener);
    },
  };
}
