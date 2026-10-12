import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInfrastructure, saveLatestBatch, type Infrastructure } from '@ais/infrastructure';
import type { PositionObservation } from '@ais/contracts';
import { MapController } from './controller';
import { VesselsController } from '../vessels/controller';
const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;
suite('real PostGIS global, wide and date line map queries and retention', () => {
  let infra: Infrastructure;
  const sourceId = `geometry-${Date.now()}`;
  const mmsis = ['999100001','999100002','999100003','999100004'];
  const observedAt = new Date().toISOString();
  beforeAll(async () => {
    infra = await createInfrastructure();
    await saveLatestBatch(infra, [-170,-40,40,170].map((lon, i): PositionObservation => ({
      schemaVersion:1,cleaningVersion:1,kind:'position',eventId:`${sourceId}-${i}`,captureId:`${sourceId}-${i}`,sourceId,sourceKind:'fixture-http',sourcePriority:100,runId:null,observedAt,receivedAt:observedAt,mmsi:mmsis[i]!,lat:0,lon,sogKnots:null,cogDegrees:null,headingDegrees:null,rotDegPerMinute:null,navigationStatus:null,receptionType:'UNKNOWN',quality:['synthetic'],
    })));
  });
  afterAll(async () => {
    if (!infra) return;
    await infra.pool.query('DELETE FROM positions_latest WHERE source_id=$1',[sourceId]);
    await infra.pool.query('DELETE FROM vessels WHERE mmsi=ANY($1::text[])',[mmsis]);
    await infra.close();
  });
  it('returns all four world positions with a global rectangle', async () => {
    const result = await new MapController(infra).get({bbox:'-180,-90,180,90',zoom:8,sourceId});
    expect(result.total).toBe(4);
  });
  it('preserves the wide 240-degree rectangle instead of using the complementary region', async () => {
    const result = await new MapController(infra).get({bbox:'-120,-10,120,10',zoom:8,sourceId});
    expect(result.total).toBe(2);
    expect(result.items.map((p)=>p.kind==='point'?p.lon:null)).toEqual([-40,40]);
  });
  it('splits a crossing rectangle and includes both date-line edges', async () => {
    const result = await new MapController(infra).get({bbox:'160,-10,-160,10',zoom:8,sourceId});
    expect(result.total).toBe(2);
  });
  it('returns a vessel with null latestPosition immediately after 30-day expiry', async () => {
    await infra.pool.query("UPDATE positions_latest SET observed_at=now()-interval '31 days' WHERE mmsi=$1",[mmsis[0]]);
    expect((await new VesselsController(infra).detail(mmsis[0]!)).latestPosition).toBeNull();
    expect((await new VesselsController(infra).list({mmsi:mmsis[0]})).items[0]!.latestPosition).toBeNull();
  });
});
