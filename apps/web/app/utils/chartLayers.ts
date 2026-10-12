import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import type { ChartLayerVisibility } from '../types/chart';

export const chartHomeBounds = [
  [118, 28],
  [128, 41],
] as [[number, number], [number, number]];
export const defaultChartVisibility: ChartLayerVisibility = {
  ais: true,
  tracks: true,
  evidence: true,
};

export function createOfflineChartStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      'local-land': {
        type: 'geojson',
        data: '/maps/ne_110m_land.geojson',
        attribution: 'Natural Earth · Public domain',
      },
    },
    layers: [
      { id: 'local-sea', type: 'background', paint: { 'background-color': '#081d31' } },
      { id: 'local-land', type: 'fill', source: 'local-land', paint: { 'fill-color': '#173745' } },
      {
        id: 'local-coastline',
        type: 'line',
        source: 'local-land',
        paint: { 'line-color': '#357b89', 'line-width': 0.8 },
      },
    ],
  };
}
export function createChartMapScheduling(
  callbacks: { resize(): void; viewport(): void },
  frames: { request(callback: FrameRequestCallback): number; cancel(id: number): void },
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame: number | undefined;
  let disposed = false;
  return {
    resize() {
      if (disposed || frame !== undefined) return;
      frame = frames.request(() => {
        frame = undefined;
        if (!disposed) callbacks.resize();
      });
    },
    viewport() {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (!disposed) callbacks.viewport();
      }, 150);
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      if (frame !== undefined) frames.cancel(frame);
      timer = undefined;
      frame = undefined;
    },
  };
}

export interface ChartMapPort {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: SourceSpecification): unknown;
  addLayer(layer: LayerSpecification, before?: string): unknown;
  setLayoutProperty(id: string, name: string, value: unknown): unknown;
}

const businessLayers = {
  ais: ['vessels', 'clusters'],
  tracks: ['tracks', 'frame'],
  evidence: ['evidence-region-fill', 'evidence-region-line', 'evidence-tracks', 'evidence-points'],
} as const;

export function applyChartBusinessVisibility(
  map: Pick<ChartMapPort, 'getLayer' | 'setLayoutProperty'>,
  layers: Partial<ChartLayerVisibility> = {},
) {
  for (const group of Object.keys(businessLayers) as (keyof ChartLayerVisibility)[])
    for (const id of businessLayers[group])
      if (map.getLayer(id))
        map.setLayoutProperty(id, 'visibility', layers[group] === false ? 'none' : 'visible');
}
