type DemoWorkerSpec = {
  entry: string;
  metricsPort: number;
  metricsVariable: 'INTERNAL_METRICS_PORT' | 'METRICS_PORT';
  env?: NodeJS.ProcessEnv;
};

/** Workers share the host in the local demo, so every listener has a distinct owner. */
export const demoWorkers = {
  processor: {
    entry: 'apps/processor/main.ts',
    metricsPort: 13101,
    metricsVariable: 'INTERNAL_METRICS_PORT',
  },
  writerPostgres: {
    entry: 'apps/writer/main.ts',
    metricsPort: 13102,
    metricsVariable: 'INTERNAL_METRICS_PORT',
    env: { WRITER_TARGET: 'postgres' },
  },
  writerClickhouse: {
    entry: 'apps/writer/main.ts',
    metricsPort: 13103,
    metricsVariable: 'INTERNAL_METRICS_PORT',
    env: { WRITER_TARGET: 'clickhouse' },
  },
  archiver: {
    entry: 'apps/archiver/main.ts',
    metricsPort: 13104,
    metricsVariable: 'INTERNAL_METRICS_PORT',
  },
  collector: {
    entry: 'apps/collector/src/main.ts',
    metricsPort: 13105,
    metricsVariable: 'METRICS_PORT',
  },
  crawler: {
    entry: 'apps/crawler/src/main.ts',
    metricsPort: 13106,
    metricsVariable: 'METRICS_PORT',
  },
  intelligence: {
    entry: 'apps/intelligence/main.ts',
    metricsPort: 13107,
    metricsVariable: 'INTERNAL_METRICS_PORT',
  },
  topicPortRestriction: {
    entry: 'apps/topics/main.ts',
    metricsPort: 13108,
    metricsVariable: 'INTERNAL_METRICS_PORT',
    env: { TOPIC_DEFINITION_ID: 'port-restriction' },
  },
  topicLowSpeed: {
    entry: 'apps/topics/main.ts',
    metricsPort: 13109,
    metricsVariable: 'INTERNAL_METRICS_PORT',
    env: { TOPIC_DEFINITION_ID: 'area-low-speed-notice' },
  },
  agent: {
    entry: 'apps/agent/main.ts',
    metricsPort: 13110,
    metricsVariable: 'INTERNAL_METRICS_PORT',
  },
} satisfies Record<string, DemoWorkerSpec>;

export function demoWorker(
  role: keyof typeof demoWorkers,
  inherited: NodeJS.ProcessEnv = process.env,
) {
  const spec: DemoWorkerSpec = demoWorkers[role];
  return {
    ...spec,
    env: { ...inherited, ...spec.env, [spec.metricsVariable]: String(spec.metricsPort) },
  };
}
