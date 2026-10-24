import { createHash } from 'node:crypto';
export * from './topics';
export * from './reachability';
export * from './navigation-warning-impact';
export * from './reachability-backtest';
export * from './agent-conversation';
export * from './agent-intents';
import {
  MmsiSchema,
  PartialEtaSchema,
  PositionObservationSchema,
  ReceptionTypeSchema,
  StaticFieldsSchema,
  UtcTimestampSchema,
  type FieldProvenance,
  type PositionObservation,
  type QuarantineObservation,
  type RawEnvelope,
  type SourceKind,
  type StaticFields,
  type StaticObservation,
} from '@ais/contracts';

export const SOURCE_PRIORITIES: Readonly<Record<SourceKind, number>> = {
  marinetraffic: 300,
  aisstream: 200,
  'fixture-http': 100,
  'fixture-browser': 100,
};
export interface PositionCandidate {
  mmsi: unknown;
  observedAt?: unknown;
  lat: unknown;
  lon: unknown;
  sogKnots?: unknown;
  cogDegrees?: unknown;
  headingDegrees?: unknown;
  rotDegPerMinute?: unknown;
  navigationStatus?: unknown;
  receptionType?: unknown;
  providerRecordId?: string;
  nativeObservation?: unknown;
}
export interface StaticCandidate {
  mmsi: unknown;
  observedAt?: unknown;
  fields: Record<string, unknown>;
  providerRecordId?: string;
  nativeObservation?: unknown;
}
export interface StaticFieldState {
  fields: StaticFields;
  provenance: Partial<Record<keyof StaticFields, FieldProvenance>>;
}

export function canonicalJson(input: unknown): string {
  const seen = new WeakSet<object>();
  let count = 0;
  const encode = (value: unknown, depth: number): string => {
    if (++count > 100_000 || depth > 32) throw new Error('Canonical input exceeds safety bounds');
    if (value === null) return 'null';
    if (value === undefined) return '"$undefined"';
    if (typeof value === 'number')
      return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(`$${value}`);
    if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value !== 'object') throw new Error('Canonical input must be JSON');
    if (seen.has(value)) throw new Error('Canonical input contains circular data');
    seen.add(value);
    const output = Array.isArray(value)
      ? `[${value.map((item) => encode(item, depth + 1)).join(',')}]`
      : `{${Object.keys(value)
          .sort()
          .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
          .map(
            (key) =>
              `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], depth + 1)}`,
          )
          .join(',')}}`;
    seen.delete(value);
    return output;
  };
  const result = encode(input, 0);
  if (Buffer.byteLength(result) > 4_194_304) throw new Error('Canonical input exceeds byte bound');
  return result;
}

export function stableEventId(
  sourceId: string,
  kind: 'position' | 'static' | 'quarantine',
  nativeObservation: unknown,
  providerRecordId?: string,
): string {
  const identity = providerRecordId
    ? { sourceId, kind, providerRecordId }
    : { sourceId, kind, nativeObservation };
  return createHash('sha256').update(canonicalJson(identity)).digest('hex');
}
function base(raw: RawEnvelope, eventId: string, observedAt: string | null, quality: string[]) {
  return {
    schemaVersion: 1 as const,
    cleaningVersion: 1 as const,
    eventId,
    captureId: raw.captureId,
    sourceId: raw.sourceId,
    sourceKind: raw.sourceKind,
    sourcePriority: raw.sourcePriority,
    runId: raw.runId,
    observedAt,
    receivedAt: raw.receivedAt,
    quality: [
      ...new Set([
        ...quality,
        ...(raw.sourceKind.startsWith('fixture-') ? ['synthetic'] : []),
        ...(raw.integrity === 'legacy_unverified' ? ['legacy_unverified_raw'] : []),
      ]),
    ],
  };
}
export function normalizeMmsi(value: unknown): string | null {
  const input = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  const parsed = MmsiSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
export function normalizeUtcTimestamp(value: unknown): string | null {
  const parsed = UtcTimestampSchema.safeParse(value);
  return parsed.success ? new Date(parsed.data).toISOString() : null;
}
function timeQuality(
  raw: RawEnvelope,
  observedAt: string | null,
  quality: string[],
  reasons: string[],
) {
  if (observedAt === null) return;
  const age = Date.parse(raw.receivedAt) - Date.parse(observedAt);
  if (age < -300_000) reasons.push('future_observation');
  if (age > 30 * 86_400_000) quality.push('outside_online_retention');
}
function quarantine(
  raw: RawEnvelope,
  eventId: string,
  observedAt: string | null,
  mmsi: string | null,
  reasons: string[],
  quality: string[],
): QuarantineObservation {
  return { ...base(raw, eventId, observedAt, quality), kind: 'quarantine', mmsi, reasons };
}
function eventIdentity(
  raw: RawEnvelope,
  kind: 'position' | 'static',
  candidate: PositionCandidate | StaticCandidate,
): string {
  const { nativeObservation, providerRecordId, ...content } = candidate;
  return stableEventId(raw.sourceId, kind, nativeObservation ?? content, providerRecordId);
}
function optionalNumeric(
  value: unknown,
  field: string,
  min: number,
  max: number,
  sentinels: number[],
  quality: string[],
  reasons: string[],
  integer = false,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reasons.push(`invalid_${field}`);
    return null;
  }
  if (sentinels.includes(value)) {
    quality.push(`unavailable_${field}`);
    return null;
  }
  if (value < min || value > max || (integer && !Number.isInteger(value))) {
    reasons.push(`invalid_${field}`);
    return null;
  }
  return value;
}
export function cleanPosition(
  raw: RawEnvelope,
  candidate: PositionCandidate,
): PositionObservation | QuarantineObservation {
  const quality: string[] = [];
  const reasons: string[] = [];
  let eventId: string;
  try {
    eventId = eventIdentity(raw, 'position', candidate);
  } catch {
    return quarantine(
      raw,
      stableEventId(raw.sourceId, 'quarantine', { captureId: raw.captureId }),
      null,
      normalizeMmsi(candidate.mmsi),
      ['unsafe_candidate'],
      [],
    );
  }
  const mmsi = normalizeMmsi(candidate.mmsi);
  const observedAt = normalizeUtcTimestamp(candidate.observedAt);
  if (mmsi === null) reasons.push('invalid_mmsi');
  if (observedAt === null) reasons.push('invalid_observed_at');
  timeQuality(raw, observedAt, quality, reasons);
  if (
    typeof candidate.lat !== 'number' ||
    !Number.isFinite(candidate.lat) ||
    candidate.lat < -90 ||
    candidate.lat > 90
  )
    reasons.push('invalid_lat');
  if (
    typeof candidate.lon !== 'number' ||
    !Number.isFinite(candidate.lon) ||
    candidate.lon < -180 ||
    candidate.lon > 180
  )
    reasons.push('invalid_lon');
  const sogKnots = optionalNumeric(
    candidate.sogKnots,
    'sog',
    0,
    102.2,
    [102.3, 1023],
    quality,
    reasons,
  );
  const cogDegrees = optionalNumeric(
    candidate.cogDegrees,
    'cog',
    0,
    359.999999,
    [360, 3600],
    quality,
    reasons,
  );
  const headingDegrees = optionalNumeric(
    candidate.headingDegrees,
    'heading',
    0,
    359.999999,
    [511],
    quality,
    reasons,
  );
  const rotDegPerMinute = optionalNumeric(
    candidate.rotDegPerMinute,
    'rot',
    -720,
    720,
    [-128],
    quality,
    reasons,
  );
  const navigationStatus = optionalNumeric(
    candidate.navigationStatus,
    'navigation_status',
    0,
    14,
    [15],
    quality,
    reasons,
    true,
  );
  const reception = ReceptionTypeSchema.safeParse(candidate.receptionType ?? 'UNKNOWN');
  if (!reception.success) reasons.push('invalid_reception_type');
  if (candidate.lat === 0 && candidate.lon === 0) quality.push('null_island');
  if (reasons.length || mmsi === null || observedAt === null || !reception.success)
    return quarantine(raw, eventId, observedAt, mmsi, reasons, quality);
  return PositionObservationSchema.parse({
    ...base(raw, eventId, observedAt, quality),
    kind: 'position',
    mmsi,
    lat: candidate.lat,
    lon: candidate.lon,
    sogKnots,
    cogDegrees,
    headingDegrees,
    rotDegPerMinute,
    navigationStatus,
    receptionType: reception.data,
  });
}

export function trimAisText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.trim().replace(/@+$/, '').trim() || null;
}
export function cleanStatic(
  raw: RawEnvelope,
  candidate: StaticCandidate,
): StaticObservation | QuarantineObservation {
  const quality: string[] = [];
  const reasons: string[] = [];
  let eventId: string;
  try {
    eventId = eventIdentity(raw, 'static', candidate);
  } catch {
    return quarantine(
      raw,
      stableEventId(raw.sourceId, 'quarantine', { captureId: raw.captureId }),
      null,
      normalizeMmsi(candidate.mmsi),
      ['unsafe_candidate'],
      [],
    );
  }
  const mmsi = normalizeMmsi(candidate.mmsi);
  const observedAt = normalizeUtcTimestamp(candidate.observedAt);
  if (mmsi === null) reasons.push('invalid_mmsi');
  if (candidate.observedAt !== undefined && candidate.observedAt !== null && observedAt === null)
    reasons.push('invalid_observed_at');
  if (candidate.observedAt === undefined || candidate.observedAt === null)
    quality.push('unknown_observation_time');
  timeQuality(raw, observedAt, quality, reasons);
  const values: Record<string, unknown> = {};
  const allowed = new Set([
    'name',
    'imo',
    'callsign',
    'shipType',
    'length',
    'width',
    'draught',
    'destination',
    'eta',
  ]);
  for (const [key, value] of Object.entries(candidate.fields)) {
    if (!allowed.has(key)) {
      reasons.push(`unknown_static_field_${key}`);
      continue;
    }
    if (value === undefined || value === null) continue;
    if (['name', 'callsign', 'destination'].includes(key)) {
      if (typeof value !== 'string') {
        reasons.push(`invalid_${key}`);
        continue;
      }
      const clean = trimAisText(value);
      if (clean !== null) values[key] = clean;
    } else if (key === 'imo') {
      if (value === 0 || value === '0' || value === '0000000' || value === '') continue;
      values[key] = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
    } else if (key === 'eta') {
      const eta = PartialEtaSchema.safeParse(value);
      if (!eta.success) {
        reasons.push('invalid_eta');
        continue;
      }
      if (Object.keys(eta.data).length) values.eta = eta.data;
      if (eta.data.year === undefined) quality.push('eta_unknown_year');
      if (
        ['month', 'day', 'hour', 'minute'].some(
          (key) => eta.data[key as keyof typeof eta.data] === undefined,
        )
      )
        quality.push('incomplete_eta');
    } else if (value === 0) {
      quality.push(`unavailable_${key}`);
    } else values[key] = value;
  }
  const fields = StaticFieldsSchema.safeParse(values);
  if (!fields.success) reasons.push('invalid_static_fields');
  if (reasons.length || mmsi === null || !fields.success)
    return quarantine(raw, eventId, observedAt, mmsi, reasons, quality);
  return { ...base(raw, eventId, observedAt, quality), kind: 'static', mmsi, fields: fields.data };
}

export function comparePosition(a: PositionObservation, b: PositionObservation): number {
  return (
    Date.parse(a.observedAt) - Date.parse(b.observedAt) ||
    a.sourcePriority - b.sourcePriority ||
    a.eventId.localeCompare(b.eventId)
  );
}
export function isNewerPosition(
  incoming: PositionObservation,
  current: PositionObservation | null,
): boolean {
  return (
    current === null || (incoming.mmsi === current.mmsi && comparePosition(incoming, current) > 0)
  );
}
export function selectLatestPositions(
  batch: readonly PositionObservation[],
): PositionObservation[] {
  const latest = new Map<string, PositionObservation>();
  for (const observation of batch) {
    const previous = latest.get(observation.mmsi) ?? null;
    if (isNewerPosition(observation, previous)) latest.set(observation.mmsi, observation);
  }
  return [...latest.values()].sort((a, b) => a.mmsi.localeCompare(b.mmsi));
}
export function compareStaticProvenance(a: FieldProvenance, b: FieldProvenance): number {
  if (a.observedAt !== null && b.observedAt === null) return 1;
  if (a.observedAt === null && b.observedAt !== null) return -1;
  return (
    (a.observedAt === null || b.observedAt === null
      ? 0
      : Date.parse(a.observedAt) - Date.parse(b.observedAt)) ||
    a.sourcePriority - b.sourcePriority ||
    a.eventId.localeCompare(b.eventId)
  );
}
export function mergeStaticFields(
  current: StaticFieldState,
  incoming: StaticObservation,
): StaticFieldState {
  const fields = { ...current.fields };
  const provenance = { ...current.provenance };
  const next: FieldProvenance = {
    sourceId: incoming.sourceId,
    sourceKind: incoming.sourceKind,
    sourcePriority: incoming.sourcePriority,
    eventId: incoming.eventId,
    observedAt: incoming.observedAt,
    receivedAt: incoming.receivedAt,
  };
  for (const key of Object.keys(incoming.fields) as (keyof StaticFields)[]) {
    const value = incoming.fields[key];
    const previous = provenance[key];
    if (value === undefined || (previous && compareStaticProvenance(next, previous) <= 0)) continue;
    Object.assign(fields, { [key]: value });
    provenance[key] = next;
  }
  return { fields, provenance };
}
export function flagPositionJump(
  previous: PositionObservation | null,
  incoming: PositionObservation,
  maxKnots = 100,
): PositionObservation {
  if (!previous || previous.mmsi !== incoming.mmsi) return incoming;
  const hours = (Date.parse(incoming.observedAt) - Date.parse(previous.observedAt)) / 3_600_000;
  if (hours <= 0) return incoming;
  const radians = (degree: number) => (degree * Math.PI) / 180;
  const a =
    Math.sin(radians(incoming.lat - previous.lat) / 2) ** 2 +
    Math.cos(radians(previous.lat)) *
      Math.cos(radians(incoming.lat)) *
      Math.sin(radians(incoming.lon - previous.lon) / 2) ** 2;
  const distanceNm = 3440.065 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
  return distanceNm / hours > maxKnots
    ? { ...incoming, quality: [...new Set([...incoming.quality, 'implausible_jump'])] }
    : incoming;
}
export * from './agent-focus';
