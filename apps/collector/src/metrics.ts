import { Counter, Gauge, type Registry } from 'prom-client';
export function createAcquisitionMetrics(registry: Registry) {
  return {
    captures: new Counter({
      name: 'ais_captures_total',
      help: 'Raw source captures confirmed by the bus',
      registers: [registry],
    }),
    requests: new Counter({
      name: 'ais_source_requests_total',
      help: 'Source requests or incoming stream frames',
      registers: [registry],
    }),
    failures: new Counter({
      name: 'ais_source_failures_total',
      help: 'Failed source runs',
      registers: [registry],
    }),
    activeRuns: new Gauge({
      name: 'ais_active_runs',
      help: 'Active collection runs',
      registers: [registry],
    }),
    lastReceived: new Gauge({
      name: 'ais_last_received_timestamp_seconds',
      help: 'Last confirmed raw capture UTC seconds',
      registers: [registry],
    }),
  };
}
export type AcquisitionMetrics = ReturnType<typeof createAcquisitionMetrics>;
