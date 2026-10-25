import { shallowRef } from 'vue';
import type { Bbox, IntelligenceGeometry } from '@ais/contracts';
import type {
  MapAttentionRequest,
  MapEffectFrame,
  MapEffectIcon,
  MapEffectTarget,
  MapEffectBounds,
} from '../types/mapEffects';
import { resolveVesselDirection } from '../utils/vesselMarkers';
import { cameraPadding } from '../utils/mapCamera';
import { MAP_EFFECT_COLOR, mapEffectTargetIcon } from '../utils/mapEffects';
import { focusObjectViewport, type FocusSide } from '../utils/focusLayout';

export interface ChartEffectSelection extends MapEffectTarget {
  kind: string;
  id: string;
  revision?: number | string;
}
export type ChartEffectSelectionInput =
  | Omit<ChartEffectSelection, 'key'>
  | (MapEffectTarget & Partial<Pick<ChartEffectSelection, 'kind' | 'id' | 'revision'>>)
  | null;

function normalizeChartEffectSelection(input: ChartEffectSelectionInput) {
  if (input === null) return null;
  if ('key' in input) {
    const vessel = /^vessel:([1-9]\d{8})$/.exec(input.key);
    return {
      target: {
        ...input,
        kind: input.kind ?? (vessel ? 'vessel' : 'opaque'),
        id: input.id ?? vessel?.[1] ?? input.key,
      },
      explicitKey: true,
    };
  }
  return {
    target: { ...input, key: chartEffectKey(input.kind, input.id, input.revision) },
    explicitKey: false,
  };
}
export function chartEffectKey(kind: string, id: string, revision?: number | string) {
  return kind === 'vessel' ? `vessel:${id}` : `${kind}:${id}:${revision ?? 'current'}`;
}
export function resultSelectionGeometries(result: {
  evidence: {
    ais: { mmsi: string; longitude: number; latitude: number; occurredAt: string }[];
    documents: { bbox?: Bbox | null }[];
  };
}): IntelligenceGeometry[] {
  const groups = new Map<string, typeof result.evidence.ais>();
  for (const point of result.evidence.ais) {
    const group = groups.get(point.mmsi);
    if (group) group.push(point);
    else groups.set(point.mmsi, [point]);
  }
  const geometries: IntelligenceGeometry[] = [...groups.values()].map((group) => {
    const coordinates = group
      .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
      .map((point): [number, number] => [point.longitude, point.latitude]);
    return coordinates.length > 1
      ? { type: 'LineString', coordinates }
      : { type: 'Point', coordinates: coordinates[0]! };
  });
  for (const document of result.evidence.documents) {
    if (!document.bbox) continue;
    const [west, south, east, north] = document.bbox;
    const boxes: Bbox[] =
      west > east
        ? [
            [west, south, 180, north],
            [-180, south, east, north],
          ]
        : [document.bbox];
    for (const [w, s, e, n] of boxes)
      geometries.push({
        type: 'Polygon',
        coordinates: [
          [
            [w, s],
            [e, s],
            [e, n],
            [w, n],
            [w, s],
          ],
        ],
      });
  }
  return geometries;
}
/** Selection owns only map presentation; detail hosts and evidence retain their own lifetime. */
export function useChartEffects() {
  const selected = shallowRef<ChartEffectSelection | null>(null);
  const attentionRequests = shallowRef<MapAttentionRequest[]>([]);
  const attentionIds = new Set<string>();
  const latest = new Map<
    string,
    {
      lon: number;
      lat: number;
      observedAt: string;
      headingDegrees?: number | null;
      cogDegrees?: number | null;
    }
  >();
  let generation = 0;
  let preserveSelectionKey = false;
  function select(input: ChartEffectSelectionInput) {
    const normalized = normalizeChartEffectSelection(input);
    if (!normalized) {
      clearSelection();
      return () => false;
    }
    const current = ++generation;
    const target = normalized.target;
    preserveSelectionKey = normalized.explicitKey;
    if (target.kind !== 'vessel' || target.id !== selected.value?.id) latest.clear();
    selected.value = target;
    refreshSelectedVessel();
    return () => generation === current;
  }
  function clearSelection() {
    generation++;
    selected.value = null;
    preserveSelectionKey = false;
    latest.clear();
  }
  function updateSelected(
    current: () => boolean,
    geometries: IntelligenceGeometry[],
    revision?: number | string,
  ) {
    if (!current() || !selected.value) return;
    const selection = selected.value;
    selected.value = {
      ...selection,
      geometries,
      ...(revision !== undefined
        ? {
            revision,
            ...(preserveSelectionKey
              ? {}
              : { key: chartEffectKey(selection.kind, selection.id, revision) }),
          }
        : {}),
    };
    refreshSelectedVessel();
  }
  function refreshSelectedVessel() {
    seedSelectedVessel();
    const target = selected.value;
    if (target?.kind !== 'vessel') return;
    const point = latest.get(target.id);
    if (!point) return;
    selected.value = {
      ...target,
      geometries: [{ type: 'Point', coordinates: [point.lon, point.lat] }],
      observedAt: point.observedAt,
      bearing: resolveVesselDirection(point).bearing,
      icon: 'vessel',
    };
  }
  function seedSelectedVessel() {
    const target = selected.value;
    if (target?.kind !== 'vessel' || !target.observedAt) return;
    const observed = Date.parse(target.observedAt);
    if (!Number.isFinite(observed)) return;
    const geometry = target.geometries.find(
      (geometry) =>
        geometry.type === 'Point' &&
        Number.isFinite(geometry.coordinates[0]) &&
        Number.isFinite(geometry.coordinates[1]) &&
        Math.abs(geometry.coordinates[0]) <= 180 &&
        Math.abs(geometry.coordinates[1]) <= 90,
    );
    if (geometry?.type !== 'Point') return;
    const previous = latest.get(target.id);
    if (previous && Date.parse(previous.observedAt) >= observed) return;
    latest.set(target.id, {
      lon: geometry.coordinates[0],
      lat: geometry.coordinates[1],
      observedAt: target.observedAt,
      ...(target.icon === 'vessel' && target.bearing !== undefined
        ? { headingDegrees: target.bearing }
        : {}),
    });
  }
  function updateVessels(
    points: {
      mmsi: string;
      lon: number;
      lat: number;
      observedAt: string;
      headingDegrees?: number | null;
      cogDegrees?: number | null;
    }[],
  ) {
    // The selected AI snapshot can be newer than the fleet currently loaded in the viewport.
    seedSelectedVessel();
    for (const point of points) {
      if (selected.value?.kind !== 'vessel' || selected.value.id !== point.mmsi) continue;
      const time = Date.parse(point.observedAt);
      if (
        !Number.isFinite(time) ||
        !Number.isFinite(point.lon) ||
        !Number.isFinite(point.lat) ||
        Math.abs(point.lon) > 180 ||
        Math.abs(point.lat) > 90
      )
        continue;
      const previous = latest.get(point.mmsi);
      if (previous && Date.parse(previous.observedAt) > time) continue;
      latest.set(point.mmsi, point);
    }
    refreshSelectedVessel();
  }
  function playAttention(request: MapAttentionRequest) {
    if (attentionIds.has(request.id)) return false;
    attentionIds.add(request.id);
    attentionRequests.value = [...attentionRequests.value, request];
    return true;
  }
  function cancelAttention(id?: string) {
    attentionRequests.value = releaseChartAttentionRequests(attentionRequests.value, id).retained;
  }
  function reset() {
    clearSelection();
    cancelAttention();
    attentionIds.clear();
  }
  return {
    selected,
    select,
    clearSelection,
    updateSelected,
    updateVessels,
    attentionRequests,
    playAttention,
    cancelAttention,
    reset,
  };
}

/** Cancelling a pending batch releases its coordinates even when no clock completion fires. */
export function releaseChartAttentionRequests(requests: MapAttentionRequest[], id?: string) {
  return {
    retained: requests.filter((request) => id !== undefined && request.id !== id),
    released: [
      ...new Set(
        requests
          .filter((request) => id === undefined || request.id === id)
          .map((request) => request.id),
      ),
    ],
  };
}

export function chartAttentionIcon(request: MapEffectIcon, target?: MapEffectIcon): MapEffectIcon {
  return request === 'vessel' && target === 'unknown' ? 'unknown' : request;
}
/** Focus points are rendered by GL; only its current source snapshot can confirm their frame. */
export function chartFocusEffectsReady(
  focusTargets: MapEffectTarget[],
  current: MapEffectTarget[],
  displayed: MapEffectTarget[] | null,
) {
  return (
    !focusTargets.some((target) =>
      target.geometries.some(
        (geometry) => geometry.type === 'Point' || geometry.type === 'MultiPoint',
      ),
    ) || current === displayed
  );
}
export function chartAttentionFeedbackVisible(
  frame: MapEffectFrame,
  hidden: boolean,
  reduced: boolean,
) {
  return (
    !hidden &&
    !!frame.request &&
    frame.visible &&
    frame.phase !== 'done' &&
    (!reduced || frame.phase === 'static')
  );
}

/** Equal permanent glyphs already provide reduced-motion feedback; distinct attention stays visible. */
export function chartAttentionHasPermanentGlyph(
  request: MapAttentionRequest,
  target: MapEffectTarget,
  persistent: MapEffectTarget[],
) {
  const icon = chartAttentionIcon(request.icon, mapEffectTargetIcon(target));
  if ((request.color ?? MAP_EFFECT_COLOR).toUpperCase() !== MAP_EFFECT_COLOR) return false;
  return persistent.some(
    (candidate) =>
      candidate.key === target.key &&
      candidate.geometries.some((geometry) => geometry.type === 'Point') &&
      mapEffectTargetIcon(candidate) === icon,
  );
}

/** A queued batch retains its full scope while each playback frame chooses visible targets. */
export function chartAttentionRequest(
  request: MapAttentionRequest,
  visibleKeys: ReadonlySet<string>,
) {
  return request.targets.some((target) => visibleKeys.has(target.key)) ? request : null;
}

/** GL yields to SVG only for the two flash beats, and only for currently visible point glyphs. */
export function chartAttentionVisibility(
  frame: MapEffectFrame,
  targets: { key: string; isPoint: boolean }[],
  paused: boolean,
) {
  const active = new Set(frame.request?.targets.map((target) => target.key));
  const hidden =
    !paused && frame.phase === 'blink'
      ? targets
          .filter((target) => target.isPoint && active.has(target.key))
          .map((target) => target.key)
          .sort()
      : [];
  return { hidden, muted: !frame.visible ? hidden : [] };
}

/** Merge task/manual/AI presentation by entity, independently of evidence-reference identity. */
export function mergeChartEffectTargets(targets: MapEffectTarget[]): MapEffectTarget[] {
  const merged = new Map<string, MapEffectTarget>();
  for (const target of targets) {
    const before = merged.get(target.key);
    if (!before) {
      merged.set(target.key, target);
      continue;
    }
    if (target.key.startsWith('vessel:')) {
      const beforeTime = Date.parse(before.observedAt ?? '');
      const targetTime = Date.parse(target.observedAt ?? '');
      const newer =
        (Number.isFinite(targetTime) &&
          (!Number.isFinite(beforeTime) || targetTime > beforeTime)) ||
        !before.geometries.length;
      merged.set(
        target.key,
        newer ? { ...before, ...target, effectId: before.effectId ?? target.effectId } : before,
      );
    } else {
      const geometries = new Map(
        [...before.geometries, ...target.geometries].map((geometry) => [
          JSON.stringify(geometry),
          geometry,
        ]),
      );
      merged.set(target.key, { ...before, geometries: [...geometries.values()] });
    }
  }
  return [...merged.values()];
}

export function intersectChartEffectViewports(
  view: MapEffectBounds,
  other?: MapEffectBounds | null,
): MapEffectBounds {
  if (!other) return view;
  const left = Math.max(view.left, other.left),
    top = Math.max(view.top, other.top);
  return {
    left,
    top,
    right: Math.max(left, Math.min(view.right, other.right)),
    bottom: Math.max(top, Math.min(view.bottom, other.bottom)),
  };
}

/** Visible feedback follows the measured reply, while composition retains its expansion budget. */
export function chartEffectReplyViewport(
  view: MapEffectBounds,
  layout: { side: FocusSide; width: number; objectMinHeight: number },
  actualHeight: number,
): MapEffectBounds {
  return focusObjectViewport(view, layout.side, layout.width, actualHeight, layout.objectMinHeight);
}

/** Overlay rectangles use the actual canvas's client bounds; the returned budget uses local CSS pixels. */
export function chartEffectVisualViewport(
  view: MapEffectBounds | null,
  canvas: MapEffectBounds | null,
  overlays: Parameters<typeof cameraPadding>[1],
): MapEffectBounds | null {
  if (!view || !canvas) return view;
  const padding = cameraPadding(canvas, overlays);
  return intersectChartEffectViewports(view, {
    left: padding.left,
    top: padding.top,
    right: canvas.right - canvas.left - padding.right,
    bottom: canvas.bottom - canvas.top - padding.bottom,
  });
}

export interface ChartEffectViewportPort {
  effectViewport(): MapEffectBounds | null;
}

/** Both overlays reuse one actual map-frame snapshot; effect occlusion never changes navigation padding. */
export function createChartEffectProjection<
  T extends {
    projectFocus(
      point: [number, number],
      anchorLongitude?: number,
    ): { x: number; y: number } | null;
    cameraState(): unknown;
    focusViewport(): MapEffectBounds | null;
    onFocusRender(listener: () => void): () => void;
  },
>(
  map: T,
  visualViewport?: (view: MapEffectBounds | null) => MapEffectBounds | null,
): T & ChartEffectViewportPort & { disposeEffectProjection(): void } {
  let camera = map.cameraState();
  let viewport = map.focusViewport();
  let effectViewport = visualViewport ? visualViewport(viewport) : viewport;
  const projected = new Map<string, { x: number; y: number } | null>();
  const listeners = new Set<() => void>();
  const remove = map.onFocusRender(() => {
    projected.clear();
    camera = map.cameraState();
    viewport = map.focusViewport();
    effectViewport = visualViewport ? visualViewport(viewport) : viewport;
    for (const listener of listeners) listener();
  });
  return new Proxy(map, {
    get(target, property) {
      if (property === 'disposeEffectProjection')
        return () => {
          remove();
          listeners.clear();
          projected.clear();
        };
      if (property === 'cameraState') return () => camera;
      if (property === 'focusViewport') return () => viewport;
      if (property === 'effectViewport') return () => effectViewport;
      if (property === 'onFocusRender')
        return (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        };
      if (property !== 'projectFocus') return Reflect.get(target, property);
      return (point: [number, number], anchorLongitude?: number) => {
        const key = JSON.stringify([point, anchorLongitude]);
        if (!projected.has(key)) projected.set(key, target.projectFocus(point, anchorLongitude));
        return projected.get(key) ?? null;
      };
    },
  }) as T & ChartEffectViewportPort & { disposeEffectProjection(): void };
}
