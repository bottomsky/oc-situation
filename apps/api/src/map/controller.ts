import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Infrastructure } from '@ais/infrastructure';
import { z } from 'zod';
import type { MapResponse } from '@ais/contracts';
import { DocumentQuery, DocumentRoute, INFRA } from '../common';
import { bounds, MapQuerySchema, parseMapQuery } from './query';
export const MapResponseSchema = z.object({
  items: z.array(
    z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('point'),
        mmsi: z.string(),
        lat: z.number(),
        lon: z.number(),
        observedAt: z.string(),
        sourceId: z.string(),
        sogKnots: z.number().nullable(),
        cogDegrees: z.number().nullable(),
        headingDegrees: z.number().min(0).lt(360).nullable(),
        quality: z.array(z.string()),
      }),
      z.object({
        kind: z.literal('cluster'),
        clusterId: z.string(),
        lat: z.number(),
        lon: z.number(),
        count: z.number(),
        bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
      }),
    ]),
  ),
  sampled: z.boolean(),
  truncated: z.boolean(),
  total: z.number(),
  generatedAt: z.iso.datetime(),
});
@Controller('map')
export class MapController {
  constructor(@Inject(INFRA) private readonly infra: Infrastructure) {}
  @Get()
  @DocumentQuery(MapQuerySchema)
  @DocumentRoute('Current vessel positions or server side spatial grid', MapResponseSchema)
  async get(@Query() query: unknown): Promise<MapResponse> {
    const q = parseMapQuery(query);
    const regions = bounds(q.bbox);
    const values: unknown[] = [q.hours, q.sourceId ?? null, q.shipType ?? null];
    const spatial = regions
      .map((b) => {
        const offset = values.length;
        values.push(...b);
        return `ST_Intersects(p.location::geometry,ST_MakeEnvelope($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},4326))`;
      })
      .join(' OR ');
    const where = `p.observed_at>=now()-make_interval(hours=>$1) AND ($2::text IS NULL OR p.source_id=$2) AND ($3::integer IS NULL OR v.ship_type=$3) AND (${spatial})`;
    if (q.zoom < 7) {
      const grid = 360 / 2 ** (Math.floor(q.zoom) + 5);
      values.push(grid);
      const parameter = `$${values.length}::double precision`;
      const result = await this.infra.pool.query(
        `WITH cells AS (SELECT floor(p.longitude/${parameter}) AS x,floor(p.latitude/${parameter}) AS y,count(*)::int AS count,avg(p.latitude) AS lat,avg(p.longitude) AS lon,min(p.longitude) AS west,min(p.latitude) AS south,max(p.longitude) AS east,max(p.latitude) AS north FROM positions_latest p JOIN vessels v USING(mmsi) WHERE ${where} GROUP BY x,y) SELECT *,sum(count) OVER() AS total,count(*) OVER() AS cells FROM cells ORDER BY x,y LIMIT 5000`,
        values,
      );
      return {
        items: result.rows.map((r) => ({
          kind: 'cluster',
          clusterId: `${Math.floor(q.zoom)}:${r.x}:${r.y}`,
          lat: r.lat,
          lon: r.lon,
          count: r.count,
          bbox: [r.west, r.south, r.east, r.north],
        })),
        sampled: false,
        truncated: Number(result.rows[0]?.cells ?? 0) > 5000,
        total: Number(result.rows[0]?.total ?? 0),
        generatedAt: new Date().toISOString(),
      };
    }
    const result = await this.infra.pool.query(
      `SELECT p.observation,count(*) OVER() AS total FROM positions_latest p JOIN vessels v USING(mmsi) WHERE ${where} ORDER BY p.mmsi LIMIT 5000`,
      values,
    );
    return {
      items: result.rows.map((r) => ({
        kind: 'point',
        mmsi: r.observation.mmsi,
        lat: r.observation.lat,
        lon: r.observation.lon,
        observedAt: r.observation.observedAt,
        sourceId: r.observation.sourceId,
        sogKnots: r.observation.sogKnots,
        cogDegrees: r.observation.cogDegrees,
        headingDegrees: r.observation.headingDegrees ?? null,
        quality: r.observation.quality,
      })),
      sampled: false,
      truncated: Number(result.rows[0]?.total ?? 0) > 5000,
      total: Number(result.rows[0]?.total ?? 0),
      generatedAt: new Date().toISOString(),
    };
  }
}
