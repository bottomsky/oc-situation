import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfrastructure, type Infrastructure } from './clients';
import { runMigrations } from './migrations';
import { queryAgentVessels } from './agent-query';

describe('agent vessel query on real PostgreSQL', () => {
  let infra: Infrastructure;
  const source = `query-${randomUUID()}`;
  const base = randomInt(800_000_000, 899_999_000);
  const mmsis = Array.from({ length: 103 }, (_, i) => String(base + i));
  beforeAll(async () => {
    infra = await createInfrastructure();
    await runMigrations(infra);
    for (const [index, mmsi] of mmsis.entries()) {
      await infra.pool.query('INSERT INTO vessels(mmsi,name,ship_type) VALUES($1,$2,70)', [
        mmsi,
        `query vessel ${index}`,
      ]);
      const lon = index % 2 ? 175 : -175;
      await infra.pool.query(
        `INSERT INTO positions_latest(mmsi,event_id,capture_id,source_id,source_kind,source_priority,observed_at,received_at,cleaning_version,latitude,longitude,location,observation)
        VALUES($1,$1,$1,$2,'synthetic',1,now()-make_interval(hours=>$4),now(),1,40,$3,ST_SetSRID(ST_MakePoint($3,40),4326)::geography,'{}')`,
        [mmsi, source, lon, index === 102 ? 48 : 1],
      );
    }
  });
  afterAll(async () => {
    if (!infra) return;
    await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=ANY($1::text[])', [mmsis]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])', [mmsis]);
    await infra.close();
  });
  it('returns exact count above 100 and bounded items across the date line', async () => {
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 2,
      selection: {
        bbox: [170, 39, -170, 41],
        filters: { sourceId: source, hours: 24, shipType: 70 },
      },
    });
    expect(result.total).toBe(102);
    expect(result.items).toHaveLength(100);
    expect(result.truncated).toBe(true);
    expect(result.items.some((item) => item.latestPosition!.lon === 175)).toBe(true);
    expect(result.items.some((item) => item.latestPosition!.lon === -175)).toBe(true);
  });
  it('applies vessel selection, source, type and rectangle together', async () => {
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        bbox: [174, 39, 176, 41],
        mmsis: [mmsis[0]!, mmsis[1]!],
        filters: { sourceId: source, shipType: 70 },
      },
    });
    expect(result.total).toBe(1);
    expect(result.items[0]!.mmsi).toBe(mmsis[1]);
  });
  it('keeps static details without recent position and returns genuine empty results', async () => {
    const detail = await queryAgentVessels(infra, {
      kind: 'vessel_detail',
      inputRevision: 0,
      selection: { mmsis: [mmsis[102]!] },
    });
    expect(detail.total).toBe(1);
    expect(detail.items[0]!.latestPosition).toBeNull();
    const empty = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: { bbox: [100, 0, 101, 1], filters: { sourceId: source } },
    });
    expect(empty.total).toBe(0);
    expect(empty.items).toEqual([]);
    expect(empty.truncated).toBe(false);
  });
});
