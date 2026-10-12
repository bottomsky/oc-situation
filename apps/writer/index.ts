import { parseNormalizedObservation, type NormalizedObservation } from '@ais/contracts';
import {
  consume,
  DurableBatch,
  logger,
  saveHistoryBatch,
  saveLatestBatch,
  markFusionWriterReady,
  flushReadyOutbox,
  ensureFusionBus,
  type BusMessage,
  type Infrastructure,
} from '@ais/infrastructure';
export async function runWriter(
  infra: Infrastructure,
  target: 'postgres' | 'clickhouse',
  signal: AbortSignal,
  onProcessed = () => {},
  onFailure = () => {},
): Promise<void> {
  await ensureFusionBus(infra);
  const size = target === 'postgres' ? 1000 : 5000;
  const messages = await consume(infra, 'AIS_NORMALIZED', `${target}-writer`, size);
  let pendingFlush: Promise<unknown> | undefined;
  const outboxTimer = setInterval(() => {
    if (pendingFlush) return;
    pendingFlush = flushReadyOutbox(infra)
      .catch((error) =>
        logger.error(
          { error: error instanceof Error ? error.message : 'Outbox publication failed' },
          'Fusion outbox retry pending',
        ),
      )
      .finally(() => {
        pendingFlush = undefined;
      });
  }, 2000);
  const batch = new DurableBatch<{ message: BusMessage; observation: NormalizedObservation }>(
    size,
    target === 'postgres' ? 1000 : 2000,
    async (entries) => {
      const observations = entries.map((entry) => entry.observation);
      if (target === 'postgres') await saveLatestBatch(infra, observations);
      else await saveHistoryBatch(infra, observations);
      await markFusionWriterReady(infra, target, observations);
    },
    (entry) => {
      entry.message.ack();
      onProcessed();
    },
    (entries, error) => {
      logger.error(
        { target, error: error instanceof Error ? error.message : 'Persistence failed' },
        'Writer retained messages for retry',
      );
      onFailure();
      for (const entry of entries) entry.message.nak(30_000);
    },
  );
  const stop = () => messages.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      try {
        await batch.add({ message, observation: parseNormalizedObservation(message.json()) });
      } catch (error) {
        onFailure();
        logger.error(
          {
            error: error instanceof Error ? error.message : 'Invalid normalized record',
            sequence: message.seq,
          },
          'Writer input invalid; retained for investigation',
        );
        message.nak(60_000);
      }
    }
  } finally {
    clearInterval(outboxTimer);
    signal.removeEventListener('abort', stop);
    messages.stop();
    await batch.close();
    await pendingFlush;
  }
}
