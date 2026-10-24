import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type {
  PredictionArea,
  PredictionCoordinate,
  PredictionPath,
  ReachabilityDependencies,
} from '../packages/contracts/reachability';
import { NavigationWarningSchema } from '../packages/contracts/reachability';
import { segmentAreaEntry } from '../packages/domain/navigation-warning-impact';
import { runReachabilityBacktest } from '../packages/domain/reachability-backtest';

const Coverage = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((b) => b[0] < b[2] && b[1] < b[3], 'Non-wrapping land coverage required');
const Voyage = z.strictObject({
  voyageId: z.string().min(1),
  mmsi: z.string().regex(/^[1-9]\d{8}$/),
  shipType: z.number().int().min(1).max(99).nullable().optional(),
  forecastAt: z.iso.datetime(),
  observations: z
    .array(
      z.strictObject({
        observedAt: z.iso.datetime(),
        longitude: z.number().min(-180).max(180),
        latitude: z.number().min(-90).max(90),
        speedOverGround: z.number().nullable().optional(),
        courseOverGround: z.number().nullable().optional(),
        heading: z.number().nullable().optional(),
      }),
    )
    .max(200000),
  warnings: z.array(z.unknown()).optional(),
});
type Edge = { a: PredictionCoordinate; b: PredictionCoordinate };
/** Pre-index coastline edges once. Every path segment is checked, including outside endpoints. */
export function createGeoJsonLandChecker(
  raw: unknown,
  coverageInput: [number, number, number, number],
): NonNullable<ReachabilityDependencies['checkPaths']> {
  const coverage = Coverage.parse(coverageInput);
  if (typeof raw === 'object' && raw !== null && 'displayOnly' in raw && raw.displayOnly === true)
    throw new Error('Display-only geometry cannot constrain navigation paths');
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('features' in raw) ||
    !Array.isArray(raw.features) ||
    !raw.features.length
  )
    throw new Error('Nonempty land FeatureCollection required');
  const areas: PredictionArea[] = raw.features.map((feature) => {
    if (typeof feature !== 'object' || feature === null || !('geometry' in feature))
      throw new Error('Invalid land feature');
    return NavigationWarningSchema.parse({
      id: 'land',
      reviewStatus: 'confirmed',
      effectiveFrom: '2026-01-01T00:00:00Z',
      effectiveTo: '2027-01-01T00:00:00Z',
      applicability: { kind: 'all' },
      geometry: feature.geometry,
    }).geometry;
  });
  const step = 0.25,
    index = new Map<string, Edge[]>();
  const cells = (a: PredictionCoordinate, b: PredictionCoordinate) => {
    const keys: string[] = [];
    for (
      let x = Math.floor(Math.min(a[0], b[0]) / step);
      x <= Math.floor(Math.max(a[0], b[0]) / step);
      x++
    )
      for (
        let y = Math.floor(Math.min(a[1], b[1]) / step);
        y <= Math.floor(Math.max(a[1], b[1]) / step);
        y++
      )
        keys.push(`${x}:${y}`);
    return keys;
  };
  for (const area of areas)
    for (const polygon of area.type === 'Polygon' ? [area.coordinates] : area.coordinates)
      for (const ring of polygon)
        for (let i = 1; i < ring.length; i++) {
          const a = ring[i - 1]!,
            b = ring[i]!;
          if (Math.abs(b[0] - a[0]) > 180)
            throw new Error('Land input must be split at the date line');
          const edge = { a, b };
          for (const key of cells(a, b)) {
            const list = index.get(key) ?? [];
            list.push(edge);
            index.set(key, list);
          }
        }
  const cross = (a: PredictionCoordinate, b: PredictionCoordinate, c: PredictionCoordinate) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const intersects = (
    a: PredictionCoordinate,
    b: PredictionCoordinate,
    c: PredictionCoordinate,
    d: PredictionCoordinate,
  ) => {
    if (
      Math.max(a[0], b[0]) + 1e-10 < Math.min(c[0], d[0]) ||
      Math.max(c[0], d[0]) + 1e-10 < Math.min(a[0], b[0]) ||
      Math.max(a[1], b[1]) + 1e-10 < Math.min(c[1], d[1]) ||
      Math.max(c[1], d[1]) + 1e-10 < Math.min(a[1], b[1])
    )
      return false;
    return cross(a, b, c) * cross(a, b, d) <= 1e-20 && cross(c, d, a) * cross(c, d, b) <= 1e-20;
  };
  const startCache = new Map<string, boolean>();
  return async (paths: PredictionPath[]) =>
    paths.map((path) => {
      if (path.points.length < 2) return false;
      if (
        path.points.some(
          (p) =>
            p.coordinate[0] < coverage[0] ||
            p.coordinate[0] > coverage[2] ||
            p.coordinate[1] < coverage[1] ||
            p.coordinate[1] > coverage[3],
        )
      )
        return false;
      const start = path.points[0]!.coordinate,
        key = JSON.stringify(start);
      let onLand = startCache.get(key);
      if (onLand === undefined) {
        onLand = areas.some((area) => segmentAreaEntry(start, start, area) !== null);
        startCache.set(key, onLand);
      }
      if (onLand) return false;
      for (let i = 1; i < path.points.length; i++) {
        const a = path.points[i - 1]!.coordinate,
          b = path.points[i]!.coordinate,
          candidates = new Set<Edge>();
        for (const key of cells(a, b))
          for (const edge of index.get(key) ?? []) candidates.add(edge);
        for (const edge of candidates) if (intersects(a, b, edge.a, edge.b)) return false;
      }
      return true;
    });
}
export async function executeReachabilityBacktest(input: {
  voyages: unknown;
  splitAt: string;
  land?: unknown;
  coverage?: [number, number, number, number];
  seed?: number;
  landVersion?: string;
  landQuality?: 'verified_coastline' | 'research';
}) {
  const voyages = z.array(Voyage).max(10000).parse(input.voyages),
    splitAt = z.iso.datetime().parse(input.splitAt);
  if (input.land && !input.coverage) throw new Error('Explicit land coverage is required');
  if (input.land && !input.landQuality)
    throw new Error('Explicit land quality declaration is required');
  if (input.land) z.enum(['verified_coastline', 'research']).parse(input.landQuality);
  const dependencies: ReachabilityDependencies = input.land
    ? { checkPaths: createGeoJsonLandChecker(input.land, input.coverage!) }
    : {};
  const report = await runReachabilityBacktest({
    voyages,
    splitAt,
    seed: input.seed,
    dependencies,
  });
  return {
    status: input.land ? ('complete' as const) : ('model_not_applicable' as const),
    landConstraint: input.land ? ('checked' as const) : ('unavailable' as const),
    landVersion: input.landVersion ?? null,
    landQuality: input.landQuality ?? null,
    landCoverage: input.coverage ?? null,
    landSha256: input.land
      ? createHash('sha256').update(JSON.stringify(input.land)).digest('hex')
      : null,
    ...report,
  };
}
export async function reachabilityBacktestCommand(args: string[]) {
  const options = Object.fromEntries(
    args.map((arg) => {
      const split = arg.indexOf('=');
      if (!arg.startsWith('--') || split < 3) throw new Error('Use --option=value');
      return [arg.slice(2, split), arg.slice(split + 1)];
    }),
  );
  if (!options.input || !options.output || !options['split-at'])
    throw new Error('--input, --output and --split-at are required');
  const body = JSON.parse(await readFile(resolve(options.input), 'utf8'));
  const voyages = Array.isArray(body) ? body : body.voyages;
  const land = options.land ? JSON.parse(await readFile(resolve(options.land), 'utf8')) : undefined;
  if (options.land?.replaceAll('\\', '/').includes('/public/maps/maritime/'))
    throw new Error(
      'Display-only simplified map assets cannot be used as navigation land constraints',
    );
  const coverage = options.coverage
    ? Coverage.parse(options.coverage.split(',').map(Number))
    : undefined;
  const report = await executeReachabilityBacktest({
    voyages,
    splitAt: options['split-at'],
    land,
    coverage,
    landVersion: options['land-version'],
    landQuality: options['land-quality'] as 'verified_coastline' | 'research' | undefined,
    seed: options.seed ? Number(options.seed) : undefined,
  });
  const output = resolve(options.output);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  await rename(temporary, output);
  console.log(
    JSON.stringify({
      output,
      status: report.status,
      samples: report.samples.length,
      calibration: report.calibrationState,
    }),
  );
  return report;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reachabilityBacktestCommand(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
