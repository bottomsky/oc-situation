import type { MapResponse } from '@ais/contracts';
import type { GeoJSONSourceDiff } from 'maplibre-gl';
import { vesselMarkerProperties } from './vesselMarkers';
type Update =
  | { kind: 'replace'; data: GeoJSON.FeatureCollection<GeoJSON.Point> }
  | { kind: 'delta'; diff: GeoJSONSourceDiff };
/** Stable feature IDs retain every identity while unchanged snapshots avoid worker/tile rebuilds. */
export function createVesselPointRenderer() {
  let signatures = new Map<string, string>();
  let initialized = false;
  return {
    reset() {
      signatures.clear();
      initialized = false;
    },
    update(items: MapResponse['items'], now = Date.now()): Update | null {
      const next = new Map<string, string>();
      const add: GeoJSON.Feature<GeoJSON.Point>[] = [];
      const update: NonNullable<GeoJSONSourceDiff['update']> = [];
      for (const item of items) {
        const id = item.kind === 'point' ? `point:${item.mmsi}` : `cluster:${item.clusterId}`;
        const stale = item.kind === 'point' && now - Date.parse(item.observedAt) > 30 * 60000;
        const signature = JSON.stringify(
          item.kind === 'point'
            ? [
                item.mmsi,
                item.lon,
                item.lat,
                item.observedAt,
                item.sourceId,
                item.sogKnots,
                item.cogDegrees,
                item.headingDegrees,
                item.quality,
                stale,
              ]
            : [item.clusterId, item.lon, item.lat, item.count, item.bbox],
        );
        next.set(id, signature);
        if (signatures.get(id) === signature) continue;
        const properties = {
          ...item,
          label: item.kind === 'point' ? item.mmsi : String(item.count),
          sample: item.kind === 'point' && item.quality.includes('synthetic'),
          stale,
          ...(item.kind === 'point' ? vesselMarkerProperties(item) : {}),
        };
        const geometry: GeoJSON.Point = { type: 'Point', coordinates: [item.lon, item.lat] };
        if (!signatures.has(id)) add.push({ type: 'Feature', id, properties, geometry });
        else
          update.push({
            id,
            newGeometry: geometry,
            addOrUpdateProperties: Object.entries(properties).map(([key, value]) => ({
              key,
              value,
            })),
          });
      }
      const remove = [...signatures.keys()].filter((id) => !next.has(id));
      signatures = next;
      if (!initialized) {
        initialized = true;
        return { kind: 'replace', data: { type: 'FeatureCollection', features: add } };
      }
      if (!add.length && !update.length && !remove.length) return null;
      return { kind: 'delta', diff: { add, update, remove } };
    },
  };
}
