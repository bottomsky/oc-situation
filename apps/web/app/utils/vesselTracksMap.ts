import type { VesselTracksResult } from '@ais/contracts';
import type { GeoJSONSourceSpecification, LayerSpecification } from 'maplibre-gl';

export function vesselTracksGeoJson(
  result: VesselTracksResult | null,
): GeoJSON.FeatureCollection<GeoJSON.Point | GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.Point | GeoJSON.LineString>[] = [];
  for (const track of result?.tracks ?? []) {
    let part = 0;
    for (const segment of track.segments) {
      let coordinates: number[][] = [];
      const flush = () => {
        if (!coordinates.length) return;
        features.push({
          type: 'Feature',
          id: `${track.mmsi}:${part++}`,
          properties: {
            mmsi: track.mmsi,
            name: track.name ?? '',
            color: vesselTrackColor(track.mmsi),
          },
          geometry:
            coordinates.length === 1
              ? { type: 'Point', coordinates: coordinates[0]! }
              : { type: 'LineString', coordinates },
        });
        coordinates = [];
      };
      for (const point of segment.points) {
        if (coordinates.length && Math.abs(point.lon - coordinates.at(-1)![0]!) > 180) flush();
        coordinates.push([point.lon, point.lat]);
      }
      flush();
    }
  }
  return { type: 'FeatureCollection', features };
}

function vesselTrackColor(mmsi: string) {
  const colors = ['#66d9e8', '#b5a3ff', '#e9c46a', '#8bdb9c', '#f6a4c2', '#85b7ff'];
  const hash = [...mmsi].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
  return colors[hash % colors.length]!;
}
export function registerVesselTracksLayers(map: {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: GeoJSONSourceSpecification): unknown;
  addLayer(layer: LayerSpecification): unknown;
}) {
  if (!map.getSource('ais-history-tracks'))
    map.addSource('ais-history-tracks', { type: 'geojson', data: vesselTracksGeoJson(null) });
  if (!map.getLayer('ais-history-tracks'))
    map.addLayer({
      id: 'ais-history-tracks',
      type: 'line',
      source: 'ais-history-tracks',
      filter: [
        'all',
        ['==', ['geometry-type'], 'LineString'],
        ['!=', ['get', 'kind'], 'direction'],
      ],
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': 2, 'line-opacity': 0.8 },
    });
  if (!map.getLayer('ais-history-track-points'))
    map.addLayer({
      id: 'ais-history-track-points',
      type: 'circle',
      source: 'ais-history-tracks',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-color': ['get', 'color'], 'circle-radius': 3, 'circle-opacity': 0.9 },
    });
}
