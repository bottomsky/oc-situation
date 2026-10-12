import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PositionObservation, StaticObservation, QuarantineObservation } from '@ais/contracts';
import { createInfrastructure, runMigrations, assessPositionQualityBatch, saveLatestBatch, saveHistoryBatch, recordProcessedCaptures, observationCounts, updateRunStatus, acquireLease, releaseLease, checkpointSource, recordSourceGap, type Infrastructure } from './index';
const suite = process.env.AIS_TEST_SCOPE === 'integration' ? describe : describe.skip;
const sourceId=`reliability-${randomUUID()}`;
const runId=randomUUID();
const mmsi=String(970000000+Math.floor(Math.random()*9000000));
const now=new Date().toISOString();
const base: PositionObservation={ schemaVersion:1,cleaningVersion:1,kind:'position',eventId:'placeholder',captureId:'c',sourceId,sourceKind:'fixture-http',sourcePriority:100,runId,receivedAt:now,observedAt:now,mmsi,lat:33,lon:124,sogKnots:null,cogDegrees:null,headingDegrees:null,rotDegPerMinute:null,navigationStatus:null,receptionType:'UNKNOWN',quality:['synthetic'] };
suite('post-review durable data invariants',()=>{
  let infra:Infrastructure;
  beforeAll(async()=>{infra=await createInfrastructure();await runMigrations(infra);await infra.pool.query("INSERT INTO sources(id,name,kind) VALUES($1,'test','fixture-http')",[sourceId]);await infra.pool.query("INSERT INTO runs(id,source_id,status) VALUES($1,$2,'running')",[runId,sourceId]);});
  afterAll(async()=>{if(!infra)return;await infra.pool.query('DELETE FROM replay_processed_manifests WHERE run_id=$1',[runId]);await infra.pool.query('DELETE FROM source_gaps WHERE source_id=$1',[sourceId]);await infra.pool.query('DELETE FROM source_checkpoints WHERE source_id=$1',[sourceId]);await infra.pool.query('DELETE FROM runs WHERE id=$1',[runId]);await infra.pool.query('DELETE FROM sources WHERE id=$1',[sourceId]);await infra.pool.query('DELETE FROM positions_latest WHERE mmsi=$1',[mmsi]);await infra.pool.query('DELETE FROM vessels WHERE mmsi=$1',[mmsi]);await infra.pool.query('DELETE FROM processor_position_state WHERE mmsi=$1',[mmsi]);await infra.close();});
  it('assesses every adjacent batch position, retains decisions on re-delivery and shares quality across both stores',async()=>{
    const a={...base,eventId:randomUUID()};
    const b={...base,eventId:randomUUID(),observedAt:new Date(Date.parse(now)+60000).toISOString(),lat:-30,lon:-70};
    const c={...base,eventId:randomUUID(),observedAt:new Date(Date.parse(now)+120000).toISOString(),lat:-30.001,lon:-70.001};
    const assessed=await assessPositionQualityBatch(infra,[a,b,c]);
    expect(assessed[1]?.quality).toContain('implausible_jump');
    expect(assessed[2]?.quality).not.toContain('implausible_jump');
    expect((await assessPositionQualityBatch(infra,[a,b,c])).map(o=>o.quality)).toEqual(assessed.map(o=>o.quality));
    await saveLatestBatch(infra,assessed);await saveHistoryBatch(infra,assessed);
    const response=await infra.clickhouse.query({query:'SELECT quality FROM positions FINAL WHERE eventId={id:String}',query_params:{id:b.eventId},format:'JSONEachRow'});
    expect((await response.json<{quality:string[]}>())[0]?.quality).toContain('implausible_jump');
  });
  it('deduplicates unknown-time static, quarantine and quality across captures with different receive times',async()=>{
    const staticObservation:StaticObservation={schemaVersion:1,cleaningVersion:1,kind:'static',eventId:randomUUID(),captureId:'first',sourceId,sourceKind:'fixture-http',sourcePriority:100,runId,receivedAt:now,observedAt:null,mmsi,quality:['unknown_observation_time'],fields:{name:'test'}};
    const quarantine:QuarantineObservation={...staticObservation,kind:'quarantine',eventId:randomUUID(),mmsi:null,reasons:['invalid_mmsi']};
    const { fields: _fields,...q }=quarantine as QuarantineObservation & {fields?:unknown};
    await saveHistoryBatch(infra,[staticObservation,q]);
    await saveHistoryBatch(infra,[{...staticObservation,captureId:'second',receivedAt:new Date(Date.parse(now)+60000).toISOString()},{...q,captureId:'second',receivedAt:new Date(Date.parse(now)+60000).toISOString()},{...base,eventId:randomUUID()}]);
    for(const table of ['static_history_v2','quarantine_v2','quality_events_v2']){
      const id=table==='quarantine_v2'?q.eventId:staticObservation.eventId;
      const response=await infra.clickhouse.query({query:`SELECT count() count FROM ${table} FINAL WHERE eventId={id:String}`,query_params:{id},format:'JSONEachRow'});
      expect(Number((await response.json<{count:number}>())[0]?.count)).toBe(1);
    }
  });
  it('commits run counts exactly once after a publish-before-ACK crash and retains terminal status under stale owner',async()=>{
    const sequence=920000000+Math.floor(Math.random()*1000000);
    const processed={sequence,runId,counts:observationCounts([base])};
    await recordProcessedCaptures(infra,[processed,processed]);await recordProcessedCaptures(infra,[processed]);
    const counters=(await infra.pool.query('SELECT counters FROM runs WHERE id=$1',[runId])).rows[0].counters;
    expect(counters).toMatchObject({positions:1,quarantined:0,records:1,normalizedCaptures:1});
    const name=`source:${sourceId}`;const first=await acquireLease(infra,name,'old',30);expect(first).not.toBeNull();await releaseLease(infra,first!);
    const next=await acquireLease(infra,name,'new',30);expect(next).not.toBeNull();
    await expect(updateRunStatus(infra,runId,'failed','stale',first!)).rejects.toThrow('Lease ownership lost');
    await expect(checkpointSource(infra,sourceId,{cursor:'stale'},first!)).rejects.toThrow('lease ownership lost');
    await recordSourceGap(infra,{sourceId,runId,from:now,to:now,reason:'disconnect'},next!);
    expect(await updateRunStatus(infra,runId,'cancelled',undefined,next!)).toBe(true);
    expect(await updateRunStatus(infra,runId,'succeeded',undefined,next!)).toBe(false);
    expect((await infra.pool.query('SELECT status FROM runs WHERE id=$1',[runId])).rows[0].status).toBe('cancelled');await releaseLease(infra,next!);
  });
});
