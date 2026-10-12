import { Controller, Get, Inject, Param, Query, NotFoundException } from '@nestjs/common';
import { ApiParam } from '@nestjs/swagger';
import { z } from 'zod';
import { RunModeSchema, RunStatusSchema } from '@ais/contracts';
import type { Infrastructure } from '@ais/infrastructure';
import {
  DocumentQuery,
  DocumentRoute,
  INFRA,
  Iso,
  PageQuery,
  PageResponse,
  Uuid,
  parse,
  isoValue,
} from '../common';
export const RunResponseSchema = z.object({
  runId: Uuid,
  jobId: Uuid.nullable(),
  sourceId: z.string(),
  mode: RunModeSchema,
  status: RunStatusSchema,
  requestedAt: Iso,
  startedAt: Iso.nullable(),
  finishedAt: Iso.nullable(),
  captures: z.number(),
  positions: z.number(),
  statics: z.number(),
  quarantined: z.number(),
  records: z.number(),
  normalizedCaptures: z.number(),
  counterScope: z.literal('confirmed expanded records; retained event counts deduplicate separately'),
  error: z.string().nullable(),
});
export const RunQuerySchema = PageQuery.extend({
  status: RunStatusSchema.optional(),
  sourceId: z.string().max(200).optional(),
});
interface RunRow {
  id: string;
  job_id: string | null;
  source_id: string;
  mode: string;
  status: string;
  requested_at: Date | string;
  started_at?: Date | string | null;
  finished_at?: Date | string | null;
  counters?: { captures?: number; positions?: number; statics?: number; quarantined?: number; records?: number; normalizedCaptures?: number };
  last_error?: string | null;
}
export function runRow(r: RunRow) {
  return {
    runId: r.id,
    jobId: r.job_id ?? null,
    sourceId: r.source_id,
    mode: r.mode,
    status: r.status,
    requestedAt: isoValue(r.requested_at),
    startedAt: r.started_at ? isoValue(r.started_at) : null,
    finishedAt: r.finished_at ? isoValue(r.finished_at) : null,
    captures: Number(r.counters?.captures ?? 0),
    positions: Number(r.counters?.positions ?? 0),
    statics: Number(r.counters?.statics ?? 0),
    quarantined: Number(r.counters?.quarantined ?? 0),
    records: Number(r.counters?.records ?? 0),
    normalizedCaptures: Number(r.counters?.normalizedCaptures ?? 0),
    counterScope: 'confirmed expanded records; retained event counts deduplicate separately' as const,
    error: r.last_error ? 'Run failed; inspect operator logs' : null,
  };
}
@Controller('runs')
export class RunsController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(RunQuerySchema)
  @DocumentRoute('Read durable worker run states', PageResponse(RunResponseSchema))
  async list(@Query() input: unknown) {
    const q = parse(RunQuerySchema, input);
    if (q.cursor) parse(Uuid, q.cursor);
    const result = await this.infra.pool.query(
      'SELECT * FROM runs WHERE ($1::uuid IS NULL OR id<$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR source_id=$3) ORDER BY id DESC LIMIT $4',
      [q.cursor ?? null, q.status ?? null, q.sourceId ?? null, q.limit + 1],
    );
    const items = result.rows.slice(0, q.limit).map(runRow);
    return { items, nextCursor: result.rows.length > q.limit ? items.at(-1)!.runId : null };
  }
  @Get(':runId')
  @ApiParam({ name: 'runId', format: 'uuid' })
  @DocumentRoute('Read one worker run state', RunResponseSchema)
  async get(@Param('runId') id: string) {
    parse(Uuid, id);
    const result = await this.infra.pool.query('SELECT * FROM runs WHERE id=$1', [id]);
    if (!result.rows[0]) throw new NotFoundException('Run not found');
    return runRow(result.rows[0]);
  }
}
