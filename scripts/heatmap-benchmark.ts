import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createInfrastructure } from '../packages/infrastructure/clients';
import { HeatmapQueryError, queryAisHeatmap } from '../packages/infrastructure/heatmap';
import type { HeatmapQuery, HeatmapResult } from '../packages/contracts/heatmap';

export function heatmapResponseBytes(result: HeatmapResult | null): number | null {
  return result === null ? null : Buffer.byteLength(JSON.stringify(result), 'utf8');
}

/** The benchmark writes synthetic AIS history only to the agreed isolated stack. */
export function heatmapBenchmarkConfig(environment: NodeJS.ProcessEnv) {
  if (environment.AIS_HEATMAP_BENCH !== '1')
    throw new Error('Set AIS_HEATMAP_BENCH=1 to enable the isolated benchmark');
  for (const [name, port] of [
    ['DATABASE_URL', '15433'],
    ['CLICKHOUSE_URL', '18124'],
    ['NATS_URL', '14223'],
    ['S3_ENDPOINT', '19001'],
  ] as const) {
    const url = new URL(environment[name] ?? 'invalid:');
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port !== port)
      throw new Error(`${name} must target the local isolated port ${port}`);
  }
  const rows = Number(environment.AIS_HEATMAP_BENCH_ROWS ?? 100000);
  const repeats = Number(environment.AIS_HEATMAP_BENCH_REPEATS ?? 5);
  if (!Number.isInteger(rows) || rows < 100000 || rows > 1000000)
    throw new Error('AIS_HEATMAP_BENCH_ROWS must be between 100000 and 1000000');
  if (!Number.isInteger(repeats) || repeats < 3 || repeats > 30)
    throw new Error('AIS_HEATMAP_BENCH_REPEATS must be between 3 and 30');
  return { rows, repeats };
}

async function run() {
  const { rows, repeats } = heatmapBenchmarkConfig(process.env);
  const infra = await createInfrastructure();
  const sourceId = `heatmap-benchmark-${randomUUID()}`;
  const to = new Date(Date.now() - 1000).toISOString();
  const from = new Date(Date.parse(to) - 7 * 86400000).toISOString();
  const queryIds: string[] = [];
  const measuredInfra = {
    ...infra,
    clickhouse: new Proxy(infra.clickhouse, {
      get(target, property) {
        if (property === 'query')
          return (args: Parameters<typeof infra.clickhouse.query>[0]) => {
            if (args.query_id) queryIds.push(args.query_id);
            return target.query(args);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }),
  };
  type Sample = {
    queryId: string;
    latencyMs: number;
    cells: number | null;
    totalVessels: number | null;
    responseBytes: number | null;
    status: string;
    success: boolean;
    readRows?: number;
    readBytes?: number;
    peakMemoryBytes?: number;
    serverDurationMs?: number;
  };
  const report: {
    success: boolean;
    methodology: object;
    rows: number;
    distinctVessels: number;
    repeats: number;
    sourceId: string;
    generatedAt: string;
    scenarios: {
      hours: number;
      region: string;
      bbox: number[];
      samples: Sample[];
      p95Ms: number | null;
    }[];
    metricsStatus: string;
  } = {
    success: true,
    methodology: {
      query: '{ bbox: [west,south,east,north], from: ISO UTC, to: ISO UTC, sourceId: string }',
      timeInterval: '[from,to)',
      metric: 'uniqExact(mmsi) per cell and independently across the full region',
      data: '10000 MMSIs; deterministic worldwide longitude/latitude; observations uniformly distributed across seven days; unique source and event IDs; one cleaning version and priority 10',
      cache: 'ownerId omitted; application cache and coalescing disabled for every sample',
      responseBytes:
        'Exact UTF-8 byte length of JSON.stringify(result), excluding HTTP headers and transport compression; null for failed queries',
      limits: {
        seconds: 20,
        memoryBytes: 536870912,
        readRows: 50000000,
        readBytes: 4294967296,
        resultCells: 4096,
      },
      p95: 'nearest-rank P95 of successful requests only; null when all attempts fail; five repeats by default',
      capacity:
        'data_limit reports a resource cap; narrow the time or ship selection; spatial bounds are applied after preferred observations are selected',
    },
    rows,
    distinctVessels: 10000,
    repeats,
    sourceId,
    generatedAt: new Date().toISOString(),
    scenarios: [],
    metricsStatus: 'pending',
  };
  try {
    await infra.clickhouse.command({
      query: `INSERT INTO positions (eventId,captureId,mmsi,sourceId,sourceKind,sourcePriority,observedAt,receivedAt,cleaningVersion,latitude,longitude,quality,observation)
        SELECT concat({sourceId:String},'-',toString(number)),concat({sourceId:String},'-',toString(number)),toString(900000000+number%10000),{sourceId:String},'fixture-http',10,
        parseDateTime64BestEffort({from:String})+toIntervalMillisecond(toInt64(floor(number*604800000/{rows:UInt64}))),
        parseDateTime64BestEffort({to:String}),1,toFloat64((number*7919)%180000)/1000-90,toFloat64((number*3571)%360000)/1000-180,[],''
        FROM numbers({rows:UInt64})`,
      query_params: { sourceId, rows, from, to },
    });
    for (const hours of [24, 168]) {
      for (const [region, bbox] of [
        ['local', [100, 0, 130, 40]],
        ['global', [-180, -90, 180, 90]],
      ] as const) {
        const query: HeatmapQuery = {
          bbox: [...bbox],
          from: new Date(Date.parse(to) - hours * 3600000).toISOString(),
          to,
          sourceId,
        };
        const samples: Sample[] = [];
        for (let iteration = 0; iteration < repeats; iteration++) {
          const started = performance.now();
          // An omitted owner explicitly bypasses the 30-second application cache.
          let cells: number | null = null,
            totalVessels: number | null = null,
            responseBytes: number | null = null,
            status = 'success';
          try {
            const result = await queryAisHeatmap(measuredInfra, query);
            cells = result.cells.length;
            totalVessels = result.totalVessels;
            responseBytes = heatmapResponseBytes(result);
          } catch (error) {
            if (!(error instanceof HeatmapQueryError)) throw error;
            status = error.category;
            report.success = false;
          }
          samples.push({
            queryId: queryIds.at(-1)!,
            latencyMs: Math.round((performance.now() - started) * 100) / 100,
            cells,
            totalVessels,
            responseBytes,
            status,
            success: status === 'success',
          });
        }
        const latency = samples
          .filter((sample) => sample.status === 'success')
          .map((sample) => sample.latencyMs)
          .sort((a, b) => a - b);
        report.scenarios.push({
          hours,
          region,
          bbox: [...bbox],
          samples,
          p95Ms: latency[Math.ceil(latency.length * 0.95) - 1] ?? null,
        });
      }
    }
    try {
      await infra.clickhouse.command({ query: 'SYSTEM FLUSH LOGS' });
      const log = await infra.clickhouse.query({
        query:
          "SELECT query_id,read_rows,read_bytes,memory_usage,query_duration_ms FROM system.query_log WHERE query_id IN {ids:Array(String)} AND type IN ('QueryFinish','ExceptionWhileProcessing')",
        query_params: { ids: queryIds },
        format: 'JSONEachRow',
      });
      const metrics = await log.json<{
        query_id: string;
        read_rows: string;
        read_bytes: string;
        memory_usage: string;
        query_duration_ms: string;
      }>();
      for (const scenario of report.scenarios)
        for (const sample of scenario.samples) {
          const metric = metrics.find((row) => row.query_id === sample.queryId);
          if (metric)
            Object.assign(sample, {
              readRows: Number(metric.read_rows),
              readBytes: Number(metric.read_bytes),
              peakMemoryBytes: Number(metric.memory_usage),
              serverDurationMs: Number(metric.query_duration_ms),
            });
        }
      report.metricsStatus =
        metrics.length === queryIds.length
          ? 'complete'
          : `partial: ${metrics.length}/${queryIds.length}`;
    } catch {
      report.metricsStatus = 'query_log metrics unavailable';
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    try {
      await infra.clickhouse.command({
        query: 'ALTER TABLE positions DELETE WHERE sourceId={sourceId:String}',
        query_params: { sourceId },
        clickhouse_settings: { mutations_sync: '1' },
      });
    } finally {
      await infra.close();
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Heatmap benchmark failed');
    process.exitCode = 1;
  });
}
