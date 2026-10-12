import type { NormalizedObservation } from '@ais/contracts';
import type { Infrastructure } from './clients';
import { compressSequences, containsSequence } from './archive-engine';
export interface ProcessingCounts { normalizedCaptures: number; records: number; positions: number; statics: number; quarantined: number }
export const emptyProcessingCounts = (): ProcessingCounts => ({ normalizedCaptures: 0, records: 0, positions: 0, statics: 0, quarantined: 0 });
export function observationCounts(observations: readonly NormalizedObservation[]): ProcessingCounts {
  return { normalizedCaptures: 1, records: observations.length,
    positions: observations.filter((o) => o.kind === 'position').length,
    statics: observations.filter((o) => o.kind === 'static').length,
    quarantined: observations.filter((o) => o.kind === 'quarantine').length };
}
export interface ProcessedCapture { sequence: number; runId: string | null; counts: ProcessingCounts }
/** Merge interval endpoints without expanding millions of already confirmed sequence numbers. */
export function mergeSequenceRanges(ranges: readonly [number, number][], sequences: readonly number[]): [number, number][] {
  const sorted = [...ranges, ...compressSequences(sequences)].sort((a,b) => a[0]-b[0]);
  const merged: [number,number][] = [];
  for (const [start,end] of sorted) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1],end);
    else merged.push([start,end]);
  }
  return merged;
}
async function incrementRunCounts(client: import('pg').PoolClient, counts: Map<string, ProcessingCounts>) {
  if (!counts.size) return;
  await client.query(
    `UPDATE runs r SET counters=r.counters || jsonb_build_object(
      'normalizedCaptures',coalesce((r.counters->>'normalizedCaptures')::bigint,0)+(p->>'normalizedCaptures')::bigint,
      'records',coalesce((r.counters->>'records')::bigint,0)+(p->>'records')::bigint,
      'positions',coalesce((r.counters->>'positions')::bigint,0)+(p->>'positions')::bigint,
      'statics',coalesce((r.counters->>'statics')::bigint,0)+(p->>'statics')::bigint,
      'quarantined',coalesce((r.counters->>'quarantined')::bigint,0)+(p->>'quarantined')::bigint
    ),updated_at=now() FROM jsonb_array_elements($1::jsonb) p WHERE r.id=(p->>'runId')::uuid`,
    [JSON.stringify([...counts].map(([runId,value]) => ({runId,...value})))],
  );
}
function addCounts(target: ProcessingCounts, value: ProcessingCounts) {
  for (const key of Object.keys(target) as (keyof ProcessingCounts)[]) target[key] += value[key];
}
export async function recordProcessedCaptures(infra: Infrastructure, captures: readonly ProcessedCapture[]): Promise<void> {
  if (!captures.length) return;
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("INSERT INTO processor_progress(id) VALUES('raw-cleaner') ON CONFLICT DO NOTHING");
    const rows = await client.query<{ ranges: [number,number][] }>("SELECT ranges FROM processor_progress WHERE id='raw-cleaner' FOR UPDATE");
    const ranges = rows.rows[0]!.ranges;
    const fresh = captures.filter((c) => !containsSequence(ranges,c.sequence));
    const seen = new Set<number>();
    const counts = new Map<string,ProcessingCounts>();
    for (const capture of fresh) {
      if (seen.has(capture.sequence)) continue;
      seen.add(capture.sequence);
      if (!capture.runId) continue;
      const value = counts.get(capture.runId) ?? emptyProcessingCounts();
      addCounts(value,capture.counts); counts.set(capture.runId,value);
    }
    await incrementRunCounts(client,counts);
    await client.query("UPDATE processor_progress SET ranges=$1::jsonb,updated_at=now() WHERE id='raw-cleaner'",[JSON.stringify(mergeSequenceRanges(ranges,[...seen]))]);
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
export async function recordReplayManifest(infra: Infrastructure, runId: string, manifestId: string, counts: ProcessingCounts, expireAt: string): Promise<void> {
  const client=await infra.pool.connect();
  try {
    await client.query('BEGIN');
    const inserted=await client.query('INSERT INTO replay_processed_manifests(run_id,manifest_id,counters,expire_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT DO NOTHING RETURNING run_id',[runId,manifestId,JSON.stringify(counts),expireAt]);
    if (inserted.rowCount) await incrementRunCounts(client,new Map([[runId,counts]]));
    await client.query('COMMIT');
  } catch(error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
