import { projectCircleRegion } from './agent-focus';
import { z } from 'zod';
import {
  AgentQueryResultSchema,
  AgentSelectionSchema,
  type AgentQueryResult,
} from '../contracts/agent';
import type { Infrastructure } from './clients';
import { FusionDatasetLimitError } from './fusion-data';
import { resolveVesselTracksSelector } from './vessel-tracks';

/** Empty user selection means all; an empty type intersection means no matching vessels. */
export async function resolveAgentAnalysisMmsis(
  infra: Infrastructure,
  selection: z.infer<typeof AgentSelectionSchema>,
  maxRecords = 50000,
): Promise<string[] | undefined> {
  const selected = selection.mmsis?.length ? selection.mmsis : undefined;
  if (selection.filters?.shipType === undefined) return selected;
  const result = await infra.pool.query<{ mmsi: string }>(
    'SELECT mmsi FROM vessels WHERE ship_type=$1 AND ($2::text[] IS NULL OR mmsi=ANY($2::text[])) ORDER BY mmsi LIMIT $3',
    [selection.filters.shipType, selected ?? null, maxRecords + 1],
  );
  if (result.rows.length > maxRecords) throw new FusionDatasetLimitError();
  return result.rows.map((row) => row.mmsi);
}

const QueryInputSchema = z.strictObject({
  kind: z.enum(['vessel_list', 'vessel_detail']),
  inputRevision: z.number().int().nonnegative(),
  selection: AgentSelectionSchema,
});

export class AgentCircleAnchorUnavailableError extends Error {
  readonly code = 'anchor_position_unavailable';
  constructor(readonly mmsi: string) {
    super(`船舶 ${mmsi} 在当前船位时间窗口内没有有效船位，暂时无法确定圆形区域中心。`);
  }
}

/** Query real vessels, never rendered map clusters. Count and rows share one SQL snapshot. */
export async function queryAgentVessels(
  infra: Infrastructure,
  input: z.infer<typeof QueryInputSchema>,
  options: { signal?: AbortSignal } = {},
): Promise<AgentQueryResult> {
  const parsed = QueryInputSchema.parse(input);
  const { kind, inputRevision } = parsed;
  const vesselCircle = parsed.selection.vesselCircle;
  // A host-resolved vessel anchor takes precedence over every captured or previously resolved region.
  const selection = vesselCircle
    ? { ...parsed.selection, bbox: undefined, region: undefined }
    : parsed.selection;
  if (vesselCircle) {
    if (selection.mmsis?.length === 1 && selection.mmsis[0] === vesselCircle.mmsi)
      selection.mmsis = undefined;
    if (
      selection.vesselSelector?.mmsis?.length === 1 &&
      selection.vesselSelector.mmsis[0] === vesselCircle.mmsi
    ) {
      const remaining = { ...selection.vesselSelector, mmsis: undefined };
      selection.vesselSelector =
        remaining.model || remaining.query || remaining.shipTypes?.length ? remaining : undefined;
    }
  }
  if (kind === 'vessel_list' && !selection.bbox && !selection.region && !vesselCircle)
    throw new Error('region_required');
  if (
    kind === 'vessel_detail' &&
    !selection.mmsis?.length &&
    !selection.vesselSelector?.mmsis?.length &&
    !selection.vesselSelector?.query &&
    !selection.vesselSelector?.model
  )
    throw new Error('vessels_required');
  let selectedMmsis: string[] | null = selection.mmsis?.length ? selection.mmsis : null;
  if (
    selection.vesselSelector &&
    (selection.vesselSelector.model ||
      selection.vesselSelector.query ||
      selection.vesselSelector.mmsis)
  ) {
    const profiles = await resolveVesselTracksSelector(
      infra,
      selection.vesselSelector,
      options.signal ?? new AbortController().signal,
    );
    const resolved = new Set(profiles.map((profile) => profile.mmsi));
    selectedMmsis = selectedMmsis
      ? selectedMmsis.filter((mmsi) => resolved.has(mmsi))
      : [...resolved];
  }
  const values: unknown[] = [
    selection.filters?.hours ?? 24,
    selection.filters?.sourceId ?? null,
    selection.filters?.shipType ?? null,
    selectedMmsis,
  ];
  const filters = [
    '($2::text IS NULL OR p.source_id=$2)',
    '($3::integer IS NULL OR v.ship_type=$3)',
    '($4::text[] IS NULL OR v.mmsi=ANY($4::text[]))',
  ];
  let anchorCte = '';
  let anchorProjection = 'NULL AS anchor_position,';
  if (kind === 'vessel_list') filters.push('p.mmsi IS NOT NULL');
  if (selection.bbox) {
    const [west, south, east, north] = selection.bbox;
    values.push(west, south, east, north);
    filters.push(
      `p.latitude BETWEEN $6 AND $8 AND (p.longitude >= $5 ${west <= east ? 'AND' : 'OR'} p.longitude <= $7)`,
    );
  }
  if (vesselCircle) {
    values.push(vesselCircle.mmsi, vesselCircle.radiusMeters);
    const n = values.length;
    anchorCte = `anchor AS MATERIALIZED (
      SELECT p.longitude,p.latitude,p.observed_at,p.source_id FROM positions_latest p
      WHERE p.mmsi=$${n - 1} AND p.observed_at>=now()-make_interval(hours=>$1)
        AND p.observed_at<=now()
    ), `;
    anchorProjection = `(SELECT jsonb_build_object('longitude',longitude,'latitude',latitude,
      'observedAt',observed_at,'sourceId',source_id) FROM anchor) AS anchor_position,`;
    filters.push(`EXISTS (SELECT 1 FROM anchor a WHERE
      ST_DWithin(ST_SetSRID(ST_MakePoint(p.longitude,p.latitude),4326)::geography,
        ST_SetSRID(ST_MakePoint(a.longitude,a.latitude),4326)::geography,$${n}))`);
  } else if (selection.region?.kind === 'circle') {
    const { center, radiusMeters } = selection.region;
    values.push(center[0], center[1], radiusMeters);
    const n = values.length;
    filters.push(
      `ST_DWithin(ST_SetSRID(ST_MakePoint(p.longitude,p.latitude),4326)::geography, ST_SetSRID(ST_MakePoint($${n - 2},$${n - 1}),4326)::geography, $${n})`,
    );
  } else if (selection.region?.kind === 'polygon') {
    values.push(JSON.stringify(selection.region.geometry));
    filters.push(
      `ST_Intersects(ST_SetSRID(ST_MakePoint(p.longitude,p.latitude),4326),ST_SetSRID(ST_GeomFromGeoJSON($${values.length}),4326))`,
    );
  } else if (selection.region?.kind === 'bbox') {
    const [west, south, east, north] = selection.region.bbox;
    values.push(west, south, east, north);
    const n = values.length;
    filters.push(
      `p.latitude BETWEEN $${n - 2} AND $${n} AND (p.longitude >= $${n - 3} ${west <= east ? 'AND' : 'OR'} p.longitude <= $${n - 1})`,
    );
  }
  if (selection.vesselSelector?.shipTypes?.length) {
    values.push(selection.vesselSelector.shipTypes);
    filters.push(`v.ship_type=ANY($${values.length}::integer[])`);
  }
  const result = await infra.pool.query<{
    total: string;
    items: AgentQueryResult['items'];
    as_of: Date;
    anchor_position?: {
      longitude: number;
      latitude: number;
      observedAt: string;
      sourceId: string;
    } | null;
  }>(
    `WITH ${anchorCte}eligible AS MATERIALIZED (
      SELECT v.mmsi,v.name,v.imo,v.ship_type AS "shipType",
        CASE WHEN p.mmsi IS NULL THEN NULL ELSE jsonb_build_object(
          'lat',p.latitude,'lon',p.longitude,'observedAt',p.observed_at,
          'sogKnots',p.sog,'sourceId',p.source_id) END AS "latestPosition"
      FROM vessels v LEFT JOIN positions_latest p ON p.mmsi=v.mmsi
        AND p.observed_at>=now()-make_interval(hours=>$1) AND p.observed_at<=now()
      WHERE ${filters.join(' AND ')}
    ), selected AS (SELECT * FROM eligible ORDER BY mmsi LIMIT 100)
    SELECT ${anchorProjection} (SELECT count(*) FROM eligible)::text AS total,
      COALESCE((SELECT jsonb_agg(to_jsonb(selected) ORDER BY mmsi) FROM selected),'[]'::jsonb) AS items,
      statement_timestamp() AS as_of`,
    values,
  );
  const row = result.rows[0]!;
  if (vesselCircle && !row.anchor_position)
    throw new AgentCircleAnchorUnavailableError(vesselCircle.mmsi);
  const regionAnchor =
    vesselCircle && row.anchor_position
      ? {
          mmsi: vesselCircle.mmsi,
          observedAt: new Date(row.anchor_position.observedAt).toISOString(),
          sourceId: row.anchor_position.sourceId,
        }
      : undefined;
  const resolvedSelection =
    vesselCircle && row.anchor_position
      ? {
          ...selection,
          region: {
            kind: 'circle' as const,
            center: [row.anchor_position.longitude, row.anchor_position.latitude] as [
              number,
              number,
            ],
            radiusMeters: vesselCircle.radiusMeters,
          },
        }
      : selection;
  const items = row.items.map((item) => ({
    ...item,
    latestPosition: item.latestPosition
      ? {
          ...item.latestPosition,
          observedAt: new Date(item.latestPosition.observedAt).toISOString(),
        }
      : null,
  }));
  const regionGeometry =
    resolvedSelection.region?.kind === 'circle'
      ? await projectCircleRegion(infra, resolvedSelection.region)
      : undefined;
  return AgentQueryResultSchema.parse({
    ...(regionGeometry ? { regionGeometry } : {}),
    ...(regionAnchor ? { regionAnchor } : {}),
    kind,
    version: 0,
    inputRevision,
    total: Number(row.total),
    truncated: Number(row.total) > items.length,
    items,
    asOf: row.as_of.toISOString(),
    selection: resolvedSelection,
  });
}
