import { parseRawEnvelope, type RawEnvelope } from '@ais/contracts';
import { isDeepStrictEqual } from 'node:util';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { verifyRawIntegrity } from './bus';
export interface ArchiveEntry {
  raw: RawEnvelope;
  sequence: number;
  ack(): void;
}
export interface ArchiveManifest {
  id: string;
  bucket: string;
  objectKey: string;
  status: 'prepared' | 'committed';
  rawRecords: { raw: RawEnvelope; sequence: number; rawJson?: string }[];
  firstSequence: number;
  lastSequence: number;
  sequenceRanges: [number, number][];
  checksum?: string;
}
export interface ArchivePorts {
  prepare(entries: readonly ArchiveEntry[]): Promise<ArchiveManifest>;
  upload(manifest: ArchiveManifest, body: Uint8Array, checksum: string): Promise<void>;
  commit(manifest: ArchiveManifest, checksum: string, bytes: number): Promise<void>;
}
export function containsSequence(ranges: readonly [number, number][], sequence: number): boolean {
  return ranges.some(([first, last]) => first <= sequence && sequence <= last);
}
export function compressSequences(sequences: readonly number[]): [number, number][] {
  const result: [number, number][] = [];
  for (const sequence of [...new Set(sequences)].sort((a, b) => a - b)) {
    const previous = result.at(-1);
    if (previous && previous[1] + 1 === sequence) previous[1] = sequence;
    else result.push([sequence, sequence]);
  }
  return result;
}
export async function archiveBatch(
  ports: ArchivePorts,
  entries: readonly ArchiveEntry[],
): Promise<number> {
  if (!entries.length) return 0;
  for (const entry of entries) verifyRawIntegrity(entry.raw);
  const manifest = await ports.prepare(entries);
  if (manifest.status === 'prepared') {
    const jsonl =
      manifest.rawRecords
        .sort((a, b) => a.sequence - b.sequence)
        .map((entry) => {
          const original =
            entry.rawJson === undefined ? entry.raw : (JSON.parse(entry.rawJson) as RawEnvelope);
          if (!isDeepStrictEqual(original, entry.raw))
            throw new Error('Archived raw serialization disagrees with indexed envelope');
          verifyRawIntegrity(parseRawEnvelope(original));
          return entry.rawJson ?? JSON.stringify(original);
        })
        .join('\n') + '\n';
    const body = gzipSync(Buffer.from(jsonl));
    const checksum = createHash('sha256').update(body).digest('hex');
    await ports.upload(manifest, body, checksum);
    await ports.commit(manifest, checksum, body.length);
  }
  let count = 0;
  for (const entry of entries)
    if (containsSequence(manifest.sequenceRanges, entry.sequence)) {
      entry.ack();
      count++;
    }
  return count;
}
