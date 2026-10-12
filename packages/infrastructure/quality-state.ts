import type { NormalizedObservation, PositionObservation } from '@ais/contracts';
import { flagPositionJump, isNewerPosition } from '@ais/domain';
import type { Infrastructure } from './clients';

/** Persist one current point per MMSI and only exceptional decisions, never a full observation ledger. */
export async function assessPositionQualityBatch(
  infra: Infrastructure,
  observations: readonly NormalizedObservation[],
): Promise<NormalizedObservation[]> {
  const positions = observations.filter((o): o is PositionObservation => o.kind === 'position');
  if (!positions.length) return [...observations];
  const first = new Map<string, PositionObservation>();
  for (const position of positions) if (!first.has(position.mmsi)) first.set(position.mmsi, position);
  const client = await infra.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO processor_position_state(mmsi,observation,expire_at)
       SELECT p->>'mmsi',p,(p->>'receivedAt')::timestamptz+interval '30 days'
       FROM jsonb_array_elements($1::jsonb) p ORDER BY p->>'mmsi'
       ON CONFLICT(mmsi) DO NOTHING`, [JSON.stringify([...first.values()])],
    );
    const states = await client.query<{ mmsi: string; observation: PositionObservation; expire_at: Date }>(
      'SELECT mmsi,observation,expire_at FROM processor_position_state WHERE mmsi=ANY($1::text[]) ORDER BY mmsi FOR UPDATE', [[...first.keys()].sort()],
    );
    const current = new Map(states.rows.map((row) => [row.mmsi, row.observation]));
    const previousDecisions = await client.query<{ event_id: string; quality: string[] }>(
      'SELECT event_id,quality FROM position_quality_decisions WHERE cleaning_version=1 AND event_id=ANY($1::text[]) AND expire_at>now()', [positions.map((p) => p.eventId)],
    );
    const decisions = new Map(previousDecisions.rows.map((row) => [row.event_id, row.quality]));
    const exceptional = new Map<string, PositionObservation>();
    const result = observations.map((observation) => {
      if (observation.kind !== 'position') return observation;
      const priorDecision = decisions.get(observation.eventId);
      const previous = current.get(observation.mmsi) ?? null;
      const marked = priorDecision
        ? { ...observation, quality: [...new Set([...observation.quality, ...priorDecision])] }
        : flagPositionJump(previous, observation);
      if (marked.quality.includes('implausible_jump')) {
        exceptional.set(marked.eventId, marked);
        decisions.set(marked.eventId, marked.quality);
      }
      if (isNewerPosition(marked, previous)) current.set(marked.mmsi, marked);
      return marked;
    });
    await client.query(
      `UPDATE processor_position_state s SET observation=p,expire_at=(p->>'receivedAt')::timestamptz+interval '30 days'
       FROM jsonb_array_elements($1::jsonb) p WHERE s.mmsi=p->>'mmsi'`, [JSON.stringify([...current.values()])],
    );
    if (exceptional.size) await client.query(
      `INSERT INTO position_quality_decisions(cleaning_version,event_id,quality,expire_at)
       SELECT (p->>'cleaningVersion')::int,p->>'eventId',p->'quality',(p->>'receivedAt')::timestamptz+interval '90 days'
       FROM jsonb_array_elements($1::jsonb) p ON CONFLICT(cleaning_version,event_id) DO NOTHING`, [JSON.stringify([...exceptional.values()])],
    );
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
