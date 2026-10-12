import { randomUUID } from 'node:crypto';
import { SourceSettingsSchema, type SourceConfig } from '@ais/contracts';
import type { Infrastructure } from './clients';
import { toCamelRow } from './recovery';
import { assertCollectionReady } from './bus';

export async function getSource(
  infra: Infrastructure,
  sourceId: string,
): Promise<SourceConfig | null> {
  const result = await infra.pool.query('SELECT * FROM sources WHERE id=$1', [sourceId]);
  const row = result.rows[0];
  return row
    ? {
        sourceId: row.id,
        sourceKind: row.kind,
        name: row.name,
        status: row.status === 'error' ? 'error' : row.enabled ? 'enabled' : 'disabled',
        priority: row.priority,
        secretRef: row.secret_ref,
        ...(row.config.endpoint ? { endpoint: row.config.endpoint } : {}),
        ...(row.config.bbox ? { bbox: row.config.bbox } : {}),
        ...(row.config.settings
          ? { settings: SourceSettingsSchema.parse(row.config.settings) }
          : {}),
      }
    : null;
}
export async function getRun(infra: Infrastructure, runId: string) {
  const result = await infra.pool.query('SELECT * FROM runs WHERE id=$1', [runId]);
  return result.rows[0] ? toCamelRow(result.rows[0]) : null;
}
export interface Lease {
  name: string;
  owner: string;
  fencingToken: string;
  expiresAt: string;
}
export class LeaseFencedError extends Error {}
export class RunTerminalError extends Error {}
const leasePredicate = 'EXISTS(SELECT 1 FROM leases WHERE name=$3 AND owner=$4 AND fencing_token=$5 AND expires_at>now())';
export async function assertLease(infra: Infrastructure, lease: Lease): Promise<void> {
  const result=await infra.pool.query('SELECT 1 FROM leases WHERE name=$1 AND owner=$2 AND fencing_token=$3 AND expires_at>now()', [lease.name,lease.owner,lease.fencingToken]);
  if (!result.rowCount) throw new LeaseFencedError('Lease ownership lost');
}
export async function acquireLease(
  infra: Infrastructure,
  name: string,
  owner: string = randomUUID(),
  seconds = 30,
): Promise<Lease | null> {
  const result = await infra.pool.query(
    `INSERT INTO leases(name,owner,expires_at) VALUES($1,$2,now()+make_interval(secs=>$3)) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at,fencing_token=leases.fencing_token+1 WHERE leases.expires_at <= now() RETURNING *`,
    [name, owner, seconds],
  );
  return result.rows[0] ? toCamelRow<Lease>(result.rows[0]) : null;
}
export async function renewLease(
  infra: Infrastructure,
  lease: Lease,
  seconds = 30,
): Promise<boolean> {
  const result = await infra.pool.query(
    'UPDATE leases SET expires_at=now()+make_interval(secs=>$4) WHERE name=$1 AND owner=$2 AND fencing_token=$3 AND expires_at>now()',
    [lease.name, lease.owner, lease.fencingToken, seconds],
  );
  return result.rowCount === 1;
}
export async function releaseLease(infra: Infrastructure, lease: Lease): Promise<void> {
  await infra.pool.query(
    'UPDATE leases SET expires_at=now() WHERE name=$1 AND owner=$2 AND fencing_token=$3',
    [lease.name, lease.owner, lease.fencingToken],
  );
}
export async function checkpointRun(
  infra: Infrastructure,
  runId: string,
  checkpoint: unknown,
  lease?: Lease,
): Promise<void> {
  const result = await infra.pool.query(
    `UPDATE runs SET checkpoint=$2::jsonb,updated_at=now() WHERE id=$1 AND status IN ('queued','running') ${lease ? `AND ${leasePredicate}` : ''}`,
    lease
      ? [runId, JSON.stringify(checkpoint), lease.name, lease.owner, lease.fencingToken]
      : [runId, JSON.stringify(checkpoint)],
  );
  if (result.rowCount !== 1) {
    if (lease) await assertLease(infra,lease);
    throw new RunTerminalError('Checkpoint rejected: run missing or terminal');
  }
}
export async function updateRunStatus(
  infra: Infrastructure,
  runId: string,
  status: string,
  error?: string,
  lease?: Lease,
): Promise<boolean> {
  const result=await infra.pool.query(
    `UPDATE runs SET status=$2,last_error=$3,started_at=CASE WHEN $2='running' THEN coalesce(started_at,now()) ELSE started_at END,finished_at=CASE WHEN $2 IN ('succeeded','failed','cancelled') THEN now() ELSE finished_at END,updated_at=now() WHERE id=$1 AND status IN ('queued','running') ${lease ? 'AND EXISTS(SELECT 1 FROM leases WHERE name=$4 AND owner=$5 AND fencing_token=$6 AND expires_at>now())' : ''}`,
    [runId, status, error ?? null,...(lease ? [lease.name,lease.owner,lease.fencingToken] : [])],
  );
  if (!result.rowCount && lease) await assertLease(infra,lease);
  return result.rowCount === 1;
}
export async function updateSourceStatus(infra: Infrastructure, sourceId: string, status: string, error: string | null, lease: Lease): Promise<void> {
  const result=await infra.pool.query('UPDATE sources SET status=$2,last_error=$6,updated_at=now() WHERE id=$1 AND '+leasePredicate,[sourceId,status,lease.name,lease.owner,lease.fencingToken,error]);
  if (!result.rowCount) { await assertLease(infra,lease); throw new Error('Source missing'); }
}
export async function checkpointSource(infra: Infrastructure, sourceId: string, checkpoint: unknown, lease: Lease): Promise<void> {
  const result=await infra.pool.query('INSERT INTO source_checkpoints(source_id,checkpoint) SELECT $1,$2::jsonb WHERE '+leasePredicate+' ON CONFLICT(source_id) DO UPDATE SET checkpoint=excluded.checkpoint,updated_at=now() RETURNING source_id',[sourceId,JSON.stringify(checkpoint),lease.name,lease.owner,lease.fencingToken]);
  if (!result.rowCount) throw new LeaseFencedError('Source checkpoint rejected: lease ownership lost');
}
export async function getSourceCheckpoint(infra: Infrastructure, sourceId: string): Promise<unknown|null> {
  return (await infra.pool.query('SELECT checkpoint FROM source_checkpoints WHERE source_id=$1',[sourceId])).rows[0]?.checkpoint ?? null;
}
export interface SourceGap { sourceId: string; runId: string|null; from: string; to: string; reason: string; status?: 'open'|'recovered'|'permanent' }
export async function recordSourceGap(infra: Infrastructure, gap: SourceGap, lease: Lease): Promise<string> {
  const result=await infra.pool.query(
    `INSERT INTO source_gaps(id,source_id,run_id,from_time,to_time,reason,status)
     SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM leases WHERE name=$8 AND owner=$9 AND fencing_token=$10 AND expires_at>now())
     ON CONFLICT(source_id,run_id,from_time,reason) DO UPDATE SET to_time=excluded.to_time,status=excluded.status,updated_at=now() RETURNING id`,
    [randomUUID(),gap.sourceId,gap.runId,gap.from,gap.to,gap.reason,gap.status ?? 'open',lease.name,lease.owner,lease.fencingToken],
  );
  if (!result.rowCount) throw new LeaseFencedError('Source gap rejected: lease ownership lost');
  return result.rows[0].id;
}
export async function flushOutbox(infra: Infrastructure): Promise<number> {
  const client = await infra.pool.connect();
  let count = 0;
  try {
    await client.query('BEGIN');
    const rows = await client.query(
      'SELECT * FROM outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 100 FOR UPDATE SKIP LOCKED',
    );
    for (const row of rows.rows) {
      if (row.subject.startsWith('ais.commands.')) await assertCollectionReady(infra);
      await infra.js.publish(row.subject, JSON.stringify(row.payload), { msgID: row.id });
      await client.query('UPDATE outbox SET published_at=now(),attempts=attempts+1 WHERE id=$1', [
        row.id,
      ]);
      count++;
    }
    await client.query('COMMIT');
    return count;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
