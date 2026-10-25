import type { MapResponse, MapPoint } from '@ais/contracts';
import { situationAgeMinutes } from './maritimeSituation';
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
/** The owner is unset during restoration so synchronous watchers cannot write the old value back. */
export function createChartReportPreference(
  storage: PreferenceStorage,
  apply: (hours: number) => void,
) {
  let owner: string | null = null;
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && situationAgeMinutes(value, 'hours') !== null;
  return {
    restore(user: string | null) {
      owner = null;
      let hours = 24;
      if (user) {
        try {
          const stored: unknown = JSON.parse(
            storage.getItem(preferenceKey(user, 'situation-hours')) ?? 'null',
          );
          if (valid(stored)) hours = stored;
        } catch {
          /* Invalid or unavailable storage keeps the default time range. */
        }
      }
      apply(hours);
      owner = user;
    },
    persist(hours: number) {
      if (!owner) return;
      try {
        storage.setItem(
          preferenceKey(owner, 'situation-hours'),
          JSON.stringify(valid(hours) ? hours : 24),
        );
      } catch {
        /* Storage restrictions retain the selected range for this session. */
      }
    },
  };
}
export function createRequestGeneration() {
  let generation = 0;
  return { next: () => ++generation, isCurrent: (request: number) => request === generation };
}
export function removeManualFocusObject<T extends { kind: string; id: string }>(
  objects: T[],
  removed: { kind: string; id: string },
  invalidate: () => void,
) {
  invalidate();
  return objects.filter((item) => item.kind !== removed.kind || item.id !== removed.id);
}
export function visibleVesselRows(items: MapResponse['items'], names: Map<string, string>) {
  return items
    .filter((item): item is MapPoint => item.kind === 'point')
    .map((item) => ({ ...item, name: names.get(item.mmsi) ?? '' }));
}
export function vesselTablePage<T>(rows: T[], page: number, pageSize = 100) {
  return rows.slice(page * pageSize, (page + 1) * pageSize);
}
