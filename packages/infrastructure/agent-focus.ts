import { CircleRegionSchema, type CircleRegion } from '../contracts/spatial';
import { GeometrySchema, type IntelligenceGeometry } from '../contracts/intelligence-spatial';
import type { Infrastructure } from './clients';
/** PostGIS geography uses the same spheroid as ST_DWithin. */
export async function projectCircleRegion(
  infra: Infrastructure,
  input: CircleRegion,
): Promise<IntelligenceGeometry> {
  const region = CircleRegionSchema.parse(input);
  const result = await infra.pool.query<{ geometry: unknown }>(
    `WITH boundary AS (
 SELECT i, ST_Project(ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,$3::double precision,2*pi()*i/128)::geometry AS p FROM generate_series(0,127) i
 ), ring AS (SELECT ST_MakeLine(p ORDER BY i) AS line FROM boundary)
 SELECT ST_AsGeoJSON(ST_MakePolygon(ST_AddPoint(line,ST_StartPoint(line))))::jsonb AS geometry FROM ring`,
    [...region.center, region.radiusMeters],
  );
  return GeometrySchema.parse(result.rows[0]?.geometry);
}
