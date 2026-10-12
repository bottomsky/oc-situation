import { TaskCommandSchema, type TaskCommand } from '@ais/contracts';
import { parseSourcePayload } from '@ais/source-adapters';
import {
  consume,
  loadRawPayload,
  logger,
  publishNormalized,
  readArchive,
  toCamelRow,
  updateRunStatus,
  assessPositionQualityBatch,
  observationCounts,
  emptyProcessingCounts,
  recordReplayManifest,
  type Infrastructure,
} from '@ais/infrastructure';
import { processRaw } from './process';

export class ReplayTerminalError extends Error {}
class ReplayStopped extends Error {
  constructor(public cancelled: boolean) {
    super(cancelled ? 'Replay cancelled' : 'Replay worker stopped');
  }
}
interface ReplayCursor {
  timeBucket: string;
  sequence: number;
  id: string;
}

export async function runReplay(
  infra: Infrastructure,
  command: TaskCommand,
  signal?: AbortSignal,
): Promise<void> {
  const result = await infra.pool.query('SELECT * FROM replays WHERE id=$1', [command.runId]);
  const replay = result.rows[0];
  const checkControl = async () => {
    if (signal?.aborted) throw new ReplayStopped(false);
    const run = await infra.pool.query('SELECT status FROM runs WHERE id=$1', [command.runId]);
    if (run.rows[0]?.status === 'cancelled') throw new ReplayStopped(true);
  };
  try {
    if (!replay) throw new ReplayTerminalError('Replay configuration missing');
    await checkControl();
    if (replay.cleaning_version !== 1 || replay.target_dataset !== 'current')
      throw new ReplayTerminalError(
        'Replay target dataset migration is not available; cleaning version 1/current is required',
      );
    if (replay.status === 'succeeded') return;
    let cursor = replay.checkpoint?.cursor as ReplayCursor | undefined;
    if (
      cursor &&
      (!Number.isFinite(Date.parse(cursor.timeBucket)) ||
        !Number.isSafeInteger(cursor.sequence) ||
        typeof cursor.id !== 'string')
    )
      throw new ReplayTerminalError('Replay checkpoint cursor invalid');
    if (!cursor && replay.checkpoint?.manifestId) {
      const previous = await infra.pool.query(
        'SELECT time_bucket,first_sequence,id FROM archive_batches WHERE id=$1',
        [replay.checkpoint.manifestId],
      );
      const row = previous.rows[0];
      if (!row)
        throw new ReplayTerminalError(
          'Replay checkpoint missing; archive retention gap requires a new reviewed replay range',
        );
      cursor = {
        timeBucket: row.time_bucket.toISOString(),
        sequence: Number(row.first_sequence),
        id: row.id,
      };
    }
    await infra.pool.query(
      "UPDATE replays SET status='running',last_error=NULL,updated_at=now() WHERE id=$1",
      [command.runId],
    );
    await updateRunStatus(infra, command.runId, 'running');
    for (;;) {
      await checkControl();
      const parameters = [
        replay.from_time,
        replay.to_time,
        replay.source_id,
        cursor?.timeBucket ?? '1970-01-01T00:00:00Z',
        cursor?.sequence ?? 0,
        cursor?.id ?? '',
      ];
      const gaps = await infra.pool.query(
        "SELECT id FROM archive_batches WHERE max_received_at>=$1 AND min_received_at<$2 AND ($3::text IS NULL OR source_id=$3) AND (time_bucket,first_sequence,id)>($4::timestamptz,$5::bigint,$6::text) AND (expire_at<=now() OR status IN ('expired','pending_delete','deleted')) LIMIT 1",
        parameters,
      );
      if (gaps.rowCount)
        throw new ReplayTerminalError('Replay archive retention gap: requested records expired');
      const manifests = await infra.pool.query(
        "SELECT * FROM archive_batches WHERE status='committed' AND expire_at>now() AND max_received_at>=$1 AND min_received_at<$2 AND ($3::text IS NULL OR source_id=$3) AND (time_bucket,first_sequence,id)>($4::timestamptz,$5::bigint,$6::text) ORDER BY time_bucket,first_sequence,id LIMIT 100",
        parameters,
      );
      if (!manifests.rowCount) break;
      for (const row of manifests.rows) {
        await checkControl();
        const manifest = toCamelRow<{
          bucket: string;
          objectKey: string;
          checksum: string;
          expireAt: string;
        }>(row);
        const raws = await readArchive(infra, manifest);
        const manifestCounts = emptyProcessingCounts();
        for (const raw of raws) {
          await checkControl();
          if (
            Date.parse(raw.receivedAt) < new Date(replay.from_time).getTime() ||
            Date.parse(raw.receivedAt) >= new Date(replay.to_time).getTime()
          )
            continue;
          if (command.replayCaptureIds && !command.replayCaptureIds.includes(raw.captureId))
            continue;
          const observations = await processRaw(
            {
              load: (r) => loadRawPayload(infra, r),
              parse: parseSourcePayload,
              enrich: (observations) => assessPositionQualityBatch(infra,observations),
              publish: async (o) => {
                if (signal?.aborted) throw new ReplayStopped(false);
                await publishNormalized(infra, o);
              },
            },
            raw,
            () => {},
          );
          const counts = observationCounts(observations);
          for (const key of Object.keys(counts) as (keyof typeof counts)[]) manifestCounts[key] += counts[key];
        }
        await recordReplayManifest(infra,command.runId,row.id,manifestCounts,manifest.expireAt);
        cursor = {
          timeBucket: row.time_bucket.toISOString(),
          sequence: Number(row.first_sequence),
          id: row.id,
        };
        await infra.pool.query(
          'UPDATE replays SET checkpoint=$2::jsonb,updated_at=now() WHERE id=$1',
          [command.runId, JSON.stringify({ manifestId: row.id, cursor })],
        );
      }
    }
    await checkControl();
    await infra.pool.query(
      "UPDATE replays SET status='succeeded',last_error=NULL,updated_at=now() WHERE id=$1",
      [command.runId],
    );
    await updateRunStatus(infra, command.runId, 'succeeded');
  } catch (error) {
    const status =
      error instanceof ReplayStopped ? (error.cancelled ? 'cancelled' : 'queued') : 'failed';
    const detail = error instanceof Error ? error.message.slice(0, 500) : 'Replay failed';
    await infra.pool.query(
      'UPDATE replays SET status=$2,last_error=$3,updated_at=now() WHERE id=$1',
      [command.runId, status, detail],
    );
    await updateRunStatus(infra, command.runId, status, detail);
    if (error instanceof ReplayStopped && error.cancelled) return;
    throw error;
  }
}

export async function runReplayConsumer(infra: Infrastructure, signal: AbortSignal): Promise<void> {
  const messages = await consume(infra, 'AIS_COMMANDS', 'replay', 1);
  const stop = () => messages.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      const heartbeat = setInterval(() => message.working(), 30_000);
      heartbeat.unref();
      try {
        await runReplay(infra, TaskCommandSchema.parse(message.json()), signal);
        message.ack();
      } catch (error) {
        logger.error(
          { error: error instanceof Error ? error.message : 'Replay failed' },
          'Replay command failed',
        );
        if (error instanceof ReplayTerminalError) message.ack();
        else message.nak(60_000);
      } finally {
        clearInterval(heartbeat);
      }
    }
  } finally {
    signal.removeEventListener('abort', stop);
    messages.stop();
  }
}
