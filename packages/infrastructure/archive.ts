import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { parseRawEnvelope, type RawEnvelope } from '@ais/contracts';
import type { Infrastructure } from './clients';
import { STREAMS, subjectToken, verifyRawIntegrity } from './bus';
import { archiveIdentity, toCamelRow } from './recovery';
import {
  archiveBatch,
  compressSequences,
  type ArchiveEntry,
  type ArchiveManifest,
  type ArchivePorts,
} from './archive-engine';

const MAX_PREPARED_BYTES = 32 * 1024 * 1024;

function needsLegacySerialization(entry: ArchiveManifest['rawRecords'][number]): boolean {
  return (
    entry.rawJson === undefined &&
    entry.raw.payload.kind === 'inline' &&
    !!entry.raw.checksum &&
    entry.raw.checksumEncoding !== 'canonical-json-v1'
  );
}

/** Recover only authenticated original bytes; JSONB cannot recover legacy object key order. */
async function recoverLegacySerialization(
  infra: Infrastructure,
  manifest: ArchiveManifest & { sourceId: string; timeBucket: string; count: number },
): Promise<string | undefined> {
  if (manifest.status !== 'prepared' || !manifest.rawRecords.some(needsLegacySerialization)) return;
  const sequences = manifest.rawRecords.map((entry) => entry.sequence);
  const ranges = compressSequences(sequences);
  if (
    sequences.length > 10_000 ||
    sequences.length !== manifest.count ||
    sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence <= 0) ||
    new Set(sequences).size !== sequences.length ||
    !isDeepStrictEqual(ranges, manifest.sequenceRanges) ||
    ranges[0]?.[0] !== Number(manifest.firstSequence) ||
    ranges.at(-1)?.[1] !== Number(manifest.lastSequence)
  )
    throw new Error('Legacy archive manifest sequences disagree');

  let bytes = Buffer.byteLength(JSON.stringify(manifest.rawRecords));
  const recovered: ArchiveManifest['rawRecords'] = [];
  for (const entry of manifest.rawRecords) {
    if (bytes > MAX_PREPARED_BYTES)
      throw new Error('Archive preparation exceeds bounded memory limit');
    const indexed = parseRawEnvelope(entry.raw);
    if (
      indexed.sourceId !== manifest.sourceId ||
      new Date(indexed.receivedAt).toISOString().slice(0, 16) + ':00.000Z' !== manifest.timeBucket
    )
      throw new Error('Legacy archive indexed source or time bucket disagrees');
    if (!needsLegacySerialization(entry)) {
      const original: unknown = entry.rawJson === undefined ? entry.raw : JSON.parse(entry.rawJson);
      verifyRawIntegrity(parseRawEnvelope(original));
      if (!isDeepStrictEqual(original, entry.raw))
        throw new Error('Legacy archive raw message disagrees with indexed envelope');
      recovered.push(entry);
      continue;
    }
    const message = await infra.jsm.streams.getMessage(STREAMS.raw.name, { seq: entry.sequence });
    if (!message) throw new Error('Legacy archive raw message unavailable');
    if (
      message.seq !== entry.sequence ||
      message.subject !== `ais.raw.${subjectToken(indexed.sourceId)}`
    )
      throw new Error('Legacy archive raw message sequence or subject disagrees');
    if (message.data.byteLength > MAX_PREPARED_BYTES - bytes)
      throw new Error('Archive preparation exceeds bounded memory limit');
    const rawJson = new TextDecoder('utf-8', { fatal: true }).decode(message.data);
    const original: unknown = JSON.parse(rawJson);
    const raw = parseRawEnvelope(original);
    verifyRawIntegrity(raw);
    if (!isDeepStrictEqual(original, entry.raw))
      throw new Error('Legacy archive raw message disagrees with indexed envelope');
    bytes += Buffer.byteLength(JSON.stringify(rawJson));
    recovered.push({ ...entry, rawJson });
  }
  const rawRecords = JSON.stringify(recovered);
  if (Buffer.byteLength(rawRecords) > MAX_PREPARED_BYTES)
    throw new Error('Archive preparation exceeds bounded memory limit');
  return rawRecords;
}

export function archivePorts(infra: Infrastructure): ArchivePorts {
  return {
    async prepare(entries) {
      const first = entries[0]!;
      const identity = archiveIdentity(first.raw.receivedAt, first.sequence);
      const minute = new Date(first.raw.receivedAt).toISOString().slice(0, 16) + ':00.000Z';
      const client = await infra.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `${first.raw.sourceId}:${identity.batchId}`,
        ]);
        const existing = await client.query(
          "SELECT * FROM archive_batches WHERE source_id=$1 AND time_bucket=$2 AND first_sequence<=$3 AND last_sequence>=$3 AND status IN ('prepared','committed') AND EXISTS(SELECT 1 FROM jsonb_array_elements(sequence_ranges) r WHERE (r->>0)::bigint<=$3 AND (r->>1)::bigint>=$3) ORDER BY first_sequence LIMIT 1 FOR UPDATE",
          [first.raw.sourceId, minute, first.sequence],
        );
        if (existing.rowCount) {
          let manifest = toCamelRow<
            ArchiveManifest & { sourceId: string; timeBucket: string; count: number }
          >(existing.rows[0]);
          // The row lock fences concurrent recovery/commit until all retained originals verify.
          const rawRecords = await recoverLegacySerialization(infra, manifest);
          if (rawRecords !== undefined) {
            const recovered = await client.query(
              "UPDATE archive_batches SET raw_records=$2::jsonb,updated_at=now() WHERE id=$1 AND status='prepared' RETURNING *",
              [manifest.id, rawRecords],
            );
            if (recovered.rowCount !== 1) throw new Error('Legacy archive prepared status changed');
            manifest = toCamelRow(recovered.rows[0]);
          }
          await client.query('COMMIT');
          return manifest;
        }
        if (entries.length > 10_000) throw new Error('Archive shard exceeds 10000 records');
        const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);
        const firstSequence = sorted[0]!.sequence;
        const lastSequence = sorted.at(-1)!.sequence;
        const sourceHash = createHash('sha256')
          .update(first.raw.sourceId)
          .digest('hex')
          .slice(0, 16);
        const id = `${identity.batchId}-${sourceHash}-${firstSequence}`;
        const objectKey = identity.objectKey.replace(
          '.jsonl.gz',
          `-${sourceHash}-${firstSequence}.jsonl.gz`,
        );
        const times = sorted.map((entry) => Date.parse(entry.raw.receivedAt));
        const min = new Date(Math.min(...times)).toISOString();
        const max = new Date(Math.max(...times)).toISOString();
        const artifactKeys = sorted.flatMap(({ raw }) =>
          raw.payload.kind === 'object'
            ? [{ bucket: raw.payload.bucket, key: raw.payload.key }]
            : [],
        );
        // JSONB reorders keys. Keep the original envelope text for legacy order-sensitive checksums.
        const rawRecords = JSON.stringify(
          sorted.map(({ raw, sequence }) => ({
            raw,
            sequence,
            ...(raw.payload.kind === 'inline' &&
            raw.checksum &&
            raw.checksumEncoding !== 'canonical-json-v1'
              ? { rawJson: JSON.stringify(raw) }
              : {}),
          })),
        );
        if (Buffer.byteLength(rawRecords) > 32 * 1024 * 1024)
          throw new Error('Archive preparation exceeds bounded memory limit');
        const result = await client.query(
          `INSERT INTO archive_batches(id,bucket,object_key,source_id,time_bucket,first_sequence,last_sequence,status,raw_records,artifact_keys,count,min_received_at,max_received_at,expire_at,sequence_ranges) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared',$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14::jsonb) RETURNING *`,
          [
            id,
            infra.config.s3Bucket,
            objectKey,
            first.raw.sourceId,
            minute,
            firstSequence,
            lastSequence,
            rawRecords,
            JSON.stringify(artifactKeys),
            sorted.length,
            min,
            max,
            new Date(Date.parse(max) + 90 * 86_400_000).toISOString(),
            JSON.stringify(compressSequences(sorted.map((entry) => entry.sequence))),
          ],
        );
        await client.query('COMMIT');
        return toCamelRow<ArchiveManifest>(result.rows[0]);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    async upload(manifest, body, checksum) {
      await infra.s3.send(
        new PutObjectCommand({
          Bucket: manifest.bucket,
          Key: manifest.objectKey,
          Body: body,
          ContentType: 'application/x-ndjson',
          ContentEncoding: 'gzip',
          Metadata: { sha256: checksum },
        }),
      );
    },
    async commit(manifest, checksum, bytes) {
      await infra.pool.query(
        "UPDATE archive_batches SET status='committed',checksum=$2,bytes=$3,raw_records='[]'::jsonb,capture_ids='[]'::jsonb,committed_at=now(),updated_at=now() WHERE id=$1 AND status='prepared'",
        [manifest.id, checksum, bytes],
      );
    },
  };
}
export async function archiveMessages(
  infra: Infrastructure,
  entries: readonly ArchiveEntry[],
): Promise<void> {
  const groups = new Map<string, ArchiveEntry[]>();
  for (const entry of entries) {
    const group = `${entry.raw.sourceId}:${archiveIdentity(entry.raw.receivedAt, entry.sequence).batchId}`;
    const values = groups.get(group) ?? [];
    values.push(entry);
    groups.set(group, values);
  }
  const ports = archivePorts(infra);
  for (const values of groups.values()) {
    let remaining = values.sort((a, b) => a.sequence - b.sequence);
    while (remaining.length) {
      const acked = new Set<number>();
      const consumed = await archiveBatch(
        ports,
        remaining.slice(0, 10_000).map((entry) => ({
          ...entry,
          ack() {
            entry.ack();
            acked.add(entry.sequence);
          },
        })),
      );
      if (consumed === 0) throw new Error('Archive recovery made no progress');
      remaining = remaining.filter((entry) => !acked.has(entry.sequence));
    }
  }
}
export async function readArchive(
  infra: Infrastructure,
  manifest: { bucket: string; objectKey: string; checksum: string; expireAt: string },
): Promise<RawEnvelope[]> {
  if (Date.parse(manifest.expireAt) <= Date.now()) throw new Error('Archive expired');
  const response = await infra.s3.send(
    new GetObjectCommand({ Bucket: manifest.bucket, Key: manifest.objectKey }),
  );
  if (!response.Body) throw new Error('Archive body missing');
  const limit = 32 * 1024 * 1024;
  if ((response.ContentLength ?? 0) > limit) throw new Error('Compressed archive exceeds limit');
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    length += chunk.length;
    if (length > limit) {
      (response.Body as unknown as { destroy?: () => void }).destroy?.();
      throw new Error('Compressed archive exceeds limit');
    }
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.checksum)
    throw new Error('Archive checksum mismatch');
  return gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 })
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const raw = parseRawEnvelope(JSON.parse(line));
      verifyRawIntegrity(raw);
      return raw;
    });
}
export async function expireArchives(infra: Infrastructure): Promise<void> {
  await infra.pool.query(
    "UPDATE archive_batches SET status='pending_delete',delete_after=now()+interval '7 days',updated_at=now() WHERE status='committed' AND expire_at<=now()",
  );
  const batches = await infra.pool.query(
    "SELECT * FROM archive_batches WHERE status='pending_delete' ORDER BY expire_at LIMIT 1000",
  );
  for (const batch of batches.rows) {
    try {
      await infra.s3.send(new DeleteObjectCommand({ Bucket: batch.bucket, Key: batch.object_key }));
      for (const artifact of batch.artifact_keys as { bucket: string; key: string }[])
        await infra.s3.send(
          new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.key }),
        );
      await infra.pool.query(
        "UPDATE archive_batches SET status='deleted',last_error=NULL,updated_at=now() WHERE id=$1",
        [batch.id],
      );
    } catch (error) {
      await infra.pool.query(
        'UPDATE archive_batches SET last_error=$2,updated_at=now() WHERE id=$1',
        [batch.id, error instanceof Error ? error.message.slice(0, 500) : 'S3 deletion failed'],
      );
    }
  }
  const artifacts = await infra.pool.query(
    "SELECT * FROM artifacts WHERE expire_at<=now() AND status<>'deleted' LIMIT 1000",
  );
  for (const artifact of artifacts.rows) {
    try {
      await infra.s3.send(
        new DeleteObjectCommand({ Bucket: artifact.bucket, Key: artifact.object_key }),
      );
      await infra.pool.query(
        "UPDATE artifacts SET status='deleted',last_error=NULL,updated_at=now() WHERE id=$1",
        [artifact.id],
      );
    } catch {
      await infra.pool.query(
        "UPDATE artifacts SET status='pending_delete',last_error='S3 deletion failed',updated_at=now() WHERE id=$1",
        [artifact.id],
      );
    }
  }
  await infra.pool.query(
    "DELETE FROM archive_batches WHERE status='deleted' AND delete_after<=now()",
  );
  await infra.pool.query(
    "DELETE FROM artifacts WHERE status='deleted' AND expire_at<=now()-interval '7 days'",
  );
  await infra.pool.query("DELETE FROM positions_latest WHERE observed_at<now()-interval '30 days'");
  await infra.pool.query('DELETE FROM processor_position_state WHERE expire_at<=now()');
  await infra.pool.query('DELETE FROM position_quality_decisions WHERE expire_at<=now()');
  await infra.pool.query('DELETE FROM replay_processed_manifests WHERE expire_at<=now()');
}
