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

/** Historical counts describe a whole cell, not a measured position at its centre. */
export function heatmapGeoJson(
  result: HeatmapResult | null,
): GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon> {
  if (!result) return { type: 'FeatureCollection', features: [] };
  const [west, south, east, north] = result.query.bbox;
  const regions =
    west <= east
      ? [[west, south, east, north]]
      : [
          [west, south, 180, north],
          [-180, south, east, north],
        ];
  const size = result.grid.cellDegrees;
  return {
    type: 'FeatureCollection',
    features: result.cells.flatMap((cell) => {
      const left = -180 + cell.x * size;
      const bottom = -90 + cell.y * size;
      const polygons = regions.flatMap(([w, s, e, n]) => {
        const x0 = Math.max(left, w!),
          x1 = Math.min(left + size, e!);
        const y0 = Math.max(bottom, s!),
          y1 = Math.min(90, bottom + size, n!);
        return x0 < x1 && y0 < y1
          ? [
              [
                [
                  [x0, y0],
                  [x1, y0],
                  [x1, y1],
                  [x0, y1],
                  [x0, y0],
                ],
              ],
            ]
          : [];
      });
      return polygons.length
        ? [
            {
              type: 'Feature' as const,
              id: cell.id,
              properties: { count: cell.vesselCount, cellId: cell.id },
              geometry:
                polygons.length === 1
                  ? { type: 'Polygon' as const, coordinates: polygons[0]! }
                  : { type: 'MultiPolygon' as const, coordinates: polygons },
            },
          ]
        : [];
    }),
  };
}

export function heatmapCellAt(result: HeatmapResult, lon: number, lat: number) {
  const wrap = ((((lon + 180) % 360) + 360) % 360) - 180;
  const feature = heatmapGeoJson(result).features.find(({ geometry }) => {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some(([ring]) => {
      const start = ring![0]!,
        end = ring![2]!;
      return (
        [wrap, ...(wrap === -180 ? [180] : [])].some((x) => x >= start[0]! && x <= end[0]!) &&
        lat >= start[1]! &&
        lat <= end[1]!
      );
    });
  });
  return result.cells.find((cell) => cell.id === feature?.id);
}

export function registerHeatmapLayers(map: {
  getSource(id: string): unknown;
  getLayer(id: string): unknown;
  addSource(id: string, source: GeoJSONSourceSpecification): unknown;
  addLayer(layer: LayerSpecification, before?: string): unknown;
  removeLayer(id: string): unknown;
}) {
  if (map.getLayer('ais-heatmap-cells')) map.removeLayer('ais-heatmap-cells');
  if (!map.getSource('ais-heatmap'))
    map.addSource('ais-heatmap', { type: 'geojson', data: heatmapGeoJson(null) });
  // Replace a restored legacy point-kernel layer with the historical cell footprint.
  const existing = map.getLayer('ais-heatmap') as { type?: string } | undefined;
  if (existing?.type && existing.type !== 'fill') map.removeLayer('ais-heatmap');
  if (!map.getLayer('ais-heatmap'))
    map.addLayer(
      {
        id: 'ais-heatmap',
        type: 'fill',
        source: 'ais-heatmap',
        paint: {
          'fill-color': [
            'interpolate',
            ['linear'],
            ['get', 'count'],
            1,
            '#206ca5',
            10,
            '#23c5bc',
            50,
            '#f2d666',
            100,
            '#e56244',
          ],
          'fill-opacity': 0.45,
          'fill-outline-color': 'rgba(99,184,201,0.25)',
        },
      },
      map.getLayer('grid') ? 'grid' : map.getLayer('vessels') ? 'vessels' : undefined,
    );
}

export function registerCurrentDensityLayer(map: {
  getLayer(id: string): unknown;
  addLayer(layer: LayerSpecification, before?: string): unknown;
}) {
  if (map.getLayer('ais-current-density')) return;
  map.addLayer(
    {
      id: 'ais-current-density',
      type: 'heatmap',
      source: 'vessels',
      filter: ['==', ['get', 'kind'], 'point'],
      layout: { visibility: 'none' },
      paint: {
        'heatmap-weight': 1,
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
    },
    'vessels',
  );
}
