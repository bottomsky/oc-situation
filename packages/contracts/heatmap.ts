import { z } from 'zod';

export const HEATMAP_MAX_CELLS = 4096;
export const HEATMAP_MAX_HOURS = 168;
export const HEATMAP_RETENTION_DAYS = 30;

const Timestamp = z.iso.datetime().max(40);
const Bbox = z
  .tuple([
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
    z.number().min(-180).max(180),
    z.number().min(-90).max(90),
  ])
  .refine((value) => value[1] <= value[3], 'South must precede north');

/** Absolute query bounds remain valid when restoring historical result snapshots. */
export const HeatmapQuerySchema = z
  .strictObject({
    bbox: Bbox,
    from: Timestamp,
    to: Timestamp,
    sourceId: z.string().min(1).max(200).optional(),
    shipType: z.number().int().min(1).max(99).optional(),
    mmsis: z
      .array(z.string().regex(/^[1-9]\d{8}$/))
      .max(100)
      .refine((items) => new Set(items).size === items.length, 'Duplicate vessels')
      .optional(),
  })
  .refine(
    (query) =>
      Date.parse(query.from) < Date.parse(query.to) &&
      Date.parse(query.to) - Date.parse(query.from) <= HEATMAP_MAX_HOURS * 3_600_000,
    'Heatmap range must be positive and at most 168 hours',
  );
export type HeatmapQuery = z.infer<typeof HeatmapQuerySchema>;

/** Apply retention and future bounds when executing a query, with an explicit clock. */
export function validateHeatmapQueryWindow(input: unknown, now: Date): void {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new Error('Invalid heatmap execution time');
  HeatmapQuerySchema.refine(
    (query) => Date.parse(query.from) >= nowMs - HEATMAP_RETENTION_DAYS * 86_400_000,
    'Heatmap range exceeds 30 day retention',
  )
    .refine((query) => Date.parse(query.to) <= nowMs, 'Heatmap range must not be in the future')
    .parse(input);
}

/** Cells use the fixed global origin (-180, -90), with latitude clipped at 90. */
export const HeatmapGridSchema = z
  .strictObject({
    level: z.number().int().min(0).max(20),
    cellDegrees: z.number().positive(),
  })
  .refine((grid) => grid.cellDegrees === 360 / 2 ** grid.level, 'Invalid grid resolution');
export type HeatmapGrid = z.infer<typeof HeatmapGridSchema>;

export const HeatmapCellSchema = z.strictObject({
  id: z.string().regex(/^\d{1,2}:\d{1,7}:\d{1,7}$/),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  lon: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  vesselCount: z.number().int().positive(),
});
export type HeatmapCell = z.infer<typeof HeatmapCellSchema>;

export const HeatmapResultSchema = z
  .strictObject({
    query: HeatmapQuerySchema,
    grid: HeatmapGridSchema,
    cells: z.array(HeatmapCellSchema).max(HEATMAP_MAX_CELLS),
    /** Unique MMSIs across the whole query, independently deduplicated across cells. */
    totalVessels: z.number().int().nonnegative(),
    generatedAt: Timestamp,
    metric: z.literal('unique_vessels'),
    shipTypeBasis: z.literal('current_profile'),
  })
  .refine((result) => new Set(result.cells.map((cell) => cell.id)).size === result.cells.length, {
    message: 'Duplicate heatmap cells',
    path: ['cells'],
  })
  .refine(
    (result) =>
      result.cells.every((cell) => {
        const { level, cellDegrees } = result.grid;
        const south = -90 + cell.y * cellDegrees;
        const north = Math.min(90, south + cellDegrees);
        return (
          cell.x < 2 ** level &&
          cell.y < Math.max(1, 2 ** (level - 1)) &&
          cell.id === `${level}:${cell.x}:${cell.y}` &&
          cell.lon === -180 + (cell.x + 0.5) * cellDegrees &&
          cell.lat === (south + north) / 2 &&
          cell.vesselCount <= result.totalVessels
        );
      }),
    { message: 'Heatmap cell must match its global grid and vessel total', path: ['cells'] },
  );
export type HeatmapResult = z.infer<typeof HeatmapResultSchema>;

export const AgentHeatmapResultSchema = HeatmapResultSchema.safeExtend({
  kind: z.literal('ais_heatmap'),
  version: z.number().int().nonnegative(),
  inputRevision: z.number().int().nonnegative(),
});
export type AgentHeatmapResult = z.infer<typeof AgentHeatmapResultSchema>;
