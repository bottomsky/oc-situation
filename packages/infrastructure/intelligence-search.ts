import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  AgentIntelligenceResultSchema,
  IntelligenceSearchResultSchema,
  IntelligenceSearchSpecSchema,
  type AgentIntelligenceResult,
  type IntelligenceSearchSpec,
  type IntelligenceSearchResult,
  type IntelligenceSourceHealth,
  type IntelligenceSearchItem,
} from '../contracts/intelligence-search';
import type { AgentSelection } from '../contracts/agent';
import { GeometrySchema } from '../contracts/intelligence-spatial';
import type { IntelligenceEvent } from '../contracts/intelligence';
import type { Infrastructure } from './clients';
import { readMarineForecasts } from './intelligence-weather';

type DB = Pick<PoolClient, 'query'>;
export class IntelligenceSearchError extends Error {}
/** Exact registered names/aliases are resolved locally; ambiguous matches are returned for human selection. */
export async function resolveIntelligenceObjects(
  infra: Infrastructure,
  text: string,
  db: DB = infra.pool,
): Promise<{ id: string; name: string }[]> {
  const result = await db.query(
    `WITH matches AS (
       SELECT obj.id,obj.name,lower(names.alias) AS alias FROM intelligence_objects obj
       CROSS JOIN LATERAL (SELECT obj.name AS alias UNION ALL
         SELECT jsonb_array_elements_text(coalesce(obj.data->'aliases','[]'::jsonb))) names
       WHERE obj.kind IN ('port','channel','area','facility')
         AND char_length(names.alias)>=2 AND strpos(lower($1),lower(names.alias))>0
     ) SELECT DISTINCT id,name FROM matches current
       WHERE NOT EXISTS(SELECT 1 FROM matches longer
         WHERE char_length(longer.alias)>char_length(current.alias)
           AND strpos(longer.alias,current.alias)>0)
       ORDER BY name,id LIMIT 21`,
    [text.slice(0, 4000)],
  );
  return result.rows.map((row) => ({ id: String(row.id), name: String(row.name) }));
}
const iso = (value: string | Date) => new Date(value).toISOString();
const clean = (value: string) =>
  value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const escaped = (value: string) => value.replace(/[\\%_]/g, '\\$&');
const groups = [
  ['航运事故', '船舶事故', '事故', 'accident', 'collision', 'grounding', 'shipwreck', 'casualty'],
  ['航行警告', '航警', 'navigation warning', 'notice to mariners'],
  ['台风', 'typhoon', 'cyclone', 'tropical storm'],
  ['海啸', 'tsunami'],
  ['洪水', 'flood'],
  ['地震', 'earthquake'],
  ['封港', '港口关闭', 'port closure', 'port closed'],
  ['罢工', 'strike'],
  ['航运', '海事', 'shipping', 'maritime'],
];
export function intelligenceSearchTerms(keyword: string): string[] {
  const text = clean(keyword).toLowerCase();
  if (!text) return [];
  const expanded = groups
    .filter((group) => group.some((term) => text.includes(term)))
    .flatMap((group) => group);
  return [...new Set([text, ...expanded])].slice(0, 20);
}
export function intelligenceTextPredicate(
  keyword: string,
  add: (value: unknown) => string,
  expand = true,
) {
  const terms = expand ? intelligenceSearchTerms(keyword) : [clean(keyword)];
  return (
    '(' +
    terms
      .map((term) => `e.search_text ILIKE ${add('%' + escaped(term) + '%')} ESCAPE '\\'`)
      .join(' OR ') +
    ')'
  );
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
interface SearchCursor {
  v: 1;
  asOf: string;
  fingerprint: string;
  score: number;
  published: string;
  id: string;
}
function decodeCursor(value: string): SearchCursor {
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as SearchCursor;
    if (
      cursor.v !== 1 ||
      !Number.isFinite(cursor.score) ||
      typeof cursor.id !== 'string' ||
      typeof cursor.fingerprint !== 'string' ||
      !Number.isFinite(Date.parse(cursor.asOf)) ||
      !Number.isFinite(Date.parse(cursor.published))
    )
      throw new Error();
    return cursor;
  } catch {
    throw new IntelligenceSearchError('Invalid search cursor');
  }
}
async function sourceHealth(
  db: DB,
  ids?: string[],
  now = new Date(),
): Promise<IntelligenceSourceHealth[]> {
  const rows = await db.query(
    "SELECT id,config,last_polled_at,last_successful_at,last_error,next_poll_at FROM intelligence_sources WHERE ($1::text[] IS NULL OR id=ANY($1::text[])) AND ($1::text[] IS NOT NULL OR config->>'kind'<>'fixture') ORDER BY id",
    [ids?.length ? ids : null],
  );
  return rows.rows.map((row) => {
    const enabled = row.config.enabled !== false;
    const age = row.last_successful_at
      ? now.getTime() - new Date(row.last_successful_at).getTime()
      : Infinity;
    return {
      sourceId: row.id,
      name: row.config.name ?? row.id,
      enabled,
      visibility: row.config.visibility === 'public' ? 'public' : 'internal',
      status: !enabled
        ? 'disabled'
        : row.last_error
          ? 'unavailable'
          : row.config.kind === 'manual'
            ? 'ready'
            : !row.last_successful_at
              ? 'never_collected'
              : age > Math.max(60, Number(row.config.pollSeconds ?? 300) * 2) * 1000
                ? 'stale'
                : 'ready',
      lastPolledAt: row.last_polled_at ? iso(row.last_polled_at) : null,
      lastSuccessfulAt: row.last_successful_at ? iso(row.last_successful_at) : null,
      nextPollAt: row.next_poll_at ? iso(row.next_poll_at) : null,
      lastError: row.last_error ? '来源采集异常，请查看来源状态' : null,
    } satisfies IntelligenceSourceHealth;
  });
}
export async function getIntelligenceSourceHealth(
  infra: Infrastructure,
  ids?: string[],
  now = new Date(),
) {
  return sourceHealth(infra.pool, ids, now);
}

export async function searchIntelligence(
  infra: Infrastructure,
  input: IntelligenceSearchSpec,
  options: { limit?: number; cursor?: string; now?: Date } = {},
): Promise<IntelligenceSearchResult> {
  const cursor = options.cursor ? decodeCursor(options.cursor) : null;
  const now = cursor ? new Date(cursor.asOf) : (options.now ?? new Date());
  const parsed = IntelligenceSearchSpecSchema.parse(input);
  const spec: IntelligenceSearchSpec = {
    ...parsed,
    kind: parsed.kind ?? 'events',
    timeMode: parsed.timeMode ?? 'published',
    from: parsed.from ?? new Date(now.getTime() - 7 * 86400_000).toISOString(),
    to: parsed.to ?? now.toISOString(),
    ...(parsed.sourceIds ? { sourceIds: [...new Set(parsed.sourceIds)].sort() } : {}),
    ...(parsed.mmsis ? { mmsis: [...new Set(parsed.mmsis)].sort() } : {}),
  };
  IntelligenceSearchSpecSchema.parse(spec);
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));
  const fingerprint = createHash('sha256').update(stable(spec)).digest('hex');
  if (cursor && cursor.fingerprint !== fingerprint)
    throw new IntelligenceSearchError('Cursor does not belong to these search conditions');
  const client = await infra.pool.connect();
  let items: IntelligenceSearchItem[] = [],
    total = 0,
    nextCursor: string | null = null;
  let health: IntelligenceSourceHealth[];
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await client.query("SET LOCAL statement_timeout='8s'");
    health = await sourceHealth(client, spec.sourceIds, now);
    if (spec.kind !== 'marine') {
      const values: unknown[] = [];
      const add = (value: unknown) => {
        values.push(value);
        return `$${values.length}`;
      };
      const terms = intelligenceSearchTerms(spec.keyword ?? '');
      const termParameters = terms.map((term) => add(`%${escaped(term)}%`));
      const textMatches = termParameters.map(
        (parameter) => `e.search_text ILIKE ${parameter} ESCAPE '\\'`,
      );
      const titleMatches = termParameters.map(
        (parameter) => `e.event->>'title' ILIKE ${parameter} ESCAPE '\\'`,
      );
      const textScore = terms.length
        ? `CASE WHEN (${titleMatches.join(' OR ')}) THEN 30 ELSE 10 END`
        : '0';
      const anchor = add(now.toISOString());
      const conditions = [
        `e.version=(SELECT max(x.version) FROM intelligence_events x WHERE x.source_id=e.source_id AND x.external_id=e.external_id AND x.created_at<=${anchor}::timestamptz)`,
        "e.event->>'status'<>'withdrawn'",
        "COALESCE(review.review_status,e.event->>'reviewStatus','confirmed')<>'rejected'",
        `e.created_at<=${anchor}::timestamptz`,
      ];
      if (!spec.sourceIds?.length) conditions.push("src.config->>'kind'<>'fixture'");
      if (textMatches.length) conditions.push(`(${textMatches.join(' OR ')})`);
      if (spec.sourceIds?.length)
        conditions.push(`e.source_id=ANY(${add(spec.sourceIds)}::text[])`);
      if (spec.category) conditions.push(`e.event->>'category'=${add(spec.category)}`);
      if (spec.reviewStatus)
        conditions.push(
          `COALESCE(review.review_status,e.event->>'reviewStatus','confirmed')=${add(spec.reviewStatus)}`,
        );
      if (spec.timeMode === 'effective') {
        conditions.push(
          "(coalesce(e.event->'raw'->>'requiresEffectiveTimeReview','false')<>'true' OR e.event->'raw'->>'manualTimeConfirmed'='true')",
        );
        conditions.push(
          "(coalesce(e.event->'raw'->>'requiresOccurrenceTimeReview','false')<>'true' OR e.event->'raw'->>'manualTimeConfirmed'='true')",
        );
        conditions.push(
          "coalesce(e.event->'raw'->>'timeBasis','publication') NOT IN ('unknown','provider-index-observation-only')",
        );
        conditions.push(
          `(e.effective_to IS NULL OR e.effective_to>=${add(spec.from)}::timestamptz)`,
        );
        conditions.push(`e.effective_from<=${add(spec.to)}::timestamptz`);
      } else {
        const column = spec.timeMode === 'observed' ? 'e.created_at' : 'e.published_at';
        conditions.push(
          `${column}>=${add(spec.from)}::timestamptz AND ${column}<=${add(spec.to)}::timestamptz`,
        );
      }
      const relations = `(SELECT DISTINCT ON(r.id) r.* FROM intelligence_relations r WHERE r.event_id=e.id AND r.recorded_at<=${anchor}::timestamptz ORDER BY r.id,r.revision DESC)`;
      const goodRelation = "rel.data->>'reviewStatus'<>'rejected'";
      let spatialHit = 'false',
        objectHit = 'false',
        mentionHit = 'false';
      if (spec.bbox) {
        const [w, s, e, n] = spec.bbox;
        const west = add(w),
          south = add(s),
          east = add(e),
          north = add(n);
        const envelope =
          w <= e
            ? `ST_MakeEnvelope(${west},${south},${east},${north},4326)`
            : `ST_Collect(ST_MakeEnvelope(${west},${south},180,${north},4326),ST_MakeEnvelope(-180,${south},${east},${north},4326))`;
        spatialHit = `EXISTS(SELECT 1 FROM ${relations} rel LEFT JOIN intelligence_objects obj ON obj.id=rel.data->>'objectId' WHERE ${goodRelation} AND rel.data->>'kind' IN ('occurs-at','applies-to','impacts') AND ST_Intersects(COALESCE(rel.geom,obj.geom),${envelope}))`;
      }
      if (spec.locationKeyword)
        mentionHit = `e.search_text ILIKE ${add('%' + escaped(spec.locationKeyword) + '%')} ESCAPE '\\'`;
      if (spec.bbox) conditions.push(`(${spatialHit} OR ${mentionHit})`);
      else if (spec.locationKeyword) conditions.push(mentionHit);
      const objectClauses: string[] = [];
      if (spec.objectId) objectClauses.push(`rel.data->>'objectId'=${add(spec.objectId)}`);
      if (spec.mmsis?.length)
        objectClauses.push(`obj.data->>'mmsi'=ANY(${add(spec.mmsis)}::text[])`);
      if (objectClauses.length) {
        objectHit = `EXISTS(SELECT 1 FROM ${relations} rel LEFT JOIN intelligence_objects obj ON obj.id=rel.data->>'objectId' WHERE ${goodRelation} AND (${objectClauses.join(' OR ')}))`;
        conditions.push(objectHit);
      }
      const matchBasis = `CASE WHEN ${spatialHit} THEN 'geometry' WHEN ${objectHit} THEN 'object' WHEN ${mentionHit} THEN 'mention' ELSE '${terms.length ? 'keyword' : 'none'}' END`;
      const geometry = `(SELECT ST_AsGeoJSON(COALESCE(rel.geom,obj.geom))::jsonb FROM ${relations} rel LEFT JOIN intelligence_objects obj ON obj.id=rel.data->>'objectId' WHERE ${goodRelation} AND rel.data->>'kind' IN ('occurs-at','applies-to','impacts') AND COALESCE(rel.geom,obj.geom) IS NOT NULL LIMIT 1)`;
      // Editorial priority uses recorded geometry, never a place-name guess or current vessel position.
      const nearChina = `EXISTS(SELECT 1 FROM ${relations} rel LEFT JOIN intelligence_objects obj ON obj.id=rel.data->>'objectId' WHERE ${goodRelation} AND rel.data->>'kind' IN ('occurs-at','applies-to','impacts') AND ST_Intersects(COALESCE(rel.geom,obj.geom),ST_MakeEnvelope(105,3,135,45,4326)))`;
      const score = `(${textScore}) + CASE WHEN ${nearChina} THEN 3 ELSE 0 END`;
      const snippet = terms.length
        ? `substring(e.search_text from greatest(strpos(lower(e.search_text),${add(terms[0])})-120,1) for 500)`
        : 'left(e.search_text,500)';
      let after = '';
      if (cursor) {
        const rank = add(cursor.score),
          published = add(cursor.published),
          id = add(cursor.id);
        after = `WHERE (score<${rank} OR (score=${rank} AND published_at<${published}::timestamptz) OR (score=${rank} AND published_at=${published}::timestamptz AND id>${id}))`;
      }
      const count = add(limit + 1);
      const response = await client.query<{
        total: string;
        items: {
          id: string;
          source_id: string;
          source_name: string;
          visibility: string;
          event: IntelligenceEvent;
          geometry: unknown;
          review_status: IntelligenceSearchItem['reviewStatus'];
          match_basis: IntelligenceSearchItem['matchBasis'];
          snippet: string;
          score: number;
          published_at: string;
          created_at: string;
          time_basis: string | null;
          effective_time_pending: boolean;
        }[];
      }>(
        `WITH eligible AS MATERIALIZED (
        SELECT e.id,e.source_id,coalesce(src.config->>'name',e.source_id) source_name,
          CASE WHEN src.config->>'visibility'='public' THEN 'public' ELSE 'internal' END visibility,
          e.event-'raw'-'paragraphs' event,e.published_at,e.created_at,
          coalesce(e.event->'raw'->>'timeBasis',CASE WHEN e.event->'raw'->>'provider'='GDACS' AND e.event->'raw'->'properties'->>'datemodified' IS NOT NULL THEN 'effective' END) time_basis,
          ((coalesce(e.event->'raw'->>'requiresEffectiveTimeReview','false')='true' OR coalesce(e.event->'raw'->>'requiresOccurrenceTimeReview','false')='true' OR e.event->'raw'->>'effectiveTimeBasis'='publication-observation-only') AND coalesce(e.event->'raw'->>'manualTimeConfirmed','false')<>'true') effective_time_pending,
          COALESCE(review.review_status,e.event->>'reviewStatus','confirmed') review_status,
          ${score} score,${matchBasis} match_basis,${geometry} geometry,${snippet} snippet
        FROM intelligence_events e JOIN intelligence_sources src ON src.id=e.source_id
        LEFT JOIN LATERAL(SELECT review_status FROM intelligence_reviews WHERE event_id=e.id AND recorded_at<=${anchor}::timestamptz ORDER BY id DESC LIMIT 1) review ON true
        WHERE ${conditions.join(' AND ')}
      ), page AS (SELECT * FROM eligible ${after} ORDER BY score DESC,published_at DESC,id LIMIT ${count})
      SELECT (SELECT count(*) FROM eligible)::text total,
        coalesce((SELECT jsonb_agg(to_jsonb(page) ORDER BY score DESC,published_at DESC,id) FROM page),'[]'::jsonb) items`,
        values,
      );
      const row = response.rows[0]!;
      total = Number(row.total);
      const page = row.items.slice(0, limit);
      items = page.map((record) => {
        const event = record.event;
        // Metadata explicitly distinguishes indexing from publication and validity.
        const timeBasis =
          record.time_basis === 'provider-index-observation-only'
            ? 'index-observation'
            : record.time_basis === 'unknown'
              ? 'unknown'
              : record.time_basis === 'effective'
                ? 'effective'
                : 'publication';
        const geometryValue = GeometrySchema.safeParse(record.geometry);
        return {
          id: record.id,
          sourceId: record.source_id,
          sourceName: record.source_name,
          externalId: event.externalId,
          version: event.version,
          title: event.title,
          summary: clean(event.summary),
          snippet: clean(record.snippet),
          category: event.category,
          status: event.status,
          reviewStatus: record.review_status,
          visibility: record.visibility === 'public' ? 'public' : 'internal',
          publishedAt:
            timeBasis === 'publication' && event.publishedAt ? iso(event.publishedAt) : null,
          observedAt: iso(record.published_at),
          collectedAt: iso(record.created_at),
          effectiveFrom:
            !record.effective_time_pending && event.effectiveFrom ? iso(event.effectiveFrom) : null,
          effectiveTo:
            !record.effective_time_pending && event.effectiveTo ? iso(event.effectiveTo) : null,
          timeBasis,
          originalUrl: event.originalUrl ?? null,
          originalArchiveId: event.originalArchiveId ?? null,
          geometry: geometryValue.success ? geometryValue.data : null,
          matchBasis: record.match_basis,
          locationNote:
            record.match_basis === 'mention'
              ? '仅文字提及，尚未核实发生位置或实际影响'
              : geometryValue.success
                ? '来源位置或已登记适用几何，不能据此推断船舶实际影响'
                : '没有可定位的几何信息',
        } satisfies IntelligenceSearchItem;
      });
      if (row.items.length > limit) {
        const last = page.at(-1)!;
        nextCursor = Buffer.from(
          JSON.stringify({
            v: 1,
            asOf: now.toISOString(),
            fingerprint,
            score: last.score,
            published: iso(last.published_at),
            id: last.id,
          } satisfies SearchCursor),
        ).toString('base64url');
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  const forecasts = spec.kind === 'events' ? [] : await readMarineForecasts(infra, spec, now);
  const notes: string[] = [];
  if (spec.timeMode === 'effective')
    notes.push('按有效时间检索；未核实有效期的资料不会被判定为当前限制。');
  if (spec.kind !== 'events' && !forecasts.length)
    notes.push('已入库海况在所选点位或预报时段内没有覆盖，未使用其他远处点位替代。');
  if (items.some((item) => item.reviewStatus === 'candidate'))
    notes.push('部分情报尚待人工审核，不能作为已确认限制或船舶影响。');
  if (health.some((source) => source.status !== 'ready'))
    notes.push('部分来源未采集、过期、已停用或采集异常，未检索到不代表现实中不存在。');
  return IntelligenceSearchResultSchema.parse({
    items,
    forecasts,
    total,
    nextCursor,
    asOf: now.toISOString(),
    spec,
    sourceHealth: health,
    coverageNotes: notes,
  });
}

export async function searchAgentIntelligence(
  infra: Infrastructure,
  selection: AgentSelection,
): Promise<AgentIntelligenceResult> {
  const spec: IntelligenceSearchSpec = {
    ...(selection.intelligenceQuery ?? {}),
    ...(selection.bbox && !selection.intelligenceQuery?.bbox ? { bbox: selection.bbox } : {}),
    ...(selection.mmsis?.length ? { mmsis: selection.mmsis } : {}),
    ...(selection.intelligenceTimeRange
      ? selection.intelligenceQuery?.kind === 'marine'
        ? {
            forecastFrom: selection.intelligenceTimeRange.from,
            forecastTo: selection.intelligenceTimeRange.to,
          }
        : { from: selection.intelligenceTimeRange.from, to: selection.intelligenceTimeRange.to }
      : {}),
  };
  const result = await searchIntelligence(infra, spec, { limit: 20 });
  let ordinal = 0;
  const evidence = [
    ...result.items.map((event) => ({ kind: 'event' as const, reference: `I${++ordinal}`, event })),
    ...result.forecasts.map((forecast) => ({
      kind: 'marine' as const,
      reference: `I${++ordinal}`,
      forecast,
    })),
  ].slice(0, 50);
  return AgentIntelligenceResultSchema.parse({
    kind: 'intelligence_search',
    version: 0,
    inputRevision: 0,
    asOf: result.asOf,
    spec: result.spec,
    total: result.total + result.forecasts.length,
    truncated: !!result.nextCursor || ordinal > 50,
    evidence,
    sourceHealth: result.sourceHealth,
    coverageNotes: result.coverageNotes,
  });
}
