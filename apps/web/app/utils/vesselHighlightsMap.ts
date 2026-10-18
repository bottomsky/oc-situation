import type { LayerSpecification, Map as GLMap } from 'maplibre-gl';
import type { ChartVesselHighlight } from '../types/chart';
import type { ChartBusinessMapPort } from './chartBusinessLayers';
import { createVesselIcon, vesselMarkerProperties, vesselSymbolLayout } from './vesselMarkers';

export function createHighlightTimeline() {
  return new Map<string, number>();
}
export function highlightGeoJson(
  targets: ChartVesselHighlight[],
  timeline: Map<string, number>,
  now: number,
) {
  return {
    type: 'FeatureCollection' as const,
    features: targets.map((target) => {
      const marker = vesselMarkerProperties(target);
      const key = `${target.effectId}:${target.mmsi}`;
      if (!timeline.has(key)) timeline.set(key, now);
      return {
        type: 'Feature' as const,
        id: target.mmsi,
        properties: {
          mmsi: target.mmsi,
          startedAt: timeline.get(key)!,
          ...marker,
          markerIcon: `highlight-vessel-${marker.directionSource === 'unknown' ? 'unknown' : 'direction'}`,
        },
        geometry: { type: 'Point' as const, coordinates: [target.lon, target.lat] },
      };
    }),
  };
}

function exclamationIcon() {
  const width = 40;
  const height = 56;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      if ((x >= 15 && x <= 24 && y >= 4 && y <= 34) || (x >= 15 && x <= 24 && y >= 42 && y <= 51))
        data.set([255, 230, 139, 255], (y * width + x) * 4);
    }
  return { width, height, data };
}
export function registerVesselHighlightLayers(map: ChartBusinessMapPort) {
  if (!map.getSource('vessel-highlights'))
    map.addSource('vessel-highlights', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  for (const unknown of [true, false]) {
    const id = `highlight-vessel-${unknown ? 'unknown' : 'direction'}`;
    if (!map.hasImage(id))
      map.addImage(id, createVesselIcon('#57e9f2', unknown), { pixelRatio: 2 });
  }
  if (!map.hasImage('highlight-alert'))
    map.addImage('highlight-alert', exclamationIcon(), { pixelRatio: 2 });
  const layers: LayerSpecification[] = [
    {
      id: 'vessel-highlight-glow',
      type: 'circle',
      source: 'vessel-highlights',
      paint: {
        'circle-radius': ['coalesce', ['feature-state', 'radius'], 16],
        'circle-color': '#36d9ef',
        'circle-opacity': 0,
        'circle-stroke-color': '#5ce9f2',
        'circle-stroke-width': ['coalesce', ['feature-state', 'strokeWidth'], 2],
        'circle-stroke-opacity': ['coalesce', ['feature-state', 'strokeOpacity'], 0.65],
      },
    },
    {
      id: 'vessel-highlight-halo',
      type: 'circle',
      source: 'vessel-highlights',
      paint: {
        'circle-radius': 13,
        'circle-color': '#49e9ed',
        'circle-opacity': 0.12,
        'circle-blur': 0.65,
      },
    },
    {
      id: 'vessel-highlight-marker',
      type: 'symbol',
      source: 'vessel-highlights',
      layout: { ...vesselSymbolLayout, 'icon-size': 1.2 },
    },
    {
      id: 'vessel-highlight-alert',
      type: 'symbol',
      source: 'vessel-highlights',
      layout: {
        'icon-image': 'highlight-alert',
        'icon-offset': [0, -26],
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': ['coalesce', ['feature-state', 'alertOpacity'], 0] },
    },
  ];
  for (const layer of layers) if (!map.getLayer(layer.id)) map.addLayer(layer);
}

// One clock drives all rings. Feature state updates paint attributes without
// reloading source tiles (global-state + feature data relayouts in MapLibre 6).
export function createHighlightAnimation(
  map: Pick<GLMap, 'setFeatureState'>,
  frames: { request(callback: FrameRequestCallback): number; cancel(id: number): void },
) {
  let frame: number | undefined;
  let active = false;
  let hidden = false;
  let reduced = false;
  let clock = 0;
  let previous: number | undefined;
  let lastPaint = -Infinity;
  let targets: { mmsi: string; startedAt: number }[] = [];
  const duration = 2200;
  const animating = () => targets.some((target) => clock - target.startedAt < duration);
  const paint = () => {
    for (const target of targets) {
      const elapsed = Math.max(0, clock - target.startedAt);
      const initial = !reduced && elapsed < duration;
      const contracting = initial && elapsed < 400;
      const phase = ((elapsed - 400) % 600) / 600;
      map.setFeatureState(
        { source: 'vessel-highlights', id: target.mmsi },
        {
          radius: contracting ? 16 + 26 * (1 - elapsed / 400) ** 2 : 16,
          strokeWidth: initial ? 3 : 2,
          strokeOpacity: !initial ? 0.65 : contracting ? 0.95 : phase < 0.5 ? 0.95 : 0.18,
          alertOpacity: initial && (contracting || phase < 0.5) ? 1 : 0,
        },
      );
    }
  };
  const schedule = () => {
    if (active && !hidden && !reduced && animating() && frame === undefined)
      frame = frames.request(tick);
  };
  const tick = (now: number) => {
    frame = undefined;
    if (!active || hidden || reduced) return;
    if (previous !== undefined) clock += now - previous;
    previous = now;
    if (clock - lastPaint >= 1000 / 30 || !animating()) {
      paint();
      lastPaint = clock;
    }
    schedule();
    if (frame === undefined) previous = undefined;
  };
  return {
    now: () => clock,
    targets(next: { mmsi: string; startedAt: number }[]) {
      if (
        next.some(
          (candidate) =>
            !targets.some(
              (target) =>
                target.mmsi === candidate.mmsi && target.startedAt === candidate.startedAt,
            ),
        )
      )
        lastPaint = -Infinity;
      targets = next;
      if (reduced || !animating()) paint();
      schedule();
    },
    update(next: { active: boolean; hidden: boolean; reduced: boolean }) {
      active = next.active;
      hidden = next.hidden;
      reduced = next.reduced;
      if (reduced) paint();
      if (!active || hidden || reduced) {
        if (frame !== undefined) frames.cancel(frame);
        frame = undefined;
        previous = undefined;
      }
      schedule();
    },
    dispose() {
      active = false;
      if (frame !== undefined) frames.cancel(frame);
      frame = undefined;
      targets = [];
    },
  };
}
