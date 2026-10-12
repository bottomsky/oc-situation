import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { createHash } from 'node:crypto';
import { createRawEnvelope, loadRawPayload } from './bus';
import { loadConfig } from './config';
import type { Infrastructure } from './clients';

const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;
suite('raw checksum survives PostgreSQL JSONB', () => {
  it('verifies nested source JSON after a real JSONB roundtrip and still rejects tampering', async () => {
    const pool = new pg.Pool({ connectionString: loadConfig().databaseUrl });
    try {
      const payload = { z: 1, a: { longer: 2, b: [{ z: '船', a: 3 }] } };
      const raw = await createRawEnvelope({} as Infrastructure, {
        sourceId: 'checksum-roundtrip',
        sourceKind: 'fixture-http',
        adapterVersion: '1',
        runId: null,
        sourcePriority: 100,
        payload,
      });
      const result = await pool.query('SELECT $1::jsonb AS envelope', [JSON.stringify(raw)]);
      const persisted = result.rows[0].envelope;
      expect(JSON.stringify(persisted.payload.value)).not.toBe(JSON.stringify(payload));
      await expect(loadRawPayload({} as Infrastructure, persisted)).resolves.toEqual(payload);
      persisted.payload.value.a.b[0].z = 'modified';
      await expect(loadRawPayload({} as Infrastructure, persisted)).rejects.toThrow('checksum');
    } finally {
      await pool.end();
    }
  });
  it('keeps legacy stringify checksums strict instead of accepting reordered or changed data', async () => {
    const payload = { z: 1, a: 2 };
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const raw = await createRawEnvelope({} as Infrastructure, {
      sourceId: 'legacy',
      sourceKind: 'fixture-http',
      adapterVersion: '1',
      runId: null,
      sourcePriority: 100,
      payload,
    });
    const legacy = {
      ...raw,
      checksum,
      checksumEncoding: undefined,
      payload: { kind: 'inline' as const, value: payload },
    };
    await expect(loadRawPayload({} as Infrastructure, legacy)).resolves.toEqual(payload);
    await expect(
      loadRawPayload({} as Infrastructure, {
        ...legacy,
        payload: { kind: 'inline', value: { a: 2, z: 1 } },
      }),
    ).rejects.toThrow('checksum');
  });
});
