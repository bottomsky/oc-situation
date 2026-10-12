import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalRawJson, createRawEnvelope, loadRawPayload, publishNormalized } from './bus';
import type { Infrastructure } from './clients';

describe('raw integrity and normalized topology', () => {
  it('creates per-payload inline checksum and refuses modified contents', async () => {
    const infra = {} as Infrastructure;
    const raw = await createRawEnvelope(infra, {
      sourceId: 'fixture',
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      sourcePriority: 100,
      runId: null,
      payload: { value: '船' },
    });
    expect(raw).toHaveProperty(
      'checksum',
      createHash('sha256')
        .update(JSON.stringify({ value: '船' }))
        .digest('hex'),
    );
    expect(raw.checksumEncoding).toBe('canonical-json-v1');
    await expect(
      loadRawPayload(infra, { ...raw, payload: { kind: 'inline', value: { value: 'changed' } } }),
    ).rejects.toThrow('checksum');
  });
  it('sorts nested keys without changing array order, and rejects non-JSON values', () => {
    expect(canonicalRawJson({ z: 1, a: [{ z: '船', a: true }, null] })).toBe(
      '{"a":[{"a":true,"z":"船"},null],"z":1}',
    );
    expect(canonicalRawJson({ a: [1, 2] })).not.toBe(canonicalRawJson({ a: [2, 1] }));
    expect(() => canonicalRawJson({ a: undefined })).toThrow('JSON');
    const sparse = Array(2);
    sparse[1] = 1;
    expect(() => canonicalRawJson(sparse)).toThrow('JSON');
    expect(() => canonicalRawJson({ a: Infinity })).toThrow('JSON');
  });
  it('rejects normalized publishing when writer topology is missing', async () => {
    let published = false;
    const infra = {
      jsm: {
        streams: {
          info: async () => {
            throw new Error('missing');
          },
        },
        consumers: {
          info: async () => {
            throw new Error('missing');
          },
        },
      },
      js: {
        publish: async () => {
          published = true;
        },
      },
    } as unknown as Infrastructure;
    const observation = {
      schemaVersion: 1 as const,
      cleaningVersion: 1 as const,
      kind: 'quarantine' as const,
      eventId: 'e',
      captureId: 'c',
      sourceId: 'fixture',
      sourceKind: 'fixture-http' as const,
      sourcePriority: 100,
      runId: null,
      receivedAt: new Date().toISOString(),
      observedAt: null,
      mmsi: null,
      quality: [],
      reasons: ['test'],
    };
    await expect(publishNormalized(infra, observation)).rejects.toThrow(
      'Normalized publication paused',
    );
    expect(published).toBe(false);
  });
});
