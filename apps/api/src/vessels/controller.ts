import { Controller, Get, Inject, NotFoundException, Param, Query } from '@nestjs/common';
import { ApiParam, ApiQuery } from '@nestjs/swagger';
import type { Infrastructure } from '@ais/infrastructure';
import { MmsiSchema, PositionObservationSchema, type TrackResponse } from '@ais/contracts';
import { DocumentQuery, DocumentRoute, INFRA, PageResponse, parse, isoValue } from '../common';
import {
  VesselDetailSchema,
  VesselQuerySchema,
  VesselSchema,
  TrackQuerySchema,
  TrackResponseSchema,
} from './schemas';
export const TRACK_SQL = `WITH dedup AS (
 SELECT *,row_number() OVER (PARTITION BY observedAt ORDER BY sourcePriority DESC,eventId DESC) AS preference
 FROM positions FINAL WHERE mmsi={mmsi:String} AND observedAt>=parseDateTime64BestEffort({from:String}) AND observedAt<=parseDateTime64BestEffort({to:String})
), selected AS (SELECT * FROM dedup WHERE preference=1), previous AS (
 SELECT *,lagInFrame(observedAt,1,observedAt) OVER (ORDER BY observedAt ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS prevTime,
 lagInFrame(longitude,1,longitude) OVER (ORDER BY observedAt ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS prevLon FROM selected
), grouped AS (
 SELECT *,sum(if(dateDiff('second',prevTime,observedAt)>1800 OR abs(longitude-prevLon)>180,1,0)) OVER(ORDER BY observedAt) AS segment FROM previous
), ranked AS (
 SELECT *,row_number() OVER(PARTITION BY segment ORDER BY observedAt) AS ordinal,count() OVER(PARTITION BY segment) AS segmentCount,count() OVER() AS total FROM grouped
), endpoints AS (SELECT segment,any(segmentCount) AS n FROM ranked GROUP BY segment), budget AS (
 SELECT segment,n,sum(least(n,2)) OVER() AS minimum,sum(least(n,2)) OVER(ORDER BY segment) AS minimumThrough,sum(n) OVER() AS totalPoints FROM endpoints
), allocated AS (
 SELECT r.*,b.minimum,b.minimumThrough,
 if(b.minimum>{max:UInt32},least(segmentCount,toUInt64(2)),least(segmentCount,toUInt64(2))+toUInt64(floor(greatest(toInt64({max:UInt32})-toInt64(b.minimum),0)*greatest(toInt64(segmentCount)-2,0)/greatest(toInt64(b.totalPoints)-toInt64(b.minimum),1)))) AS allowance
 FROM ranked r JOIN budget b USING(segment)
) SELECT observation,segment,total,minimum FROM allocated
 WHERE minimumThrough<= {max:UInt32} AND (ordinal=1 OR ordinal=segmentCount OR (allowance>2 AND floor((ordinal-2)*(allowance-2)/greatest(segmentCount-2,1))>floor((ordinal-3)*(allowance-2)/greatest(segmentCount-2,1))))
 ORDER BY observedAt LIMIT {max:UInt32}`;
@Controller('vessels')
export class VesselsController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(VesselQuerySchema)
  @DocumentRoute('Search vessel static fields with MMSI cursor', PageResponse(VesselSchema))
  async list(@Query() query: unknown) {
    const q = parse(VesselQuerySchema, query);
    const result = await this.infra.pool.query(
      `SELECT v.mmsi,v.static_data,p.observation FROM vessels v LEFT JOIN positions_latest p ON p.mmsi=v.mmsi AND p.observed_at>=now()-interval '30 days'
    WHERE ($1::text IS NULL OR v.mmsi>$1) AND ($2::text IS NULL OR v.mmsi=$2) AND ($3::text IS NULL OR v.name ILIKE '%'||$3||'%') AND ($4::text IS NULL OR v.imo=$4)
    AND ($5::text IS NULL OR v.mmsi LIKE '%'||$5||'%' OR v.name ILIKE '%'||$5||'%' OR v.imo LIKE '%'||$5||'%') ORDER BY v.mmsi LIMIT $6`,
      [
        q.cursor ?? null,
        q.mmsi ?? null,
        q.name ?? null,
        q.imo ?? null,
        q.query ?? null,
        q.limit + 1,
      ],
    );
    const hasNext = result.rows.length > q.limit;
    const items = result.rows.slice(0, q.limit).map((r) => ({
      mmsi: r.mmsi,
      staticFields: r.static_data,
      latestPosition: r.observation ?? null,
    }));
    return { items, nextCursor: hasNext ? items.at(-1)!.mmsi : null };
  }
  @Get(':mmsi')
  @ApiParam({ name: 'mmsi', schema: { type: 'string', pattern: '^[1-9][0-9]{8}$' } })
  @DocumentRoute('Latest position, static fields and field provenance', VesselDetailSchema)
  async detail(@Param('mmsi') input: string) {
    const mmsi = parse(MmsiSchema, input);
    const result = await this.infra.pool.query(
      "SELECT v.mmsi,v.static_data,p.observation FROM vessels v LEFT JOIN positions_latest p ON p.mmsi=v.mmsi AND p.observed_at>=now()-interval '30 days' WHERE v.mmsi=$1",
      [mmsi],
    );
    if (!result.rows[0]) throw new NotFoundException('Vessel not found');
    const rows = await this.infra.pool.query(
      'SELECT field,source_id,source_kind,source_priority,event_id,observed_at,received_at FROM field_provenance WHERE mmsi=$1',
      [mmsi],
    );
    const provenance = Object.fromEntries(
      rows.rows.map((r) => [
        r.field,
        {
          sourceId: r.source_id,
          sourceKind: r.source_kind,
          sourcePriority: r.source_priority,
          eventId: r.event_id,
          observedAt: r.observed_at ? isoValue(r.observed_at) : null,
          receivedAt: isoValue(r.received_at),
        },
      ]),
    );
    return {
      mmsi,
      staticFields: result.rows[0].static_data,
      latestPosition: result.rows[0].observation ?? null,
      provenance,
    };
  }
  @Get(':mmsi/track')
  @ApiParam({ name: 'mmsi', type: String })
  @ApiQuery({ name: 'from', type: String })
  @ApiQuery({ name: 'to', type: String })
  @ApiQuery({
    name: 'maxPoints',
    required: false,
    schema: { type: 'integer', minimum: 2, maximum: 5000, default: 2000 },
  })
  @DocumentRoute('Bounded native observations grouped by gaps and date line', TrackResponseSchema)
  async track(@Param('mmsi') input: string, @Query() query: unknown): Promise<TrackResponse> {
    const mmsi = parse(MmsiSchema, input);
    const q = parse(TrackQuerySchema, query);
    const response = await this.infra.clickhouse.query({
      query: TRACK_SQL,
      format: 'JSONEachRow',
      query_params: { mmsi, from: q.from, to: q.to, max: q.maxPoints },
    });
    const rows = await response.json<{
      observation: string;
      segment: string;
      total: string;
      minimum: string;
    }>();
    const segments: TrackResponse['segments'] = [];
    let previous: string | undefined;
    for (const row of rows) {
      if (row.segment !== previous) {
        segments.push({ points: [] });
        previous = row.segment;
      }
      segments.at(-1)!.points.push(parse(PositionObservationSchema, JSON.parse(row.observation)));
    }
    const total = Number(rows[0]?.total ?? 0);
    return {
      mmsi,
      from: q.from,
      to: q.to,
      segments,
      total,
      returned: rows.length,
      sampled: total > rows.length,
      truncated: Number(rows[0]?.minimum ?? 0) > q.maxPoints,
    };
  }
}
