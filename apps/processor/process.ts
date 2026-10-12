import type { NormalizedObservation, RawEnvelope } from '@ais/contracts';
import { stableEventId } from '@ais/domain';
export interface ProcessorPorts {
  load(raw: RawEnvelope): Promise<unknown>;
  parse(raw: RawEnvelope, payload: unknown): NormalizedObservation[];
  publish(observation: NormalizedObservation): Promise<void>;
  enrich?(observations: readonly NormalizedObservation[]): Promise<NormalizedObservation[]>;
}
export async function parseRaw(
  ports: ProcessorPorts,
  raw: RawEnvelope,
): Promise<NormalizedObservation[]> {
  const payload = await ports.load(raw);
  let observations: NormalizedObservation[];
  try {
    observations = ports.parse(raw, payload);
  } catch {
    observations = [
      {
        schemaVersion: 1,
        cleaningVersion: 1,
        kind: 'quarantine',
        eventId: stableEventId(raw.sourceId, 'quarantine', {
          payload: raw.checksum ?? raw.payload,
          reason: 'adapter_parse_error',
        }),
        captureId: raw.captureId,
        sourceId: raw.sourceId,
        sourceKind: raw.sourceKind,
        sourcePriority: raw.sourcePriority,
        runId: raw.runId,
        receivedAt: raw.receivedAt,
        observedAt: null,
        mmsi: null,
        quality: [...(raw.sourceKind.startsWith('fixture-') ? ['synthetic'] : []), ...(raw.integrity === 'legacy_unverified' ? ['legacy_unverified_raw'] : [])],
        reasons: ['adapter_parse_error'],
      },
    ];
  }
  return observations;
}
export async function publishObservations(ports: ProcessorPorts, observations: readonly NormalizedObservation[]): Promise<void> {
  for (let index = 0; index < observations.length; index += 100)
    await Promise.all(
      observations.slice(index, index + 100).map((observation) => ports.publish(observation)),
    );
}
export async function processRaw(ports: ProcessorPorts, raw: RawEnvelope, ack: () => void): Promise<NormalizedObservation[]> {
  const parsed = await parseRaw(ports,raw);
  const observations = ports.enrich ? await ports.enrich(parsed) : parsed;
  await publishObservations(ports,observations);
  ack();
  return observations;
}
