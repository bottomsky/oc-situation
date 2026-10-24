import type { MapPoint, MapResponse } from '@ais/contracts';
export interface PredictionObservationEvidence {
  mmsi: string;
  occurredAt: string;
  longitude?: number;
  latitude?: number;
  speedOverGround?: number | null;
  courseOverGround?: number | null;
  raw?: unknown;
}
export function predictionInputObservation(
  record: {
    prediction: { mmsi: string; inputWindow: { to: string | null } };
    evidence?: { ais: PredictionObservationEvidence[] };
  },
  fleet: MapResponse['items'] = [],
): MapPoint | null {
  const { mmsi, inputWindow } = record.prediction;
  const time = Date.parse(inputWindow.to ?? '');
  const observation = record.evidence?.ais
    .filter(
      (item) =>
        item.mmsi === mmsi &&
        Date.parse(item.occurredAt) === time &&
        typeof item.longitude === 'number' &&
        Number.isFinite(item.longitude) &&
        Math.abs(item.longitude) <= 180 &&
        typeof item.latitude === 'number' &&
        Number.isFinite(item.latitude) &&
        Math.abs(item.latitude) <= 90,
    )
    .at(-1);
  if (observation) {
    const raw =
      observation.raw && typeof observation.raw === 'object'
        ? (observation.raw as Record<string, unknown>)
        : {};
    return {
      kind: 'point',
      mmsi,
      lon: observation.longitude!,
      lat: observation.latitude!,
      observedAt: observation.occurredAt,
      sourceId: typeof raw.sourceId === 'string' ? raw.sourceId : 'prediction-evidence',
      sogKnots: observation.speedOverGround ?? null,
      cogDegrees: observation.courseOverGround ?? null,
      headingDegrees: typeof raw.headingDegrees === 'number' ? raw.headingDegrees : null,
      quality: Array.isArray(raw.quality)
        ? raw.quality.filter((value): value is string => typeof value === 'string')
        : [],
    };
  }
  return (
    fleet.find((item): item is MapPoint => item.kind === 'point' && item.mmsi === mmsi) ?? null
  );
}
