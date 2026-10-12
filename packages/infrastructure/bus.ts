import { randomUUID, createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JsMsg,
} from '@nats-io/jetstream';
import {
  parseRawEnvelope,
  parseNormalizedObservation,
  type RawEnvelope,
  type NormalizedObservation,
} from '@ais/contracts';
import type { Infrastructure } from './clients';
import { busPressure } from './recovery';

export const STREAMS = {
  raw: {
    name: 'AIS_RAW',
    subjects: ['ais.raw.*'],
    maxBytes: 300_000_000_000,
    retention: RetentionPolicy.Interest,
  },
  normalized: {
    name: 'AIS_NORMALIZED',
    subjects: ['ais.normalized.*'],
    maxBytes: 150_000_000_000,
    retention: RetentionPolicy.Interest,
  },
  commands: {
    name: 'AIS_COMMANDS',
    subjects: ['ais.commands.*'],
    maxBytes: 1_000_000_000,
    retention: RetentionPolicy.Workqueue,
  },
} as const;
export const CONSUMERS = [
  { stream: 'AIS_RAW', durable: 'cleaner', filter: 'ais.raw.*', maxPending: 100 },
  { stream: 'AIS_RAW', durable: 'archiver', filter: 'ais.raw.*', maxPending: 20_000 },
  {
    stream: 'AIS_NORMALIZED',
    durable: 'postgres-writer',
    filter: 'ais.normalized.*',
    maxPending: 2_000,
  },
  {
    stream: 'AIS_NORMALIZED',
    durable: 'clickhouse-writer',
    filter: 'ais.normalized.*',
    maxPending: 10_000,
  },
  { stream: 'AIS_COMMANDS', durable: 'crawler', filter: 'ais.commands.crawl', maxPending: 1 },
  { stream: 'AIS_COMMANDS', durable: 'collector', filter: 'ais.commands.collect', maxPending: 8 },
  { stream: 'AIS_COMMANDS', durable: 'replay', filter: 'ais.commands.replay', maxPending: 1 },
] as const;

export async function bootstrapJetstream(infra: Infrastructure): Promise<void> {
  for (const stream of Object.values(STREAMS)) {
    try {
      await infra.jsm.streams.info(stream.name);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await infra.jsm.streams.add({
        name: stream.name,
        subjects: [...stream.subjects],
        storage: StorageType.File,
        retention: stream.retention,
        max_bytes: stream.maxBytes,
        max_age: 0,
        discard: DiscardPolicy.New,
        num_replicas: 1,
        duplicate_window: 120_000_000_000,
      });
    }
  }
  for (const consumer of CONSUMERS) {
    try {
      const existing = await infra.jsm.consumers.info(consumer.stream, consumer.durable);
      // Versioned transition from the initial single-actor collector to bounded parallel actors.
      if (
        consumer.durable === 'collector' &&
        existing.config.max_ack_pending === 1 &&
        existing.config.max_waiting === 1 &&
        existing.config.ack_policy === AckPolicy.Explicit &&
        existing.config.deliver_policy === DeliverPolicy.All &&
        existing.config.filter_subject === consumer.filter &&
        existing.config.ack_wait === 120_000_000_000 &&
        existing.config.max_deliver === -1
      )
        await infra.jsm.consumers.update(consumer.stream, consumer.durable, { max_ack_pending: 8 });
    } catch (error) {
      if (!isMissing(error)) throw error;
      await infra.jsm.consumers.add(consumer.stream, {
        durable_name: consumer.durable,
        filter_subject: consumer.filter,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        ack_wait: 120_000_000_000,
        max_ack_pending: consumer.maxPending,
        max_deliver: -1,
        max_waiting: consumer.maxPending === 1 || consumer.durable === 'collector' ? 1 : 512,
      });
    }
  }
  const health = await busHealth(infra);
  if (health.reasons.some((reason) => reason.startsWith('drift') || reason.startsWith('missing')))
    throw new Error(`JetStream topology invalid: ${health.reasons.join(', ')}`);
}
function isMissing(error: unknown): boolean {
  const e = error as {
    code?: string | number;
    api_error?: { code?: number; err_code?: number };
    apiError?: { code?: number };
  };
  return (
    e.code === '404' ||
    e.code === 404 ||
    e.api_error?.code === 404 ||
    e.apiError?.code === 404 ||
    (error instanceof Error &&
      (error.name === 'StreamNotFoundError' || error.name === 'ConsumerNotFoundError'))
  );
}
export async function busHealth(infra: Infrastructure) {
  const reasons: string[] = [];
  let status: 'ready' | 'warning' | 'paused' = 'ready';
  const streams: {
    name: string;
    bytes: number;
    limit: number;
    oldestAgeMs: number;
    messages: number;
  }[] = [];
  for (const expected of Object.values(STREAMS)) {
    try {
      const info = await infra.jsm.streams.info(expected.name);
      const actual = info.config;
      if (
        actual.retention !== expected.retention ||
        actual.storage !== StorageType.File ||
        actual.discard !== DiscardPolicy.New ||
        actual.max_age !== 0 ||
        actual.max_bytes !== expected.maxBytes ||
        actual.num_replicas !== 1 ||
        JSON.stringify(actual.subjects) !== JSON.stringify(expected.subjects)
      )
        reasons.push(`drift:stream:${expected.name}`);
      const oldestAgeMs = info.state.messages
        ? Math.max(0, Date.now() - Date.parse(info.state.first_ts))
        : 0;
      streams.push({
        name: expected.name,
        bytes: info.state.bytes,
        limit: expected.maxBytes,
        oldestAgeMs,
        messages: info.state.messages,
      });
      const pressure = busPressure(info.state.bytes, expected.maxBytes, oldestAgeMs);
      if (pressure === 'paused') {
        status = 'paused';
        reasons.push(`pressure:${expected.name}`);
      } else if (pressure === 'warning' && status === 'ready') status = 'warning';
    } catch {
      reasons.push(`missing:stream:${expected.name}`);
    }
  }
  for (const expected of CONSUMERS) {
    try {
      const info = await infra.jsm.consumers.info(expected.stream, expected.durable);
      const actual = info.config;
      if (
        actual.filter_subject !== expected.filter ||
        actual.ack_policy !== AckPolicy.Explicit ||
        actual.max_ack_pending !== expected.maxPending ||
        actual.durable_name !== expected.durable ||
        actual.deliver_policy !== DeliverPolicy.All ||
        actual.ack_wait !== 120_000_000_000 ||
        actual.max_deliver !== -1 ||
        actual.max_waiting !==
          (expected.maxPending === 1 || expected.durable === 'collector' ? 1 : 512)
      )
        reasons.push(`drift:consumer:${expected.durable}`);
    } catch {
      reasons.push(`missing:consumer:${expected.durable}`);
    }
  }
  if (reasons.some((reason) => reason.startsWith('missing') || reason.startsWith('drift')))
    status = 'paused';
  return { status, ready: status !== 'paused', reasons, streams };
}
const healthCache = new WeakMap<
  Infrastructure,
  { at: number; value: Awaited<ReturnType<typeof busHealth>> }
>();
export function invalidateBusHealth(infra: Infrastructure): void {
  healthCache.delete(infra);
  normalizedTopologyCache.delete(infra);
}
export async function cachedBusHealth(infra: Infrastructure) {
  const cached = healthCache.get(infra);
  if (cached && Date.now() - cached.at < 1000) return cached.value;
  const value = await busHealth(infra);
  healthCache.set(infra, { at: Date.now(), value });
  return value;
}
export async function assertCollectionReady(infra: Infrastructure): Promise<void> {
  const health = await cachedBusHealth(infra);
  if (!health.ready) throw new Error(`Collection paused: ${health.reasons.join(', ')}`);
}
/** In-flight acquisition must publish RAW to finish commands and drain their queue. */
export function rawPublicationReady(health: Awaited<ReturnType<typeof busHealth>>): boolean {
  if (health.status === 'ready' || health.status === 'warning')
    return health.ready && health.reasons.length === 0;
  return (
    health.status === 'paused' &&
    !health.ready &&
    health.reasons.length > 0 &&
    health.reasons.every((reason) => reason === 'pressure:AIS_COMMANDS')
  );
}
/** Retains RAW/NORMALIZED pressure and all topology guards while existing commands drain. */
export async function assertRawPublicationReady(infra: Infrastructure): Promise<void> {
  const health = await cachedBusHealth(infra);
  if (!rawPublicationReady(health))
    throw new Error(
      `Raw publication paused: ${health.reasons.join(', ') || 'health state unavailable'}`,
    );
}
const normalizedTopologyCache = new WeakMap<Infrastructure, number>();
/** Downstream gate deliberately excludes RAW pressure so cleaning can drain a full RAW stream. */
export async function assertNormalizedReady(infra: Infrastructure): Promise<void> {
  if (Date.now() - (normalizedTopologyCache.get(infra) ?? 0) < 1000) return;
  try {
    const expected = STREAMS.normalized;
    const info = await infra.jsm.streams.info(expected.name);
    const actual = info.config;
    if (
      actual.retention !== expected.retention ||
      actual.storage !== StorageType.File ||
      actual.discard !== DiscardPolicy.New ||
      actual.max_age !== 0 ||
      actual.num_replicas !== 1 ||
      actual.max_bytes !== expected.maxBytes ||
      JSON.stringify(actual.subjects) !== JSON.stringify(expected.subjects)
    )
      throw new Error('normalized stream drift');
    for (const consumer of CONSUMERS.filter((c) => c.stream === expected.name)) {
      const { config } = await infra.jsm.consumers.info(consumer.stream, consumer.durable);
      if (
        config.filter_subject !== consumer.filter ||
        config.ack_policy !== AckPolicy.Explicit ||
        config.deliver_policy !== DeliverPolicy.All ||
        config.ack_wait !== 120_000_000_000 ||
        config.max_ack_pending !== consumer.maxPending ||
        config.max_deliver !== -1 ||
        config.max_waiting !== 512 ||
        config.durable_name !== consumer.durable
      )
        throw new Error(`writer consumer drift: ${consumer.durable}`);
    }
    normalizedTopologyCache.set(infra, Date.now());
  } catch (error) {
    normalizedTopologyCache.delete(infra);
    throw new Error(
      `Normalized publication paused: ${error instanceof Error ? error.message : 'topology missing'}`,
      { cause: error },
    );
  }
}
export const EXPORT_INLINE_THRESHOLD_BYTES = 256 * 1024;
export const MAX_RAW_OBJECT_BYTES = 10 * 1024 * 1024;
/** Versioned, deterministic JSON encoding: sorted object keys, original array order and JSON scalars. */
export function canonicalRawJson(value: unknown): string {
  const ancestors = new WeakSet<object>();
  let nodes = 0;
  function encode(item: unknown, depth: number): string {
    if (++nodes > 200_000 || depth > 32) throw new Error('Raw JSON exceeds structural limits');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || ancestors.has(item))
      throw new Error('Raw payload must contain JSON values');
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      throw new Error('Raw payload must contain plain JSON objects');
    ancestors.add(item);
    const result = Array.isArray(item)
      ? `[${Array.from(item, (entry) => encode(entry, depth + 1)).join(',')}]`
      : `{${Object.keys(item)
          .sort()
          .map(
            (key) =>
              `${JSON.stringify(key)}:${encode((item as Record<string, unknown>)[key], depth + 1)}`,
          )
          .join(',')}}`;
    ancestors.delete(item);
    return result;
  }
  return encode(value, 0);
}
export async function createRawEnvelope(
  infra: Infrastructure,
  input: Omit<
    RawEnvelope,
    | 'schemaVersion'
    | 'captureId'
    | 'receivedAt'
    | 'payload'
    | 'checksum'
    | 'checksumEncoding'
    | 'integrity'
  > & {
    payload: unknown;
    captureId?: string;
    receivedAt?: string;
  },
): Promise<RawEnvelope> {
  const captureId = input.captureId ?? randomUUID();
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const bytes = Buffer.from(canonicalRawJson(input.payload));
  const checksum = createHash('sha256').update(bytes).digest('hex');
  let payload: RawEnvelope['payload'] = { kind: 'inline', value: input.payload };
  if (bytes.length > MAX_RAW_OBJECT_BYTES) throw new Error('Raw payload exceeds 10 MiB');
  if (bytes.length > EXPORT_INLINE_THRESHOLD_BYTES) {
    const sha256 = checksum;
    const key = `artifacts/${receivedAt.slice(0, 10)}/${captureId}.json`;
    await infra.s3.send(
      new PutObjectCommand({
        Bucket: infra.config.s3Bucket,
        Key: key,
        Body: bytes,
        ContentType: 'application/json',
        Metadata: { sha256 },
      }),
    );
    await infra.pool.query(
      'INSERT INTO artifacts(id,bucket,object_key,checksum,bytes,content_type,received_at,expire_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO NOTHING',
      [
        captureId,
        infra.config.s3Bucket,
        key,
        sha256,
        bytes.length,
        'application/json',
        receivedAt,
        new Date(Date.parse(receivedAt) + 90 * 86_400_000).toISOString(),
      ],
    );
    payload = { kind: 'object', bucket: infra.config.s3Bucket, key, sha256 };
  }
  return parseRawEnvelope({
    schemaVersion: 1,
    captureId,
    receivedAt,
    sourceId: input.sourceId,
    sourceKind: input.sourceKind,
    adapterVersion: input.adapterVersion,
    sourcePriority: input.sourcePriority,
    runId: input.runId,
    payload,
    checksum,
    checksumEncoding: 'canonical-json-v1',
    ...(input.responseMeta ? { responseMeta: input.responseMeta } : {}),
  });
}
export async function loadRawPayload(infra: Infrastructure, raw: RawEnvelope): Promise<unknown> {
  verifyRawIntegrity(raw);
  if (raw.payload.kind === 'inline') {
    return raw.payload.value;
  }
  if (raw.checksum && raw.checksum !== raw.payload.sha256)
    throw new Error('Raw object checksum mismatch');
  const object = await infra.s3.send(
    new GetObjectCommand({ Bucket: raw.payload.bucket, Key: raw.payload.key }),
  );
  if (!object.Body) throw new Error('Raw object has no body');
  if ((object.ContentLength ?? 0) > MAX_RAW_OBJECT_BYTES)
    throw new Error('Raw object exceeds 10 MiB');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > MAX_RAW_OBJECT_BYTES) {
      (object.Body as unknown as { destroy?: () => void }).destroy?.();
      throw new Error('Raw object exceeds 10 MiB');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== raw.payload.sha256)
    throw new Error('Raw object checksum mismatch');
  return JSON.parse(Buffer.from(bytes).toString('utf8'));
}
/** Verify persisted raw metadata without fetching an object; loadRawPayload also verifies object bytes. */
export function verifyRawIntegrity(raw: RawEnvelope): void {
  if (!raw.checksum) return; // v1 archives preceding integrity support remain explicitly unverified.
  const actual =
    raw.payload.kind === 'inline'
      ? createHash('sha256')
          .update(
            raw.checksumEncoding === 'canonical-json-v1'
              ? canonicalRawJson(raw.payload.value)
              : JSON.stringify(raw.payload.value),
          )
          .digest('hex')
      : raw.payload.sha256;
  if (actual !== raw.checksum) throw new Error('Raw payload checksum mismatch');
}
export async function publishRaw(infra: Infrastructure, raw: RawEnvelope): Promise<void> {
  const valid = parseRawEnvelope(raw);
  if (!valid.checksum) throw new Error('New raw publication requires payload checksum');
  if (valid.payload.kind === 'inline') await loadRawPayload(infra, valid);
  await assertRawPublicationReady(infra);
  try {
    await infra.js.publish(`ais.raw.${subjectToken(valid.sourceId)}`, JSON.stringify(valid), {
      msgID: valid.captureId,
    });
  } catch (error) {
    invalidateBusHealth(infra);
    throw error;
  }
}
export async function publishNormalized(
  infra: Infrastructure,
  observation: NormalizedObservation,
): Promise<void> {
  const valid = parseNormalizedObservation(observation);
  await assertNormalizedReady(infra);
  await infra.js.publish(`ais.normalized.${valid.kind}`, JSON.stringify(valid), {
    msgID: `${valid.eventId}:${valid.cleaningVersion}`,
  });
}
export const subjectToken = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);
export async function consume(
  infra: Infrastructure,
  stream: string,
  durable: string,
  maxMessages = 100,
) {
  const consumer = await infra.js.consumers.get(stream, durable);
  return consumer.consume(
    stream === 'AIS_RAW' && durable === 'archiver'
      ? { max_bytes: 16 * 1024 * 1024 }
      : { max_messages: maxMessages },
  );
}
export type BusMessage = JsMsg;
