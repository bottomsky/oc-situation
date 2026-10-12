import type { Map as GLMap, FilterSpecification } from 'maplibre-gl';
export function intelligenceFeatureGroup(properties: {
  reviewStatus: string;
  kind: string;
  eventReviewStatus?: string;
}): string {
  return properties.reviewStatus === 'candidate' || properties.eventReviewStatus === 'candidate'
    ? 'candidate'
    : properties.kind === 'impacts'
      ? 'impact'
      : properties.kind === 'occurs-at'
        ? 'location'
        : 'object';
}
export function intelligenceFeatureBounds(
  features: { geometry: { coordinates: unknown } }[],
): [[number, number], [number, number]] | null {
  const points: number[][] = [];
  function visit(value: unknown) {
    if (!Array.isArray(value)) return;
    if (typeof value[0] === 'number' && typeof value[1] === 'number') {
      points.push(value as number[]);
      return;
    }
    for (const child of value) visit(child);
  }
  for (const feature of features) visit(feature.geometry.coordinates);
  if (!points.length) return null;
  const longitudes = points.map((p) => ((p[0]! % 360) + 360) % 360).sort((a, b) => a - b);
  let largest = -1;
  let start = longitudes[0]!;
  let end = start;
  for (let i = 0; i < longitudes.length; i++) {
    const current = longitudes[i]!;
    const next = i + 1 < longitudes.length ? longitudes[i + 1]! : longitudes[0]! + 360;
    const gap = next - current;
    if (gap > largest) {
      largest = gap;
      start = next % 360;
      end = current;
      if (end < start) end += 360;
    }
  }
  if (start >= 180) {
    start -= 360;
    end -= 360;
  }
  let south = 90;
  let north = -90;
  for (const p of points) {
    south = Math.min(south, p[1]!);
    north = Math.max(north, p[1]!);
  }
  return [
    [start, south],
    [end, north],
  ];
}
export const intelligenceLayerIds: string[] = [];
export function registerIntelligenceLayers(map: GLMap) {
  if (map.getSource('intelligence')) return;
  map.addSource('intelligence-objects', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  map.addLayer({
    id: 'intelligence-object-directory-fill',
    type: 'fill',
    source: 'intelligence-objects',
    filter: ['==', ['geometry-type'], 'Polygon'],
    paint: { 'fill-color': '#426a84', 'fill-opacity': 0.08 },
  });
  map.addLayer({
    id: 'intelligence-object-directory-line',
    type: 'line',
    source: 'intelligence-objects',
    filter: ['!=', ['geometry-type'], 'Point'],
    paint: { 'line-color': '#688ea5', 'line-width': 1, 'line-dasharray': [2, 3] },
  });
  map.addLayer({
    id: 'intelligence-object-directory-point',
    type: 'circle',
    source: 'intelligence-objects',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: {
      'circle-color': '#789fb9',
      'circle-radius': 4,
      'circle-stroke-color': '#112e40',
      'circle-stroke-width': 1,
    },
  });
  map.addSource('intelligence', {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });
  for (const [group, color] of [
    ['location', '#50d4df'],
    ['object', '#89b9f8'],
    ['impact', '#ff846d'],
    ['candidate', '#e5ba65'],
  ] as const) {
    const filter: FilterSpecification = ['==', ['get', 'group'], group];
    const fill = 'intelligence-' + group + '-fill';
    const line = 'intelligence-' + group + '-line';
    const point = 'intelligence-' + group + '-point';
    intelligenceLayerIds.push(fill, line, point);
    map.addLayer({
      id: fill,
      type: 'fill',
      source: 'intelligence',
      filter: ['all', filter, ['==', ['geometry-type'], 'Polygon']],
      paint: {
        'fill-color': color,
        'fill-opacity': [
          'case',
          ['boolean', ['get', 'historical'], false],
          0.06,
          ['boolean', ['get', 'active'], false],
          0.34,
          0.14,
        ],
      },
    });
    map.addLayer({
      id: line,
      type: 'line',
      source: 'intelligence',
      filter: ['all', filter, ['!=', ['geometry-type'], 'Point']],
      paint: {
        'line-color': color,
        'line-width': ['case', ['boolean', ['get', 'active'], false], 4, 2],
        'line-dasharray': [
          'case',
          ['boolean', ['get', 'historical'], false],
          ['literal', [2, 4]],
          ['literal', group === 'candidate' ? [2, 3] : [1, 0]],
        ],
        'line-opacity': ['case', ['boolean', ['get', 'historical'], false], 0.5, 1],
      },
    });
    map.addLayer({
      id: point,
      type: 'circle',
      source: 'intelligence',
      filter: ['all', filter, ['==', ['geometry-type'], 'Point']],
      paint: {
        'circle-color': color,
        'circle-opacity': ['case', ['boolean', ['get', 'historical'], false], 0.4, 1],
        'circle-radius': ['case', ['boolean', ['get', 'active'], false], 10, 6],
        'circle-stroke-width': group === 'candidate' ? 1 : 3,
        'circle-stroke-color': '#092239',
      },
    });
  }
}
