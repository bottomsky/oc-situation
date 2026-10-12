import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { SourceSettingsSchema, type SourceConfig, type TaskCommand } from '@ais/contracts';
import {
  acquireLease,
  checkpointRun,
  createRawEnvelope,
  getRun,
  getSource,
  publishRaw,
  releaseLease,
  renewLease,
  updateRunStatus,
  type Infrastructure,
  type Lease,
} from '@ais/infrastructure';
import {
  buildMarineTrafficUrl,
  collectPages,
  CursorExpiredError,
  FatalSourceError,
  fetchMarineTraffic,
} from './http';
import type { AcquisitionMetrics } from './metrics';

export function assertLiveSource(source: SourceConfig, env: NodeJS.ProcessEnv): string {
  if (source.status !== 'enabled') throw new FatalSourceError('Source is not enabled');
  if (!source.settings?.authorizationConfirmed || !source.secretRef)
    throw new FatalSourceError('Source authorization and secret reference are required');
  const secret = env[source.secretRef];
  if (!secret) throw new FatalSourceError('Source secret is unavailable');
  return secret;
}
export function streamSubscription(source: SourceConfig, key: string): unknown {
  const bbox = source.bbox ?? [-180, -90, 180, 90];
  return {
    APIKey: key,
    BoundingBoxes: [
      [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
      ],
    ],
    FilterMessageTypes: [
      'PositionReport',
      'StandardClassBPositionReport',
      'ExtendedClassBPositionReport',
      'ShipStaticData',
      'StaticDataReport',
    ],
  };
}
export function redactError(error: unknown, secrets: string[] = []): string {
  let message = error instanceof Error ? error.message : 'Source operation failed';
  message = message.replace(/(?:https?|wss?):\/\/[^\s]+/g, '[provider-url]');
  for (const secret of secrets) if (secret) message = message.split(secret).join('[secret]');
  return message.slice(0, 500);
}
async function collectMarineTraffic(
  infra: Infrastructure,
  source: SourceConfig,
  command: TaskCommand,
  lease: Lease,
  key: string,
  signal: AbortSignal,
  metrics?: AcquisitionMetrics,
): Promise<void> {
  const settings = SourceSettingsSchema.parse(source.settings ?? {});
  const run = await getRun(infra, command.runId);
  const checkpoint = (run?.checkpoint ?? {}) as {
    cursor?: string;
    windowStartedAt?: string;
    cursorRestarts?: number;
  };
  const windowStartedAt = checkpoint.windowStartedAt ?? new Date().toISOString();
  let lastRequest = 0;
  let pagePayload: unknown;
  let cursorRestarts = checkpoint.cursorRestarts ?? 0;
  const pages = async (cursor?: string) =>
    collectPages({
      cursor,
      maxPages: settings.maxPages,
      fetchPage: async (current) => {
        pagePayload = await fetchMarineTraffic(
          buildMarineTrafficUrl(key, settings.pageLimit, settings.timespanMinutes, current),
          signal,
          {
            beforeAttempt: async () => {
              const wait =
                60_000 / Math.min(100, settings.requestsPerMinute) - (Date.now() - lastRequest);
              if (wait > 0) await delay(wait, undefined, { signal });
              lastRequest = Date.now();
              metrics?.requests.inc();
            },
          },
        );
        return pagePayload;
      },
      publish: async () => {
        if (!(await renewLease(infra, lease, 120))) throw new Error('Source lease lost');
        const raw = await createRawEnvelope(infra, {
          sourceId: source.sourceId,
          sourceKind: source.sourceKind,
          adapterVersion: '1.0.0',
          sourcePriority: source.priority,
          runId: command.runId,
          payload: pagePayload,
          responseMeta: { format: 'json', statusCode: 200 },
        });
        await publishRaw(infra, raw);
        metrics?.captures.inc();
        metrics?.lastReceived.set(Date.parse(raw.receivedAt) / 1000);
      },
      checkpoint: async (next) => {
        await checkpointRun(
          infra,
          command.runId,
          { cursor: next, windowStartedAt, cursorRestarts },
          lease,
        );
        await infra.pool.query(
          `UPDATE runs SET counters=jsonb_set(counters,'{captures}',to_jsonb(coalesce((counters->>'captures')::int,0)+1)) WHERE id=$1`,
          [command.runId],
        );
        await infra.pool.query(
          'UPDATE sources SET last_received_at=now(),last_error=NULL,updated_at=now() WHERE id=$1',
          [source.sourceId],
        );
      },
    });
  try {
    await pages(checkpoint.cursor);
  } catch (error) {
    if (!(error instanceof CursorExpiredError) || cursorRestarts >= 1) throw error;
    cursorRestarts++;
    await checkpointRun(
      infra,
      command.runId,
      {
        cursor: null,
        windowStartedAt,
        cursorRestarts,
        recovery: 'restart_overlapping_timespan_window',
        gapDetectedAt: new Date().toISOString(),
      },
      lease,
    );
    await infra.pool.query(
      "UPDATE sources SET last_error='Cursor expired; restarted overlapping collection window; possible gap',updated_at=now() WHERE id=$1",
      [source.sourceId],
    );
    await pages();
  }
}
export async function collectAisStream(
  infra: Infrastructure,
  source: SourceConfig,
  command: TaskCommand,
  lease: Lease,
  key: string,
  signal: AbortSignal,
  metrics?: AcquisitionMetrics,
): Promise<void> {
  let failures = 0;
  let disconnectedAt: string | null = null;
  const run = await getRun(infra, command.runId);
  let captures = Number((run?.counters as { captures?: number })?.captures ?? 0);
  let dirty = 0;
  let receivedAt: string | null = null;
  let persist = Promise.resolve();
  let persistenceFailure: Error | null = null;
  const flush = () => {
    if (!dirty && !disconnectedAt) return persist;
    const count = captures;
    const capturedAt = receivedAt;
    const gapAt = disconnectedAt;
    dirty = 0;
    persist = persist.then(async () => {
      const result = await infra.pool.query(
        `WITH updated AS (UPDATE runs SET checkpoint=$2::jsonb,counters=jsonb_set(counters,'{captures}',to_jsonb($3::int)),updated_at=now() WHERE id=$1 AND EXISTS(SELECT 1 FROM leases WHERE name=$4 AND owner=$5 AND fencing_token=$6 AND expires_at>now()) RETURNING source_id) UPDATE sources SET last_received_at=coalesce($7::timestamptz,last_received_at),last_error=CASE WHEN $8::boolean THEN 'AISStream data gap; reconnecting' ELSE NULL END,updated_at=now() WHERE id IN(SELECT source_id FROM updated)`,
        [
          command.runId,
          JSON.stringify({
            lastReceivedAt: capturedAt,
            disconnectedAt: gapAt,
            gap: gapAt !== null,
          }),
          count,
          lease.name,
          lease.owner,
          lease.fencingToken,
          capturedAt,
          gapAt !== null,
        ],
      );
      if (result.rowCount !== 1) throw new Error('Source lease lost while checkpointing');
    });
    return persist;
  };
  const checkpointTimer = setInterval(() => {
    void flush().catch((error: unknown) => {
      persistenceFailure = error instanceof Error ? error : new Error('Stream checkpoint failed');
    });
  }, 1000);
  try {
    while (!signal.aborted) {
      if (persistenceFailure) throw persistenceFailure;
      let socket: WebSocket | undefined;
      try {
        await new Promise<void>((resolve, reject) => {
          socket = new WebSocket('wss://stream.aisstream.io/v0/stream', {
            perMessageDeflate: true,
            maxPayload: 10_485_760,
            handshakeTimeout: 30_000,
          });
          let processing = Promise.resolve();
          let failed = false;
          let queuedBytes = 0;
          let queuedMessages = 0;
          const finish = (error?: Error) => {
            if (failed) return;
            failed = true;
            signal.removeEventListener('abort', abort);
            socket?.close();
            processing.then(() => (error ? reject(error) : resolve()), reject);
          };
          const abort = () => finish();
          signal.addEventListener('abort', abort, { once: true });
          socket.on('open', () => socket?.send(JSON.stringify(streamSubscription(source, key))));
          socket.on('message', (bytes) => {
            metrics?.requests.inc();
            const byteLength = Buffer.byteLength(bytes.toString());
            queuedBytes += byteLength;
            queuedMessages++;
            if (queuedBytes > 10_485_760 || queuedMessages > 1000) {
              finish(new Error('Stream pending buffer exceeded'));
              return;
            }
            socket?.pause();
            processing = processing.then(async () => {
              if (signal.aborted) return;
              if (persistenceFailure) throw persistenceFailure;
              const payload = JSON.parse(bytes.toString()) as Record<string, unknown>;
              if (payload.error || payload.Error)
                throw new FatalSourceError('AISStream subscription or authorization rejected');
              if (payload.MessageType === 'SubscriptionConfirmation') return;
              const raw = await createRawEnvelope(infra, {
                sourceId: source.sourceId,
                sourceKind: source.sourceKind,
                adapterVersion: '1.0.0',
                sourcePriority: source.priority,
                runId: command.runId,
                payload,
                responseMeta: { format: 'json', contentType: 'application/json' },
              });
              await publishRaw(infra, raw);
              metrics?.captures.inc();
              metrics?.lastReceived.set(Date.parse(raw.receivedAt) / 1000);
              captures++;
              dirty++;
              receivedAt = raw.receivedAt;
              failures = 0;
              disconnectedAt = null;
              if (dirty >= 1000) await flush();
            });
            processing.then(
              () => {
                queuedBytes -= byteLength;
                queuedMessages--;
                socket?.resume();
              },
              (error) =>
                finish(error instanceof Error ? error : new Error('Stream processing failed')),
            );
          });
          socket.on('unexpected-response', (_request, response) =>
            finish(
              response.statusCode === 401 || response.statusCode === 403
                ? new FatalSourceError('AISStream authorization rejected')
                : new Error('AISStream handshake rejected'),
            ),
          );
          socket.on('error', () => finish(new Error('AISStream connection failed')));
          socket.on('close', () => finish());
        });
      } catch (error) {
        if (error instanceof FatalSourceError) throw error;
        if (signal.aborted) return;
      } finally {
        socket?.terminate();
      }
      if (signal.aborted) return;
      disconnectedAt ??= new Date().toISOString();
      await flush();
      await delay(Math.min(60, 2 ** Math.min(failures++, 6)) * 1000, undefined, { signal });
    }
  } finally {
    clearInterval(checkpointTimer);
    await flush();
  }
}
export async function runCollection(
  infra: Infrastructure,
  command: TaskCommand,
  shutdown: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
  metrics?: AcquisitionMetrics,
): Promise<boolean> {
  if (command.mode !== 'collect') throw new Error('Collector only handles collect commands');
  const run = await getRun(infra, command.runId);
  if (!run) throw new Error('Run not found');
  if (['succeeded', 'failed', 'cancelled'].includes(String(run.status))) return true;
  const source = await getSource(infra, command.sourceId);
  if (!source) throw new Error('Source not found');
  const lease = await acquireLease(infra, `source:${source.sourceId}`, randomUUID(), 120);
  if (!lease) return false;
  metrics?.activeRuns.inc();
  const controller = new AbortController();
  const signal = AbortSignal.any([shutdown, controller.signal]);
  let secret = '';
  let cancelled = false;
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void (async () => {
      if (!(await renewLease(infra, lease, 120))) {
        leaseLost = true;
        controller.abort();
        return;
      }
      const state = await infra.pool.query(
        'SELECT j.enabled AS job_enabled,s.enabled AS source_enabled,s.status AS source_status,r.status AS run_status FROM runs r JOIN jobs j ON j.id=r.job_id JOIN sources s ON s.id=r.source_id WHERE r.id=$1',
        [command.runId],
      );
      const row = state.rows[0];
      if (
        !row ||
        !row.job_enabled ||
        !row.source_enabled ||
        row.source_status === 'error' ||
        row.run_status === 'cancelled'
      ) {
        cancelled = true;
        controller.abort();
      }
    })().catch(() => {
      leaseLost = true;
      controller.abort();
    });
  }, 30_000);
  try {
    secret = assertLiveSource(source, env);
    await updateRunStatus(infra, command.runId, 'running');
    if (source.sourceKind === 'marinetraffic')
      await collectMarineTraffic(infra, source, command, lease, secret, signal, metrics);
    else if (source.sourceKind === 'aisstream')
      await collectAisStream(infra, source, command, lease, secret, signal, metrics);
    else throw new FatalSourceError('Fixture sources require crawl mode');
    if (leaseLost) throw new Error('Source lease lost');
    await updateRunStatus(
      infra,
      command.runId,
      shutdown.aborted || cancelled ? 'cancelled' : 'succeeded',
    );
    return true;
  } catch (error) {
    metrics?.failures.inc();
    const message = redactError(error, [secret]);
    await updateRunStatus(
      infra,
      command.runId,
      shutdown.aborted || cancelled ? 'cancelled' : 'failed',
      message,
    );
    await infra.pool.query(
      'UPDATE sources SET last_error=$2,status=CASE WHEN $3 THEN $4 ELSE status END,updated_at=now() WHERE id=$1',
      [source.sourceId, message, error instanceof FatalSourceError, 'error'],
    );
    return true;
  } finally {
    metrics?.activeRuns.dec();
    clearInterval(heartbeat);
    await releaseLease(infra, lease);
  }
}
