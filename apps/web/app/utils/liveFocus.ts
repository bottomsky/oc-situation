import type { AgentFocusResult, FocusTargetSnapshot, MapResponse, MapPoint } from '@ais/contracts';
import { focusBounds } from '../../../../packages/domain/agent-focus';

/** Live positions are presentation state; the task snapshot remains the receipt identity. */
export function createLiveFocusPresentation() {
  let snapshot: AgentFocusResult | null = null;
  const latest = new Map<string, MapPoint>();
  return (focus: AgentFocusResult | null, items: MapResponse['items']) => {
    if (focus !== snapshot) {
      snapshot = focus;
      latest.clear();
    }
    if (!focus) return null;
    const vessels = new Map(
      focus.targets.filter((t) => t.ref.kind === 'vessel').map((t) => [t.ref.id, t]),
    );
    for (const item of items) {
      if (item.kind !== 'point' || !vessels.has(item.mmsi)) continue;
      const observed = Date.parse(item.observedAt);
      const previous = latest.get(item.mmsi)?.observedAt ?? vessels.get(item.mmsi)?.observedAt;
      if (
        !Number.isFinite(observed) ||
        !Number.isFinite(item.lon) ||
        !Number.isFinite(item.lat) ||
        Math.abs(item.lon) > 180 ||
        Math.abs(item.lat) > 90 ||
        (previous && observed <= Date.parse(previous))
      )
        continue;
      latest.set(item.mmsi, item);
    }
    const targets = focus.targets.map((target): FocusTargetSnapshot => {
      const point = target.ref.kind === 'vessel' ? latest.get(target.ref.id) : undefined;
      return point
        ? {
            ...target,
            observedAt: point.observedAt,
            source: point.sourceId,
            geometry: { type: 'Point', coordinates: [point.lon, point.lat] },
          }
        : target;
    });
    return { targets, bbox: focusBounds(targets.map((t) => t.geometry)) };
  };
}

export function createFocusCameraBudget() {
  let taken = false;
  return {
    take() {
      if (taken) return false;
      taken = true;
      return true;
    },
    reset() {
      taken = false;
    },
  };
}
