import { expect, it } from 'vitest';
import { queryAgentVessels } from './agent-query';
import type { Infrastructure } from './clients';

const geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [121, 30],
      [122, 30],
      [121, 31],
      [121, 30],
    ],
  ],
};
it('resolves a vessel circle anchor and exact result count in one SQL snapshot before pagination', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const observedAt = '2026-10-18T00:00:00.000Z';
  const infra = {
    pool: {
      query: async (sql: string, values: unknown[]) => {
        calls.push({ sql, values });
        return sql.includes('ST_Project')
          ? { rows: [{ geometry }] }
          : {
              rows: [
                {
                  total: '105',
                  items: [],
                  as_of: new Date('2026-10-18T01:00:00Z'),
                  anchor_position: {
                    longitude: 121,
                    latitude: 30,
                    observedAt,
                    sourceId: 'anchor-source',
                  },
                },
              ],
            };
      },
    },
  } as unknown as Infrastructure;
  const result = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: {
      vesselCircle: { mmsi: '257288000', radiusMeters: 100000 },
      mmsis: ['257288000'],
      vesselSelector: { mmsis: ['257288000'] },
      bbox: [-10, -10, 10, 10],
      filters: { hours: 24, shipType: 70 },
    },
  } as never);
  expect(result.total).toBe(105);
  expect(result.selection.region).toEqual({
    kind: 'circle',
    center: [121, 30],
    radiusMeters: 100000,
  });
  expect(result.selection.bbox).toBeUndefined();
  expect(result).toHaveProperty('regionAnchor', {
    mmsi: '257288000',
    observedAt,
    sourceId: 'anchor-source',
  });
  const query = calls.find((call) => !call.sql.includes('ST_Project'))!;
  expect(query.sql).toContain('anchor AS MATERIALIZED');
  expect(query.sql).toContain('p.observed_at<=now()');
  expect(query.sql.indexOf('ST_DWithin')).toBeLessThan(query.sql.indexOf('LIMIT 100'));
  expect(query.values.slice(0, 4)).toEqual([24, null, 70, null]);
  expect(query.values).toContain('257288000');
  expect(calls.filter((call) => !call.sql.includes('ST_Project'))).toHaveLength(1);
});

it('fails explicitly when the anchor has no valid position and never applies the captured viewport', async () => {
  const queries: string[] = [];
  const infra = {
    pool: {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [{ total: '0', items: [], as_of: new Date(), anchor_position: null }] };
      },
    },
  } as unknown as Infrastructure;
  await expect(
    queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        vesselCircle: { mmsi: '257288000', radiusMeters: 100000 },
        bbox: [-10, -10, 10, 10],
      },
    } as never),
  ).rejects.toMatchObject({ code: 'anchor_position_unavailable' });
  expect(queries).toHaveLength(1);
  expect(queries[0]).not.toContain('p.latitude BETWEEN');
});
