import type { Bbox } from '@ais/contracts';
export interface TrackPoint {
  lon: number;
  lat: number;
  observedAt: string;
  sogKnots?: number | null;
  cogDegrees?: number | null;
}
export function queryRegionGeoJson(bbox: Bbox | null): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  if (!bbox) return { type: 'FeatureCollection', features: [] };
  const [w, s, e, n] = bbox;
  const parts =
    w > e
      ? [
          [w, s, 180, n],
          [-180, s, e, n],
        ]
      : [bbox];
  return {
    type: 'FeatureCollection',
    features: parts.map(([west, south, east, north]) => ({
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [west!, south!],
            [east!, south!],
            [east!, north!],
            [west!, north!],
            [west!, south!],
          ],
        ],
      },
    })),
  };
}
export function distanceNm(a: number[], b: number[]) {
  const rad = Math.PI / 180;
  const dlat = (b[1]! - a[1]!) * rad;
  const dlon = (b[0]! - a[0]!) * rad;
  return (
    3440.065 *
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dlat / 2) ** 2 +
            Math.cos(a[1]! * rad) * Math.cos(b[1]! * rad) * Math.sin(dlon / 2) ** 2,
        ),
      ),
    )
  );
}
export function splitTrackPoints<T extends TrackPoint>(points: T[], gapMinutes = 30): T[][] {
  const parts: T[][] = [];
  let current: T[] = [];
  for (const point of points) {
    const previous = current.at(-1);
    if (
      previous &&
      (Math.abs(point.lon - previous.lon) > 180 ||
        Date.parse(point.observedAt) - Date.parse(previous.observedAt) > gapMinutes * 60000)
    ) {
      parts.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length) parts.push(current);
  return parts;
}
export function trackPresentation(
  tracks: { mmsi: string; points: TrackPoint[] }[],
  mode: 'time' | 'speed' = 'time',
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  for (const track of tracks) {
    const start = Date.parse(track.points[0]?.observedAt ?? '');
    const span = Math.max(1, Date.parse(track.points.at(-1)?.observedAt ?? '') - start);
    for (const part of splitTrackPoints(track.points)) {
      for (let i = 0; i < part.length; i++) {
        const p = part[i]!,
          previous = part[i - 1];
        const progress = (Date.parse(p.observedAt) - start) / span;
        const t = mode === 'speed' ? Math.min(1, (p.sogKnots ?? 0) / 25) : progress;
        const color = `rgb(${Math.round(65 + 20 * t)}, ${Math.round(110 + 120 * t)}, ${Math.round(155 + 85 * t)})`;
        const properties = {
          mmsi: track.mmsi,
          observedAt: p.observedAt,
          sogKnots: p.sogKnots ?? null,
          color,
          progress,
        };
        if (previous)
          features.push({
            type: 'Feature',
            properties,
            geometry: {
              type: 'LineString',
              coordinates: [
                [previous.lon, previous.lat],
                [p.lon, p.lat],
              ],
            },
          });
        const role =
          i === 0
            ? 'start'
            : i === part.length - 1
              ? 'end'
              : (p.sogKnots ?? 100) < 0.5
                ? 'stop'
                : typeof p.cogDegrees === 'number' &&
                    typeof previous?.cogDegrees === 'number' &&
                    Math.abs(((p.cogDegrees - previous.cogDegrees + 540) % 360) - 180) > 35
                  ? 'turn'
                  : null;
        if (role)
          features.push({
            type: 'Feature',
            properties: { ...properties, role },
            geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
          });
      }
      if (part.length > 1)
        features.push({
          type: 'Feature',
          properties: { mmsi: track.mmsi, kind: 'direction' },
          geometry: { type: 'LineString', coordinates: part.map((p) => [p.lon, p.lat]) },
        });
    }
  }
  return { type: 'FeatureCollection', features };
}
export function graticule(bbox: Bbox, zoom: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const step = zoom >= 10 ? 0.1 : zoom >= 7 ? 1 : zoom >= 4 ? 5 : 30;
  const [w, s, e, n] = bbox;
  const east = e < w ? e + 360 : e;
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  for (let lon = Math.ceil(w / step) * step; lon <= east && features.length < 250; lon += step)
    features.push({
      type: 'Feature',
      properties: { label: `${((lon + 540) % 360) - 180}°` },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lon, s],
          [lon, n],
        ],
      },
    });
  for (let lat = Math.ceil(s / step) * step; lat <= n && features.length < 500; lat += step)
    features.push({
      type: 'Feature',
      properties: { label: `${lat}°` },
      geometry: {
        type: 'LineString',
        coordinates: [
          [w, lat],
          [east, lat],
        ],
      },
    });
  return { type: 'FeatureCollection', features };
}
