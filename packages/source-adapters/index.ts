import { parseRawEnvelope, type NormalizedObservation, type RawEnvelope } from '@ais/contracts';
import { cleanPosition, cleanStatic, stableEventId, normalizeUtcTimestamp } from '@ais/domain';
import { load } from 'cheerio';

type Row = Record<string, unknown>;
const row = (value: unknown): Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {};
const number = (value: unknown): number | undefined =>
  value === undefined || value === null || value === ''
    ? undefined
    : typeof value === 'number'
      ? value
      : typeof value === 'string' && Number.isFinite(Number(value))
        ? Number(value)
        : undefined;
const divided = (value: unknown, scale: number) =>
  number(value) === undefined ? undefined : number(value)! / scale;

function fullTime(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const go = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? \+0000 UTC$/.exec(value);
  const normalized = go ? `${go[1]}T${go[2]}.${(go[3] ?? '').padEnd(3, '0').slice(0, 3)}Z` : value;
  return normalizeUtcTimestamp(normalized) ?? undefined;
}

function quarantine(raw: RawEnvelope, native: unknown, reason: string): NormalizedObservation {
  return {
    schemaVersion: 1,
    cleaningVersion: 1,
    eventId: stableEventId(raw.sourceId, 'quarantine', native),
    captureId: raw.captureId,
    sourceId: raw.sourceId,
    sourceKind: raw.sourceKind,
    sourcePriority: raw.sourcePriority,
    runId: raw.runId,
    receivedAt: raw.receivedAt,
    observedAt: null,
    mmsi: null,
    kind: 'quarantine',
    reasons: [reason],
    quality: raw.sourceKind.startsWith('fixture-') ? ['synthetic'] : [],
  };
}

function aisStaticFields(value: Row): Row {
  const dimensions = row(value.Dimension);
  const eta = row(value.Eta);
  const partialEta: Row = {};
  for (const [native, canonical] of [
    ['Month', 'month'],
    ['Day', 'day'],
    ['Hour', 'hour'],
    ['Minute', 'minute'],
  ] as const) {
    const n = number(eta[native]);
    if (
      n !== undefined &&
      !(n === 0 && (native === 'Month' || native === 'Day')) &&
      !(n === 24 && native === 'Hour') &&
      !(n === 60 && native === 'Minute')
    )
      partialEta[canonical] = n;
  }
  const sum = (a: unknown, b: unknown) =>
    number(a) === undefined || number(b) === undefined ? undefined : number(a)! + number(b)!;
  return {
    name: value.Name,
    callsign: value.CallSign,
    imo: value.ImoNumber,
    shipType: number(value.Type ?? value.ShipType),
    length: sum(dimensions.A, dimensions.B),
    width: sum(dimensions.C, dimensions.D),
    draught: number(value.MaximumStaticDraught),
    destination: value.Destination,
    eta: Object.keys(partialEta).length ? partialEta : undefined,
  };
}

function aisStream(raw: RawEnvelope, payload: unknown): NormalizedObservation[] {
  const frame = row(payload);
  const type = frame.MessageType;
  const metadata = row(frame.MetaData);
  if (type === 'SubscriptionConfirmation') return [];
  const message = row(row(frame.Message)[String(type)]);
  const mmsi = message.UserID ?? metadata.MMSI;
  const observedAt = fullTime(metadata.time_utc);
  const nativeObservation = { type, metadata, message };
  if (
    ['PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport'].includes(
      String(type),
    )
  ) {
    const encoded = number(message.RateOfTurn);
    const rot =
      encoded === undefined || [-128, -127, 127].includes(encoded)
        ? null
        : Math.sign(encoded) * (Math.abs(encoded) / 4.733) ** 2;
    const position = cleanPosition(raw, {
      mmsi,
      observedAt,
      lat: number(message.Latitude),
      lon: number(message.Longitude),
      sogKnots: number(message.Sog),
      cogDegrees: number(message.Cog),
      headingDegrees: number(message.TrueHeading),
      rotDegPerMinute: rot,
      navigationStatus: number(message.NavigationalStatus),
      nativeObservation,
    });
    if (encoded === 127) position.quality.push('rot_right_over_range');
    if (encoded === -127) position.quality.push('rot_left_over_range');
    if (encoded === -128) position.quality.push('unavailable_rot');
    const result: NormalizedObservation[] = [position];
    if (type === 'ExtendedClassBPositionReport')
      result.push(
        cleanStatic(raw, { mmsi, observedAt, fields: aisStaticFields(message), nativeObservation }),
      );
    return result;
  }
  if (type === 'ShipStaticData')
    return [
      cleanStatic(raw, { mmsi, observedAt, fields: aisStaticFields(message), nativeObservation }),
    ];
  if (type === 'StaticDataReport') {
    const report = number(message.PartNumber) === 0 ? row(message.ReportA) : row(message.ReportB);
    return [
      cleanStatic(raw, { mmsi, observedAt, fields: aisStaticFields(report), nativeObservation }),
    ];
  }
  return [quarantine(raw, frame, 'unsupported_ais_message')];
}

function marineTraffic(raw: RawEnvelope, payload: unknown): NormalizedObservation[] {
  const envelope = row(payload);
  const validShape = Array.isArray(payload) || Array.isArray(envelope.DATA);
  if (!validShape) return [quarantine(raw, envelope, 'missing_marinetraffic_data')];
  const rows = Array.isArray(payload) ? payload : Array.isArray(envelope.DATA) ? envelope.DATA : [];
  if (rows.length > 5000) return [quarantine(raw, { count: rows.length }, 'page_row_limit')];
  const result: NormalizedObservation[] = [];
  for (const item of rows) {
    const data = row(item);
    const observedAt = fullTime(data.TIMESTAMP);
    const position = cleanPosition(raw, {
        mmsi: data.MMSI,
        observedAt,
        lat: number(data.LAT),
        lon: number(data.LON),
        sogKnots: divided(data.SPEED, 10),
        cogDegrees: number(data.COURSE),
        headingDegrees: number(data.HEADING) === -1 ? 511 : number(data.HEADING),
        rotDegPerMinute: number(data.ROT) === 0 ? 0 : null,
        navigationStatus: number(data.STATUS),
        receptionType: data.DSRC ?? 'UNKNOWN',
        nativeObservation: data,
      });
    if (number(data.ROT) !== undefined && number(data.ROT) !== 0) position.quality.push('unknown_rot_unit');
    result.push(position);
    const fields = {
      name: data.SHIPNAME,
      imo: data.IMO,
      callsign: data.CALLSIGN,
      shipType: number(data.SHIPTYPE),
      length: number(data.LENGTH),
      width: number(data.WIDTH),
      draught: divided(data.DRAUGHT, 10),
      destination: data.DESTINATION,
      eta: marineTrafficEta(data.ETA),
    };
    if (Object.values(fields).some((v) => v !== undefined && v !== null && v !== ''))
      result.push(
        cleanStatic(raw, { mmsi: data.MMSI, observedAt, fields, nativeObservation: data }),
      );
  }
  return result;
}
function marineTrafficEta(value: unknown): Row | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const complete = fullTime(value);
  if (complete) {
    const date = new Date(complete);
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
  const partial = /^(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(value);
  if (partial) return { month: Number(partial[1]), day: Number(partial[2]), hour: Number(partial[3]), minute: Number(partial[4]) };
  // Preserve a malformed supplied field through domain validation rather than silently dropping it.
  return { invalid: value };
}

function fixture(raw: RawEnvelope, payload: unknown): NormalizedObservation[] {
  let data = payload;
  if (typeof payload === 'string') {
    const $ = load(payload);
    const json = $('script#ais-data[type="application/json"]').first().text();
    if (json) {
      try {
        data = JSON.parse(json);
      } catch {
        return [quarantine(raw, payload, 'invalid_fixture_json')];
      }
    } else {
      const tableRows = $('[data-mmsi]')
        .map((_i, el) => ({
          mmsi: $(el).attr('data-mmsi'),
          lat: $(el).attr('data-lat'),
          lon: $(el).attr('data-lon'),
          observedAt: $(el).attr('data-observed-at'),
        }))
        .get();
      if (!tableRows.length) return [quarantine(raw, payload, 'missing_fixture_data')];
      data = tableRows;
    }
  }
  const envelope = row(data);
  const rows = Array.isArray(data)
    ? data
    : Array.isArray(envelope.data)
      ? envelope.data
      : Array.isArray(envelope.DATA)
        ? envelope.DATA
        : [];
  if (rows.length > 5000) return [quarantine(raw, { count: rows.length }, 'page_row_limit')];
  return rows.flatMap((item) => {
    const value = row(item);
    const observations: NormalizedObservation[] = [
      cleanPosition(raw, {
        mmsi: value.mmsi ?? value.MMSI,
        observedAt: fullTime(value.observedAt ?? value.TIMESTAMP),
        lat: number(value.lat ?? value.LAT),
        lon: number(value.lon ?? value.LON),
        sogKnots: number(value.sogKnots),
        cogDegrees: number(value.cogDegrees),
        headingDegrees: number(value.headingDegrees),
        nativeObservation: value,
      }),
    ];
    if (value.fields)
      observations.push(
        cleanStatic(raw, {
          mmsi: value.mmsi ?? value.MMSI,
          observedAt: fullTime(value.observedAt ?? value.TIMESTAMP),
          fields: row(value.fields),
          nativeObservation: value,
        }),
      );
    return observations.map((observation) => ({
      ...observation,
      quality: [...new Set([...observation.quality, 'synthetic'])],
    }));
  });
}

/** Pure provider mapping. Large objects are resolved by the infrastructure caller. */
export function parseSourcePayload(
  input: RawEnvelope,
  resolvedPayload?: unknown,
): NormalizedObservation[] {
  const raw = parseRawEnvelope(input);
  const payload = raw.payload.kind === 'inline' ? raw.payload.value : resolvedPayload;
  if (payload === undefined) throw new Error('Object payload must be resolved before parsing');
  if (raw.sourceKind === 'aisstream') return aisStream(raw, payload);
  if (raw.sourceKind === 'marinetraffic') return marineTraffic(raw, payload);
  return fixture(raw, payload);
}
