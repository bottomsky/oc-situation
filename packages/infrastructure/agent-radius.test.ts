import { expect, it } from 'vitest';
import { queryAgentVessels } from './agent-query';
import type { Infrastructure } from './clients';
it('applies geography radius in the eligible relation before pagination', async () => {
  let sql = '';
  let params: unknown[] = [];
  const infra = {
    pool: {
      query: async (s: string, p: unknown[]) => {
        if (s.includes('ST_Project'))
          return {
            rows: [
              {
                geometry: {
                  type: 'Polygon',
                  coordinates: [
                    [
                      [179, 30],
                      [179.01, 30],
                      [179, 30.01],
                      [179, 30],
                    ],
                  ],
                },
              },
            ],
          };
        sql = s;
        params = p;
        return { rows: [{ total: '101', items: [], as_of: new Date() }] };
      },
    },
  } as unknown as Infrastructure;
  const result = await queryAgentVessels(infra, {
    kind: 'vessel_list',
    inputRevision: 0,
    selection: { region: { kind: 'circle', center: [179, 30], radiusMeters: 1000 } },
  });
  expect(result.total).toBe(101);
  expect(sql.indexOf('ST_DWithin')).toBeLessThan(sql.indexOf('LIMIT 100'));
  expect(params.slice(-3)).toEqual([179, 30, 1000]);
});
