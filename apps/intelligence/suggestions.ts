import type { Infrastructure } from '@ais/infrastructure';
import type { IntelligenceInput } from '../../packages/contracts/intelligence';
import type { IntelligenceRelationInput } from '../../packages/contracts/intelligence-spatial';

/** Alias mention and spatial intersection are review suggestions, never inferred vessel impacts. */
export async function suggestObjectRelations(
  infra: Infrastructure,
  event: IntelligenceInput,
): Promise<IntelligenceRelationInput[]> {
  const suggestions: IntelligenceRelationInput[] = [];
  const text = event.paragraphs.map((p) => p.text).join('\n');
  const rows = await infra.pool.query<{ id: string; name: string; aliases: string[] }>(
    "SELECT id,name,ARRAY(SELECT jsonb_array_elements_text(data->'aliases')) AS aliases FROM intelligence_objects WHERE strpos(lower($1),lower(name)) > 0 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(data->'aliases') a WHERE length(a)>=2 AND strpos(lower($1),lower(a)) > 0) ORDER BY id LIMIT 100",
    [text],
  );
  for (const object of rows.rows)
    suggestions.push({
      kind: 'mentions',
      objectId: object.id,
      basis: `正文命中对象名称或已登记别名：${object.name}；提及关系等待人工核实`,
      paragraphIds: event.paragraphs
        .filter((p) =>
          [object.name, ...object.aliases].some((a) =>
            p.text.toLowerCase().includes(a.toLowerCase()),
          ),
        )
        .map((p) => p.id),
      reviewStatus: 'candidate',
      origin: 'rule',
    });
  for (const relation of (event.relations ?? []).filter((r) => r.geometry)) {
    const hits = await infra.pool.query<{ id: string; name: string }>(
      'SELECT id,name FROM intelligence_objects WHERE geom IS NOT NULL AND ST_Intersects(geom,ST_SetSRID(ST_GeomFromGeoJSON($1),4326)) ORDER BY id LIMIT 100',
      [JSON.stringify(relation.geometry)],
    );
    for (const object of hits.rows)
      if (!suggestions.some((r) => r.objectId === object.id))
        suggestions.push({
          kind: relation.kind === 'occurs-at' ? 'occurs-at' : 'applies-to',
          objectId: object.id,
          basis: `原文位置与已登记对象几何相交：${object.name}；范围、时间和关系含义待人工确认`,
          paragraphIds: relation.paragraphIds,
          reviewStatus: 'candidate',
          origin: 'rule',
        });
  }
  return suggestions;
}
