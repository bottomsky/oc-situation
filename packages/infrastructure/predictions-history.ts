import { parseNormalizedObservation } from '../contracts';
import type { PositionObservation } from '../contracts';
import type { Infrastructure } from './clients';

/** Deterministic bounded training selection; [asOf-24h,asOf-60m) excludes the live input window. */
export async function readPredictionTrainingHistory(
  infra: Infrastructure,
  mmsi: string,
  asOf: string,
  signal?: AbortSignal,
) {
  const from = new Date(Date.parse(asOf) - 24 * 3600000).toISOString();
  const to = new Date(Date.parse(asOf) - 3600000).toISOString();
  const response = await infra.clickhouse.query({
    query:
      'SELECT observation FROM positions FINAL WHERE mmsi={mmsi:String} AND observedAt>=parseDateTime64BestEffort({from:String}) AND observedAt<parseDateTime64BestEffort({to:String}) ORDER BY observedAt DESC,eventId DESC LIMIT 5000',
    query_params: { mmsi, from, to },
    format: 'JSONEachRow',
    abort_signal: signal,
    clickhouse_settings: {
      max_result_bytes: '16777216',
      result_overflow_mode: 'throw',
      max_execution_time: 15,
    },
  });
  const rows = await response.json<{ observation: string }>();
  const observations = rows
    .map((row) => parseNormalizedObservation(JSON.parse(row.observation)))
    .filter(
      (observation): observation is PositionObservation =>
        observation.kind === 'position' && Date.parse(observation.observedAt) < Date.parse(to),
    );
  return { from, to, selection: 'latest_5000_single_vessel' as const, observations };
}
