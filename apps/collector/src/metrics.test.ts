import { expect, it } from 'vitest';
import { Registry } from 'prom-client';
import { createAcquisitionMetrics } from './metrics';
it('exports bounded acquisition metrics without source or secret labels', async () => {
  const registry = new Registry();
  const metrics = createAcquisitionMetrics(registry);
  metrics.captures.inc();
  metrics.requests.inc();
  metrics.activeRuns.inc();
  metrics.lastReceived.set(42);
  expect(await registry.metrics()).toContain('ais_captures_total 1');
  expect(await registry.metrics()).toContain('ais_active_runs 1');
});
