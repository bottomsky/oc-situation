import type { MapResponse, MapPoint } from '@ais/contracts';
interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
const preferenceKey = (user: string, panel: string) =>
  `ais:chart:${encodeURIComponent(user)}:${panel}`;
export function readChartPreference(
  storage: PreferenceStorage,
  user: string,
  panel: string,
  fallback: boolean,
) {
  try {
    const value = JSON.parse(storage.getItem(preferenceKey(user, panel)) ?? 'null');
    return typeof value === 'boolean' ? value : fallback;
  } catch {
    return fallback;
  }
}
export function writeChartPreference(
  storage: PreferenceStorage,
  user: string,
  panel: string,
  value: boolean,
) {
  try {
    storage.setItem(preferenceKey(user, panel), JSON.stringify(value));
  } catch {
    /* Storage restrictions retain the current session preference. */
  }
}
export function createRequestGeneration() {
  let generation = 0;
  return { next: () => ++generation, isCurrent: (request: number) => request === generation };
}
export function visibleVesselRows(items: MapResponse['items'], names: Map<string, string>) {
  return items
    .filter((item): item is MapPoint => item.kind === 'point')
    .map((item) => ({ ...item, name: names.get(item.mmsi) ?? '' }));
}
