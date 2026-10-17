import type { HeatmapResult, Bbox } from '@ais/contracts';
import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl';

export function heatmapViewportBounds(
  west: number,
  south: number,
  east: number,
  north: number,
): Bbox {
  const wrap = (value: number) => ((((value + 180) % 360) + 360) % 360) - 180;
  return east - west >= 360 - 1e-8
    ? [-180, Math.max(-90, south), 180, Math.min(90, north)]
    : [wrap(west), Math.max(-90, south), wrap(east), Math.min(90, north)];
}

export function heatmapGeoJson(
  result: HeatmapResult | null,
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  return {
    type: 'FeatureCollection',
    features: (result?.cells ?? []).map((cell) => ({
      type: 'Feature',
      id: cell.id,
      properties: { count: cell.vesselCount, cellId: cell.id },
      geometry: { type: 'Point', coordinates: [cell.lon, cell.lat] },
    })),
  };
}
export function registerHeatmapLayers(map: {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: GeoJSONSourceSpecification): unknown;
  addLayer(layer: LayerSpecification): unknown;
  removeLayer(id: string): unknown;
}) {
  // A restored style may still contain the former grid-centre markers.
  if (map.getLayer('ais-heatmap-cells')) map.removeLayer('ais-heatmap-cells');
  if (!map.getSource('ais-heatmap'))
    map.addSource('ais-heatmap', { type: 'geojson', data: heatmapGeoJson(null) });
  if (!map.getLayer('ais-heatmap'))
    map.addLayer({
      id: 'ais-heatmap',
      type: 'heatmap',
      source: 'ais-heatmap',
      paint: {
        'heatmap-weight': ['get', 'count'],
        'heatmap-intensity': 0.6,
        'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 0, 16, 5, 28, 10, 40, 14, 48],
        'heatmap-opacity': 0.65,
        'heatmap-color': [
          'interpolate',
          ['linear'],
          ['heatmap-density'],
          0,
          'rgba(0,0,0,0)',
          0.2,
          '#206ca5',
          0.45,
          '#23c5bc',
          0.7,
          '#f2d666',
          1,
          '#e56244',
        ],
      },
    });
}
