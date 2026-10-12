import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createInfrastructure, createRawEnvelope, publishRaw } from '@ais/infrastructure';
import { hashToken } from '../apps/api/src/auth/security';
import { hashPassword } from '../apps/api/src/auth/service';
import { benchmarkPhases, makeSyntheticPositions, percentile } from './benchmark';

if (process.env.NODE_ENV === 'production')
  throw new Error('Synthetic benchmark requires an isolated staging/development database');
const full = process.argv.includes('--full');
const phases = benchmarkPhases(full);
const ships = full ? 500_000 : 1000;
const runId = randomUUID();
const sourceId = `benchmark-${runId}`;
const root = resolve(import.meta.dirname, '..');
const infra = await createInfrastructure();
const startedAt = new Date().toISOString();
const latestLatency: number[] = [],
  historyLatency: number[] = [],
  mapLatency: number[] = [],
  track24Latency: number[] = [],
  track30Latency: number[] = [];
type Sample = {
  captureId: string;
  mmsi: string;
  receivedAt: number;
  observedAt: string;
  pg: boolean;
  ch: boolean;
};
const samples: Sample[] = [];
let captureCount = 0,
  positionCount = 0,
  rawBytes = 0,
  queryErrors = 0,
  publishErrors = 0,
  stopQueries = false,
  monitorBusy = false;
const phaseResults: {
  name: string;
  targetRate: number;
  observations: number;
  seconds: number;
  actualRate: number;
}[] = [];
const tokens: string[] = [];
const userIds: string[] = [];
const stopped = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stopped.abort());
await infra.pool.query(
  'INSERT INTO sources(id,name,kind,enabled,priority,status,config) VALUES($1,$2,$3,false,100,$4,$5::jsonb)',
  [
    sourceId,
    'Synthetic benchmark',
    'fixture-http',
    'disabled',
    JSON.stringify({ settings: { authorizationConfirmed: false } }),
  ],
);
// Test setup creates 20 distinct real viewer sessions. Password/login performance is covered by separate authentication tests.
const passwordHash = await hashPassword(randomBytes(32).toString('base64url'));
for (let n = 0; n < 20; n++) {
  const id = randomUUID(),
    token = randomBytes(32).toString('base64url');
  userIds.push(id);
  tokens.push(token);
  await infra.pool.query(
    "INSERT INTO users(id,username,password_hash,role) VALUES($1,$2,$3,'viewer')",
    [id, `bench-${runId}-${n}`, passwordHash],
  );
  await infra.pool.query(
    "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,now()+interval '2 hours')",
    [hashToken(token), id],
  );
}
const apiBase = process.env.BENCH_API_URL ?? 'http://127.0.0.1:13000';
async function query(path: string, token: string, latencies: number[]) {
  const began = performance.now();
  try {
    const response = await fetch(`${apiBase}/api/v1/${path}`, {
      headers: { Cookie: `ais_session=${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Query status ${response.status}`);
    await response.arrayBuffer();
    latencies.push(performance.now() - began);
  } catch {
    queryErrors++;
  }
}
const from24 = () => new Date(Date.now() - 86_400_000 + 60_000).toISOString();
const from30 = () => new Date(Date.now() - 30 * 86_400_000 + 120_000).toISOString();
async function queries() {
  while (!stopQueries && !stopped.signal.aborted) {
    await Promise.all(
      tokens.map(async (token, n) => {
        await query('map?bbox=-180,-80,180,80&zoom=3', token, mapLatency);
        const mmsi = n === 0 ? '500999999' : String(500000000 + n);
        const now = new Date().toISOString();
        await query(
          `vessels/${mmsi}/track?from=${encodeURIComponent(from24())}&to=${encodeURIComponent(now)}&maxPoints=5000`,
          token,
          track24Latency,
        );
        if (n === 0)
          await query(
            `vessels/${mmsi}/track?from=${encodeURIComponent(from30())}&to=${encodeURIComponent(now)}&maxPoints=5000`,
            token,
            track30Latency,
          );
      }),
    );
    await delay(5000);
  }
}
async function monitor() {
  if (monitorBusy || !samples.length) return;
  monitorBusy = true;
  try {
    const active = samples.filter((s) => !s.pg || !s.ch).slice(0, 50);
    if (!active.length) return;
    const captureIds = active.map((s) => s.captureId),
      mmsis = active.map((s) => s.mmsi);
    const ch = await infra.clickhouse.query({
      query:
        'SELECT DISTINCT captureId FROM positions FINAL WHERE sourceId={source:String} AND mmsi IN {mmsis:Array(String)} AND captureId IN {ids:Array(String)}',
      query_params: { source: sourceId, mmsis, ids: captureIds },
      format: 'JSONEachRow',
    });
    const present = new Set((await ch.json<{ captureId: string }>()).map((x) => x.captureId));
    const pg = await infra.pool.query(
      'SELECT mmsi,observed_at FROM positions_latest WHERE source_id=$1 AND mmsi=ANY($2::text[])',
      [sourceId, mmsis],
    );
    const latest = new Map(pg.rows.map((x) => [x.mmsi, new Date(x.observed_at).getTime()]));
    const now = Date.now();
    for (const sample of active) {
      if (!sample.ch && present.has(sample.captureId)) {
        historyLatency.push(now - sample.receivedAt);
        sample.ch = true;
      }
      if (!sample.pg && (latest.get(sample.mmsi) ?? 0) >= Date.parse(sample.observedAt)) {
        latestLatency.push(now - sample.receivedAt);
        sample.pg = true;
      }
    }
  } finally {
    monitorBusy = false;
  }
}
const monitorTimer = setInterval(
  () =>
    void monitor().catch(() => {
      queryErrors++;
    }),
  1000,
);
const queryTask = queries();
let recoveredAt: number | null = null;
let peakRawSequence = 0,
  peakNormalizedSequence = 0;
let denseHistoryObservations = 0;
let failure: string | null = null;
try {
  const ready = await fetch('http://127.0.0.1:13100/ready');
  if (!ready.ok) throw new Error('Start bun run demo --backend-only before benchmark');
  // One dense 30-day synthetic track exercises query-time deduplication and thinning separately from the throughput count.
  const denseCount = full ? 50_000 : 200;
  for (let offset = 0; offset < denseCount; offset += 100) {
    const data = Array.from({ length: Math.min(100, denseCount - offset) }, (_, i) => ({
      id: `dense-${runId}-${offset + i}`,
      mmsi: '500999999',
      observedAt: new Date(
        Date.now() - 29.99 * 86_400_000 + (offset + i) * ((29.98 * 86_400_000) / denseCount),
      ).toISOString(),
      lat: 30 + (i % 100) / 100,
      lon: 120 + (i % 100) / 100,
      sogKnots: 10,
      cogDegrees: 90,
    }));
    await publishRaw(
      infra,
      await createRawEnvelope(infra, {
        sourceId,
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        adapterVersion: 'benchmark-v1',
        runId: null,
        payload: { synthetic: true, data },
      }),
    );
    denseHistoryObservations += data.length;
  }
  let cursor = 0;
  for (const phase of phases) {
    const began = performance.now(),
      before = positionCount;
    for (let second = 0; second < phase.seconds && !stopped.signal.aborted; second++) {
      const observedAt = new Date().toISOString();
      for (let offset = 0; offset < phase.rate; offset += 100) {
        const data = makeSyntheticPositions(
          runId,
          cursor,
          Math.min(100, phase.rate - offset),
          ships,
          observedAt,
        );
        cursor += data.length;
        const raw = await createRawEnvelope(infra, {
          sourceId,
          sourceKind: 'fixture-http',
          sourcePriority: 100,
          adapterVersion: 'benchmark-v1',
          runId: null,
          payload: { synthetic: true, data },
        });
        try {
          await publishRaw(infra, raw);
        } catch (error) {
          publishErrors++;
          throw error;
        }
        captureCount++;
        positionCount += data.length;
        rawBytes += Buffer.byteLength(JSON.stringify(raw));
        if (offset === 0 && samples.length < 10_000)
          samples.push({
            captureId: raw.captureId,
            mmsi: data[0]!.mmsi,
            receivedAt: Date.parse(raw.receivedAt),
            observedAt,
            pg: false,
            ch: false,
          });
      }
      if (second % 30 === 0)
        console.log(
          `Benchmark ${phase.name}: ${second + 1}/${phase.seconds}s, ${positionCount} expanded positions`,
        );
      if (phase.name === 'recovery' && recoveredAt === null) {
        const cleaner = await infra.jsm.consumers.info('AIS_RAW', 'cleaner');
        if (cleaner.ack_floor.stream_seq >= peakRawSequence) {
          if (!peakNormalizedSequence)
            peakNormalizedSequence = (await infra.jsm.streams.info('AIS_NORMALIZED')).state
              .last_seq;
          const writers = await Promise.all(
            ['postgres-writer', 'clickhouse-writer'].map((name) =>
              infra.jsm.consumers.info('AIS_NORMALIZED', name),
            ),
          );
          if (writers.every((c) => c.ack_floor.stream_seq >= peakNormalizedSequence))
            recoveredAt = (performance.now() - began) / 1000;
        }
      }
      await delay(Math.max(0, began + (second + 1) * 1000 - performance.now()));
    }
    const seconds = (performance.now() - began) / 1000;
    phaseResults.push({
      name: phase.name,
      targetRate: phase.rate,
      observations: positionCount - before,
      seconds,
      actualRate: (positionCount - before) / seconds,
    });
    if (phase.name === 'peak')
      peakRawSequence = (await infra.jsm.streams.info('AIS_RAW')).state.last_seq;
    if (stopped.signal.aborted) break;
  }
  for (let attempt = 0; attempt < 90 && !stopped.signal.aborted; attempt++) {
    await monitor();
    const count = await infra.clickhouse.query({
      query:
        'SELECT uniqExact(eventId) AS count FROM positions FINAL WHERE sourceId={source:String}',
      query_params: { source: sourceId },
      format: 'JSONEachRow',
    });
    const rows = await count.json<{ count: string }>();
    const archive = await infra.pool.query(
      "SELECT coalesce(sum(count),0)::bigint AS count FROM archive_batches WHERE source_id=$1 AND status='committed'",
      [sourceId],
    );
    if (
      Number(rows[0]?.count) === positionCount + denseHistoryObservations &&
      Number(archive.rows[0].count) >= captureCount + Math.ceil(denseHistoryObservations / 100)
    )
      break;
    await delay(1000);
  }
  await monitor();
} catch (error) {
  failure = error instanceof Error ? error.message : 'Benchmark failed';
  process.exitCode = 1;
} finally {
  clearInterval(monitorTimer);
  stopQueries = true;
  await queryTask;
  const counts = await infra.clickhouse.query({
    query:
      'SELECT uniqExact(eventId) AS observations,uniqExact(mmsi) AS ships FROM positions FINAL WHERE sourceId={source:String}',
    query_params: { source: sourceId },
    format: 'JSONEachRow',
  });
  const stored = (await counts.json<{ observations: string; ships: string }>())[0];
  const archive = await infra.pool.query(
    "SELECT count(*) AS batches,coalesce(sum(count),0) AS captures,coalesce(sum(bytes),0) AS compressed_bytes,percentile_cont(.95) WITHIN GROUP(ORDER BY extract(epoch FROM committed_at-min_received_at)*1000) AS conservative_latency_p95_ms FROM archive_batches WHERE source_id=$1 AND status='committed'",
    [sourceId],
  );
  const size = await infra.clickhouse.query({
    query:
      "SELECT sum(rows) AS rows,sum(data_compressed_bytes) AS compressedBytes,sum(data_uncompressed_bytes) AS uncompressedBytes FROM system.parts WHERE database=currentDatabase() AND table='positions' AND active",
    format: 'JSONEachRow',
  });
  const capacity = (
    await size.json<{ rows: string; compressedBytes: string; uncompressedBytes: string }>()
  )[0];
  const complete =
    !failure &&
    !stopped.signal.aborted &&
    phaseResults.length === phases.length &&
    publishErrors === 0 &&
    queryErrors === 0 &&
    Number(stored?.observations) === positionCount + denseHistoryObservations &&
    Number(archive.rows[0].captures) >= captureCount + Math.ceil(denseHistoryObservations / 100);
  const report = {
    mode: full ? 'full' : 'smoke',
    runId,
    sourceId,
    startedAt,
    endedAt: new Date().toISOString(),
    failure,
    hardware: {
      platform: platform(),
      release: release(),
      cpuCount: cpus().length,
      cpuModel: cpus()[0]?.model,
      memoryBytes: totalmem(),
    },
    targets: {
      continuousObservationsPerSecond: 1000,
      continuousSeconds: 3600,
      peakObservationsPerSecond: 3000,
      peakSeconds: 300,
      ships: 500000,
      concurrentUsers: 20,
    },
    observed: {
      httpLikeCaptures: captureCount,
      expandedPositions: positionCount,
      denseHistoryObservations,
      stored,
      phaseResults,
      peakRecoverySeconds: recoveredAt,
      publishErrors,
      queryErrors,
      visibilitySamples: samples.length,
      unresolvedSamples: samples.filter((s) => !s.pg || !s.ch).length,
      latestVisibilityP95Ms: percentile(latestLatency, 0.95),
      historyVisibilityP95Ms: percentile(historyLatency, 0.95),
      mapP95Ms: percentile(mapLatency, 0.95),
      track24hP95Ms: percentile(track24Latency, 0.95),
      track30dP95Ms: percentile(track30Latency, 0.95),
      archive: archive.rows[0],
      rawEnvelopeBytes: rawBytes,
      clickhousePhysicalCapacity: capacity,
    },
    limitations: [
      '30-day 2.59 billion row query capacity remains a separate unverified scale gate.',
      'Visibility latency is a 1-second polling upper bound on one sampled position per second.',
      'Archive latency uses the oldest received record in each committed batch; conservative per-batch p95.',
      'Authentication setup provisions sessions; query traffic uses 20 distinct viewer identities.',
      'Physical ClickHouse bytes include other observations in this development database.',
    ],
    complete,
    capacityTargetsVerified:
      full &&
      complete &&
      Number(stored?.ships) >= 500000 &&
      phaseResults.every((p) => p.actualRate >= p.targetRate * 0.99) &&
      recoveredAt !== null &&
      recoveredAt <= 600 &&
      (percentile(latestLatency, 0.95) ?? Infinity) < 5000 &&
      (percentile(historyLatency, 0.95) ?? Infinity) < 5000 &&
      (percentile(mapLatency, 0.95) ?? Infinity) < 2000 &&
      (percentile(track24Latency, 0.95) ?? Infinity) < 3000 &&
      Number(archive.rows[0].conservative_latency_p95_ms) < 90000,
  };
  await mkdir(resolve(root, 'docs/reports'), { recursive: true });
  const reportPath = resolve(
    root,
    `docs/reports/benchmark-${full ? 'full' : 'smoke'}-${runId}.json`,
  );
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`Benchmark report: ${reportPath}`);
  await infra.pool.query('DELETE FROM sessions WHERE user_id=ANY($1::uuid[])', [userIds]);
  await infra.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [userIds]);
  await infra.close();
  if (!report.complete) process.exitCode = 1;
}
