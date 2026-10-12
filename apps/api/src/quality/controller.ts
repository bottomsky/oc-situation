import { Controller, Get, Inject, NotFoundException, Param, Query, Res } from '@nestjs/common';
import { ApiParam, ApiQuery, ApiProduces } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { readArchive, loadRawPayload, type Infrastructure } from '@ais/infrastructure';
import { QuarantineObservationSchema } from '@ais/contracts';
import {
  DocumentRoute,
  INFRA,
  Iso,
  PageQuery,
  PageResponse,
  SafeId,
  parse,
  isoValue,
} from '../common';
export const QualityQuerySchema = PageQuery.extend({
  from: Iso.optional(),
  to: Iso.optional(),
  sourceId: SafeId.optional(),
  reason: z.string().max(200).optional(),
});
export function qualityRange(input: unknown) {
  const q = parse(QualityQuerySchema, input);
  const to = q.to ?? new Date().toISOString();
  const from = q.from ?? new Date(Date.parse(to) - 24 * 3600000).toISOString();
  if (
    Date.parse(from) >= Date.parse(to) ||
    Date.parse(to) - Date.parse(from) > 30 * 86400000 ||
    Date.parse(from) < Date.now() - 30 * 86400000 ||
    Date.parse(to) > Date.now() + 60000
  )
    parse(z.never(), null);
  return { ...q, from, to };
}
export const QualityResponseSchema = z.object({
  from: Iso,
  to: Iso,
  receivedCaptures: z.number(),
  receivedCapturesLabel: z.literal('归档确认响应数'),
  receivedCapturesScope: z.literal('committed archive minute buckets'),
  archiveLagSeconds: z.literal(60),
  normalizedPositions: z.number(),
  normalizedStatic: z.number(),
  quarantinedEvents: z.number(),
  latestPositionJumpFlags: z.number(),
  latestPositionJumpLabel: z.literal('最新位置跳跃标记'),
  qualityFlags: z.array(z.object({ flag: z.string(), events: z.number() })),
});
@Controller()
export class QualityController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get('quality')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'sourceId', required: false, type: String })
  @DocumentRoute(
    'Committed raw archive minute bucket counts (up to 60s lag) and independent normalized event counts',
    QualityResponseSchema,
  )
  async quality(@Query() input: unknown) {
    const q = qualityRange(input);
    const args = { from: q.from, to: q.to, sourceId: q.sourceId ?? '' };
    const received = `receivedAt>=parseDateTime64BestEffort({from:String}) AND receivedAt<parseDateTime64BestEffort({to:String}) AND ({sourceId:String}='' OR sourceId={sourceId:String})`;
    const archived = await this.infra.pool.query(
      "SELECT coalesce(sum(count),0) AS count FROM archive_batches WHERE status='committed' AND time_bucket>=date_trunc('minute',$1::timestamptz) AND time_bucket<date_trunc('minute',$2::timestamptz) AND ($3::text IS NULL OR source_id=$3)",
      [q.from, q.to, q.sourceId ?? null],
    );
    const values = await Promise.all(
      ['positions', 'static_history_v2', 'quarantine_v2'].map(async (table) => {
        const result = await this.infra.clickhouse.query({
          query: `SELECT uniqExact(eventId) AS count FROM ${table} FINAL WHERE ${received}`,
          format: 'JSONEachRow',
          query_params: args,
        });
        return Number((await result.json<{ count: string }>())[0]?.count ?? 0);
      }),
    );
    const result = await this.infra.clickhouse.query({
      query: `SELECT arrayJoin(flags) AS flag,count() AS events FROM quality_events_v2 FINAL WHERE ${received} GROUP BY flag ORDER BY flag`,
      format: 'JSONEachRow',
      query_params: args,
    });
    const flags = await result.json<{ flag: string; events: string }>();
    const jumps = await this.infra.pool.query(
      "SELECT count(*)::int AS count FROM positions_latest WHERE quality ? 'implausible_jump' AND observed_at>=$1::timestamptz AND observed_at<$2::timestamptz AND ($3::text IS NULL OR source_id=$3)",
      [q.from, q.to, q.sourceId ?? null],
    );
    return {
      from: q.from,
      to: q.to,
      receivedCaptures: Number(archived.rows[0].count),
      receivedCapturesLabel: '归档确认响应数',
      receivedCapturesScope: 'committed archive minute buckets',
      archiveLagSeconds: 60,
      normalizedPositions: values[0],
      normalizedStatic: values[1],
      quarantinedEvents: values[2],
      latestPositionJumpFlags: jumps.rows[0].count,
      latestPositionJumpLabel: '最新位置跳跃标记',
      qualityFlags: flags.map((r) => ({ flag: r.flag, events: Number(r.events) })),
    };
  }
  @Get('quarantine')
  @ApiQuery({ name: 'from', required: false, type: String })
  @ApiQuery({ name: 'to', required: false, type: String })
  @ApiQuery({ name: 'sourceId', required: false, type: String })
  @ApiQuery({ name: 'reason', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @DocumentRoute(
    'Paged rejected normalized events for a bounded reception range',
    PageResponse(QuarantineObservationSchema),
  )
  async quarantine(@Query() input: unknown) {
    const q = qualityRange(input);
    if (q.cursor) parse(SafeId, q.cursor);
    const result = await this.infra.clickhouse.query({
      query: `SELECT eventId,observation FROM quarantine_v2 FINAL WHERE receivedAt>=parseDateTime64BestEffort({from:String}) AND receivedAt<parseDateTime64BestEffort({to:String}) AND ({sourceId:String}='' OR sourceId={sourceId:String}) AND ({reason:String}='' OR has(reasons,{reason:String})) AND ({cursor:String}='' OR eventId>{cursor:String}) ORDER BY eventId LIMIT {limit:UInt32}`,
      format: 'JSONEachRow',
      query_params: {
        ...q,
        sourceId: q.sourceId ?? '',
        reason: q.reason ?? '',
        cursor: q.cursor ?? '',
        limit: q.limit + 1,
      },
    });
    const rows = await result.json<{ eventId: string; observation: string }>();
    return {
      items: rows
        .slice(0, q.limit)
        .map((r) => parse(QuarantineObservationSchema, JSON.parse(r.observation))),
      nextCursor: rows.length > q.limit ? rows[q.limit - 1]!.eventId : null,
    };
  }
  @Get('captures/:captureId')
  @ApiParam({ name: 'captureId', type: String })
  @ApiQuery({ name: 'sourceId', required: true, type: String })
  @ApiQuery({ name: 'receivedAt', required: true, type: String })
  @ApiProduces('application/json', 'text/plain')
  @DocumentRoute(
    'Read retained raw capture safely as JSON; source/time locates archive',
    z.unknown(),
  )
  async capture(@Param('captureId') id: string, @Query() input: unknown, @Res() res: Response) {
    parse(SafeId, id);
    const q = parse(z.strictObject({ sourceId: SafeId, receivedAt: Iso }), input);
    const result = await this.infra.pool.query(
      "SELECT bucket,object_key,checksum,expire_at FROM archive_batches WHERE source_id=$1 AND min_received_at<=$2::timestamptz AND max_received_at>=$2::timestamptz AND status='committed' AND expire_at>now() ORDER BY first_sequence LIMIT 100",
      [q.sourceId, q.receivedAt],
    );
    for (const manifest of result.rows) {
      const records = await readArchive(this.infra, {
        bucket: manifest.bucket,
        objectKey: manifest.object_key,
        checksum: manifest.checksum,
        expireAt: isoValue(manifest.expire_at),
      });
      const raw = records.find(
        (r) =>
          r.captureId === id &&
          r.sourceId === q.sourceId &&
          Date.parse(r.receivedAt) === Date.parse(q.receivedAt),
      );
      if (raw) {
        const payload = await loadRawPayload(this.infra, raw);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        res.setHeader('Cache-Control', 'no-store');
        return res.send(
          JSON.stringify({
            captureId: raw.captureId,
            sourceId: raw.sourceId,
            receivedAt: raw.receivedAt,
            responseMeta: raw.responseMeta,
            payload,
          }),
        );
      }
    }
    throw new NotFoundException('Capture absent or archive expired');
  }
}
