import { describe, expect, it } from 'vitest';
import {
  archiveBatch,
  type ArchiveEntry,
  type ArchiveManifest,
  type ArchivePorts,
} from './archive-engine';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
const raw = {
  schemaVersion: 1 as const,
  captureId: 'capture',
  sourceId: 'fixture',
  sourceKind: 'fixture-http' as const,
  adapterVersion: '1',
  runId: null,
  receivedAt: '2026-10-01T00:00:00.000Z',
  sourcePriority: 100,
  payload: { kind: 'inline' as const, value: { test: 1 } },
};
function fixture(status: 'prepared' | 'committed' = 'prepared') {
  const calls: string[] = [];
  let body: Uint8Array | undefined;
  const entry: ArchiveEntry = {
    raw,
    sequence: 101,
    ack() {
      calls.push('ack');
    },
  };
  const manifest: ArchiveManifest = {
    id: 'persistent-id',
    bucket: 'raw',
    objectKey: 'stable.jsonl.gz',
    status,
    firstSequence: 101,
    lastSequence: 101,
    sequenceRanges: [[101, 101]],
    rawRecords: [{ raw, sequence: 101 }],
  };
  const ports: ArchivePorts = {
    async prepare() {
      calls.push('prepare');
      return manifest;
    },
    async upload(m, bytes) {
      calls.push(`upload:${m.objectKey}`);
      body = bytes;
    },
    async commit() {
      calls.push('commit');
      manifest.status = 'committed';
      manifest.rawRecords = [];
    },
  };
  return { entry, manifest, ports, calls, body: () => body };
}
describe('archive durable commit and redelivery', () => {
  it('preserves legacy serialized envelopes when JSONB reordered the indexed copy', async () => {
    const f = fixture();
    const payload = { z: 1, a: { longer: 2, b: 3 } };
    const legacy = {
      ...raw,
      checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      payload: { kind: 'inline' as const, value: payload },
    };
    f.entry.raw = legacy;
    f.manifest.rawRecords = [
      {
        sequence: 101,
        raw: { ...legacy, payload: { kind: 'inline', value: { a: { b: 3, longer: 2 }, z: 1 } } },
        rawJson: JSON.stringify(legacy),
      },
    ];
    await archiveBatch(f.ports, [f.entry]);
    expect(JSON.parse(gunzipSync(f.body()!).toString().trim())).toEqual(legacy);
  });
  it.each(['metadata', 'payload'])(
    'rejects legacy rawJson when indexed %s disagrees, without uploading or acknowledging',
    async (changedField) => {
      const f = fixture();
      const legacy = {
        ...raw,
        checksum: createHash('sha256').update(JSON.stringify(raw.payload.value)).digest('hex'),
      };
      f.entry.raw = legacy;
      const indexed =
        changedField === 'metadata'
          ? { ...legacy, sourceId: 'different-source' }
          : { ...legacy, payload: { kind: 'inline' as const, value: { test: 2 } } };
      f.manifest.rawRecords = [{ sequence: 101, raw: indexed, rawJson: JSON.stringify(legacy) }];

      await expect(archiveBatch(f.ports, [f.entry])).rejects.toThrow(
        'Archived raw serialization disagrees with indexed envelope',
      );
      expect(f.calls).toEqual(['prepare']);
      expect(f.body()).toBeUndefined();
      expect(f.manifest.status).toBe('prepared');
    },
  );
  it('prepares, writes stable gzip JSONL, commits manifest then acknowledges', async () => {
    const f = fixture();
    expect(await archiveBatch(f.ports, [f.entry])).toBe(1);
    expect(f.calls).toEqual(['prepare', 'upload:stable.jsonl.gz', 'commit', 'ack']);
    expect(JSON.parse(gunzipSync(f.body()!).toString().trim())).toEqual(raw);
    expect(f.manifest.rawRecords).toEqual([]);
  });
  it('reuses the prepared object key after upload failure and does not acknowledge', async () => {
    const f = fixture();
    const normalUpload = f.ports.upload;
    f.ports.upload = async () => {
      throw new Error('S3 unavailable');
    };
    await expect(archiveBatch(f.ports, [f.entry])).rejects.toThrow('S3 unavailable');
    expect(f.calls).toEqual(['prepare']);
    f.ports.upload = normalUpload;
    await archiveBatch(f.ports, [f.entry]);
    expect(f.calls).toEqual(['prepare', 'prepare', 'upload:stable.jsonl.gz', 'commit', 'ack']);
  });
  it('acknowledges committed redelivery without uploading or preparing another random batch', async () => {
    const f = fixture('committed');
    await archiveBatch(f.ports, [f.entry]);
    expect(f.calls).toEqual(['prepare', 'ack']);
  });
  it('does not acknowledge a message beyond a recovered partial batch', async () => {
    const f = fixture();
    const outside: ArchiveEntry = {
      raw,
      sequence: 102,
      ack() {
        f.calls.push('wrong-ack');
      },
    };
    expect(await archiveBatch(f.ports, [f.entry, outside])).toBe(1);
    expect(f.calls).not.toContain('wrong-ack');
  });
  it('does not acknowledge late redelivery in a committed sequence range hole', async () => {
    const f = fixture('committed');
    f.manifest.lastSequence = 103;
    f.manifest.sequenceRanges = [
      [101, 101],
      [103, 103],
    ];
    const missing: ArchiveEntry = {
      raw,
      sequence: 102,
      ack() {
        f.calls.push('hole-ack');
      },
    };
    expect(await archiveBatch(f.ports, [f.entry, missing])).toBe(1);
    expect(f.calls).not.toContain('hole-ack');
  });
});
