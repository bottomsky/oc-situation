import { parseRawEnvelope } from '@ais/contracts';
import {
  archiveMessages,
  consume,
  DurableBatch,
  expireArchives,
  logger,
  type ArchiveEntry,
  type BusMessage,
  type Infrastructure,
} from '@ais/infrastructure';
export async function runArchiver(
  infra: Infrastructure,
  signal: AbortSignal,
  onProcessed = () => {},
  onFailure = () => {},
): Promise<void> {
  const messages = await consume(infra, 'AIS_RAW', 'archiver', 10_000);
  let bufferedBytes = 0;
  const batch = new DurableBatch<{ entry: ArchiveEntry; message: BusMessage }>(
    10_000,
    60_000,
    async (entries) => {
      await archiveMessages(
        infra,
        entries.map((entry) => entry.entry),
      );
      bufferedBytes = 0;
    },
    () => onProcessed(),
    (entries, error) => {
      logger.error(
        { error: error instanceof Error ? error.message : 'Archive failed' },
        'Archive retained messages for retry',
      );
      onFailure();
      for (const entry of entries) {
        heartbeats.delete(entry.message);
        entry.message.nak(60_000);
      }
    },
  );
  const expire = () => {
    void expireArchives(infra).catch((error: unknown) =>
      logger.error(
        { error: error instanceof Error ? error.message : 'Expiry failed' },
        'Expiry sweep failed',
      ),
    );
  };
  expire();
  const expiryTimer = setInterval(expire, 86_400_000);
  expiryTimer.unref();
  const heartbeats = new Set<BusMessage>();
  const heartbeatTimer = setInterval(() => {
    for (const message of heartbeats) message.working();
  }, 30_000);
  heartbeatTimer.unref();
  const stop = () => messages.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      try {
        const raw = parseRawEnvelope(message.json());
        heartbeats.add(message);
        bufferedBytes += message.data.length;
        await batch.add({
          message,
          entry: {
            raw,
            sequence: message.seq,
            ack() {
              message.ack();
              heartbeats.delete(message);
            },
          },
        });
        if (bufferedBytes >= 16 * 1024 * 1024) {
          await batch.flush();
          bufferedBytes = 0;
        }
      } catch (error) {
        onFailure();
        logger.error(
          { error: error instanceof Error ? error.message : 'Raw archive invalid' },
          'Archive input retained',
        );
        message.nak(60_000);
      }
    }
  } finally {
    clearInterval(expiryTimer);
    clearInterval(heartbeatTimer);
    signal.removeEventListener('abort', stop);
    messages.stop();
    await batch.close();
  }
}
