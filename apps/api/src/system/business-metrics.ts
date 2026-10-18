import { Gauge, type Registry } from 'prom-client';
import type { Infrastructure } from '@ais/infrastructure';
/** Read durable aggregate state at scrape time. Labels are closed enums, never business IDs. */
export function registerBusinessMetrics(registry: Registry, infra: Pick<Infrastructure, 'pool'>) {
  const plans = new Gauge({
    name: 'ais_route_plans',
    help: 'Durable route plans by status',
    labelNames: ['status'],
    registers: [registry],
  });
  const duration = new Gauge({
    name: 'ais_route_plan_duration_seconds_sum',
    help: 'Sum of elapsed execution seconds of terminal route plans',
    registers: [registry],
  });
  const pending = new Gauge({
    name: 'ais_event_sync_pending',
    help: 'Unapplied event source snapshots',
    registers: [registry],
  });
  const lag = new Gauge({
    name: 'ais_event_sync_lag_seconds',
    help: 'Age of oldest unapplied event snapshot in seconds',
    registers: [registry],
  });
  const failures = new Gauge({
    name: 'ais_event_sync_failed_attempts',
    help: 'Persisted failed synchronization attempts',
    registers: [registry],
  });
  const receipts = new Gauge({
    name: 'ais_business_operation_receipts',
    help: 'Durable idempotent business operation receipts',
    labelNames: ['kind'],
    registers: [registry],
  });
  const focus = new Gauge({
    name: 'ais_focus_ui_failures',
    help: 'Focus commands with failed or rejected UI outcome',
    registers: [registry],
  });
  return async () => {
    const result = await infra.pool.query(`SELECT
      (SELECT count(*) FROM route_plans WHERE status='queued') queued,
      (SELECT count(*) FROM route_plans WHERE status='running') running,
      (SELECT count(*) FROM route_plans WHERE status='completed') completed,
      (SELECT count(*) FROM route_plans WHERE status='failed') failed,
      (SELECT count(*) FROM route_plans WHERE status='cancelled') cancelled,
      (SELECT COALESCE(sum(EXTRACT(epoch FROM updated_at-claimed_at)),0) FROM route_plans WHERE status IN ('completed','failed','cancelled') AND claimed_at IS NOT NULL) duration_seconds,
      (SELECT count(*) FROM event_sync_outbox WHERE applied_at IS NULL) pending,
      (SELECT COALESCE(EXTRACT(epoch FROM now()-min(created_at)),0) FROM event_sync_outbox WHERE applied_at IS NULL) lag_seconds,
      (SELECT COALESCE(sum(attempts-CASE WHEN applied_at IS NULL THEN 0 ELSE 1 END),0) FROM event_sync_outbox) failures,
      (SELECT count(*) FROM route_operation_receipts) route_receipts,
      (SELECT count(*) FROM operational_event_operations) event_receipts,
      (SELECT count(*) FROM agent_ui_commands WHERE operation->>'componentId'='chart.focus' AND status IN ('failed','rejected')) focus_failures`);
    const row = result.rows[0];
    for (const status of ['queued', 'running', 'completed', 'failed', 'cancelled'])
      plans.set({ status }, Number(row[status]));
    duration.set(Number(row.duration_seconds));
    pending.set(Number(row.pending));
    lag.set(Number(row.lag_seconds));
    failures.set(Number(row.failures));
    receipts.set({ kind: 'route' }, Number(row.route_receipts));
    receipts.set({ kind: 'event' }, Number(row.event_receipts));
    focus.set(Number(row.focus_failures));
  };
}
