import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl';
import type { ChartMapPort } from './chartLayers';
import { createVesselIcon, vesselSymbolLayout } from './vesselMarkers';

export interface ChartBusinessMapPort extends Pick<
  ChartMapPort,
  'getSource' | 'getLayer' | 'addSource' | 'addLayer'
> {
  hasImage(id: string): boolean;
  addImage(
    id: string,
    image: ReturnType<typeof createVesselIcon>,
    options: { pixelRatio: number },
  ): unknown;
}
export function registerChartBusinessLayers(
  map: ChartBusinessMapPort,
  grid: GeoJSONSourceSpecification['data'],
) {
  const addBusinessLayer = (layer: LayerSpecification) => {
    if (!map.getLayer(layer.id)) map.addLayer(layer);
  };
  for (const [category, color] of Object.entries({
    live: '#21dfc8',
    sample: '#c1762a',
    frame: '#d77935',
  })) {
    for (const unknown of [false, true])
      if (!map.hasImage(`vessel-${category}-${unknown ? 'unknown' : 'direction'}`))
        map.addImage(
          `vessel-${category}-${unknown ? 'unknown' : 'direction'}`,
          createVesselIcon(color, unknown),
          { pixelRatio: 2 },
        );
  }
  if (!map.getSource('grid')) map.addSource('grid', { type: 'geojson', data: grid });
  addBusinessLayer({
    id: 'grid',
    type: 'line',
    source: 'grid',
    paint: { 'line-color': '#1d5268', 'line-width': 0.6 },
  });
  for (const id of [
    'vessels',
    'track',
    'frame',
    'evidence-points',
    'evidence-track',
    'evidence-region',
  ])
    if (!map.getSource(id))
      map.addSource(id, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  addBusinessLayer({
    id: 'evidence-region-fill',
    type: 'fill',
    source: 'evidence-region',
    paint: { 'fill-color': '#c1762a', 'fill-opacity': 0.15 },
  });
  addBusinessLayer({
    id: 'evidence-region-line',
    type: 'line',
    source: 'evidence-region',
    paint: { 'line-color': '#b06b25', 'line-width': 2, 'line-dasharray': [3, 2] },
  });
  addBusinessLayer({
    id: 'tracks',
    type: 'line',
    source: 'track',
    paint: { 'line-color': '#d77935', 'line-width': 3 },
  });
  addBusinessLayer({
    id: 'clusters',
    type: 'circle',
    source: 'vessels',
    filter: ['==', ['get', 'kind'], 'cluster'],
    paint: {
      'circle-color': ['case', ['==', ['get', 'sample'], true], '#c1762a', '#21dfc8'],
      'circle-radius': 10,
      'circle-stroke-color': '#fff',
      'circle-stroke-width': 2,
    },
  });
  addBusinessLayer({
    id: 'vessels',
    type: 'symbol',
    source: 'vessels',
    filter: ['==', ['get', 'kind'], 'point'],
    layout: vesselSymbolLayout,
  });
  addBusinessLayer({
    id: 'frame',
    type: 'symbol',
    source: 'frame',
    layout: { ...vesselSymbolLayout, 'icon-size': 1.3 },
  });
  addBusinessLayer({
    id: 'evidence-tracks',
    type: 'line',
    source: 'evidence-track',
    paint: { 'line-color': '#ba4a43', 'line-width': 3 },
  });
  addBusinessLayer({
    id: 'evidence-points',
    type: 'circle',
    source: 'evidence-points',
    paint: {
      'circle-color': '#ba4a43',
      'circle-radius': 6,
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2,
    },
  });
}
