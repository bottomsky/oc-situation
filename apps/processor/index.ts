import { parseRawEnvelope } from '@ais/contracts';
import { parseSourcePayload } from '@ais/source-adapters';
import {
  consume,
  loadRawPayload,
  logger,
  publishNormalized,
  assessPositionQualityBatch,
  assertNormalizedReady,
  recordProcessedCaptures,
  observationCounts,
  DurableBatch,
  type BusMessage,
  type Infrastructure,
} from '@ais/infrastructure';
import { parseRaw, publishObservations } from './process';
export * from './process';
export * from './replay';

export async function runProcessor(
  infra: Infrastructure,
  signal: AbortSignal,
  onProcessed = () => {},
  onFailure = () => {},
): Promise<void> {
  const messages = await consume(infra, 'AIS_RAW', 'cleaner', 50);
  const batch = new DurableBatch<BusMessage>(100,100,async (items) => {
    await assertNormalizedReady(infra);
    const processed: Parameters<typeof recordProcessedCaptures>[1][number][] = [];
    let pending: import('@ais/contracts').NormalizedObservation[] = [];
    const ports = { load: (r: import('@ais/contracts').RawEnvelope) => loadRawPayload(infra,r), parse: parseSourcePayload, publish: (o: import('@ais/contracts').NormalizedObservation) => publishNormalized(infra,o) };
    const flush = async () => {
      if (!pending.length) return;
      const marked = await assessPositionQualityBatch(infra,pending);
      await publishObservations(ports,marked);
      pending=[];
    };
    for (const message of items) {
      const raw = parseRawEnvelope(message.json());
      const observations = await parseRaw(ports,raw);
      if (pending.length + observations.length > 10000) await flush();
      pending.push(...observations);
      processed.push({ sequence: message.seq, runId: raw.runId, counts: observationCounts(observations) });
    }
    await flush();
    await recordProcessedCaptures(infra,processed);
  },(message) => { message.ack(); onProcessed(); },(items,error) => {
    onFailure();
    logger.error({error:error instanceof Error ? error.message : 'Processor failure'},'Raw batch retained for retry');
    for (const message of items) message.nak(30000);
  });
  const stop = () => messages.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      await batch.add(message);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    messages.stop();
    await batch.close();
  }
}
