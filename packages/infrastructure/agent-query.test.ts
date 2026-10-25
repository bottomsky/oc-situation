import { describe, expect, it } from 'vitest';
import { queryAgentVessels, resolveAgentAnalysisMmsis } from './agent-query';
import type { Infrastructure } from './clients';

describe('read-only agent vessel query', () => {
  it.each([0.25, 0.5])('AI船舶查询保留%s小时范围，避免分钟筛选引发校验失败', async (hours) => {
    let statement = '';
    let parameters: unknown[] = [];
    const infra = {
      pool: {
        query: async (sql: string, values: unknown[]) => {
          statement = sql;
          parameters = values;
          return { rows: [{ total: '0', items: [], as_of: new Date() }] };
        },
      },
    } as unknown as Infrastructure;
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: { bbox: [120, 30, 122, 32], filters: { hours } },
    });
    expect(result.selection.filters?.hours).toBe(hours);
    expect(parameters[0]).toBe(hours);
    expect(statement).toContain('make_interval(secs=>');
    expect(statement).not.toContain('make_interval(hours=>');
  });
  it('resolves model and name constraints through the existing local selector and preserves an empty set', async () => {
    let resolverValues: unknown[] = [];
    let queryValues: unknown[] = [];
    const infra = {
      pool: {
        connect: async () => ({
          query: async (sql: string, values?: unknown[]) => {
            if (sql.includes('WITH objects')) resolverValues = values!;
            return { rows: [] };
          },
          release() {},
        }),
        query: async (_sql: string, values: unknown[]) => {
          queryValues = values;
          return { rows: [{ total: '0', items: [], as_of: new Date() }] };
        },
      },
    } as unknown as Infrastructure;
    await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        bbox: [120, 30, 122, 32],
        vesselSelector: { model: '052D', query: '海巡01', mmsis: ['413123456'] },
      },
    });
    expect(resolverValues.slice(0, 4)).toEqual([['413123456'], null, '海巡01', '052D']);
    expect(queryValues[3]).toEqual([]);
  });
  it('filters a cargo family at the SQL boundary while retaining the exact count', async () => {
    let statement = '';
    let parameters: unknown[] = [];
    const infra = {
      pool: {
        query: async (sql: string, values: unknown[]) => {
          statement = sql;
          parameters = values;
          return { rows: [{ total: '0', items: [], as_of: new Date() }] };
        },
      },
    } as unknown as Infrastructure;
    await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 0,
      selection: {
        bbox: [120, 30, 122, 32],
        vesselSelector: { shipTypes: [70, 71, 72, 79] },
        filters: { shipType: 71 },
      },
    });
    expect(statement).toContain('v.ship_type=ANY($9::integer[])');
    expect(statement).toContain('($3::integer IS NULL OR v.ship_type=$3)');
    expect(parameters.at(-1)).toEqual([70, 71, 72, 79]);
  });
  it('resolves ship type with vessel intersection and preserves an empty result', async () => {
    const calls: unknown[][] = [];
    const infra = {
      pool: {
        query: async (_sql: string, values: unknown[]) => {
          calls.push(values);
          return { rows: [] };
        },
      },
    } as unknown as Infrastructure;
    expect(await resolveAgentAnalysisMmsis(infra, { mmsis: [] })).toBeUndefined();
    expect(
      await resolveAgentAnalysisMmsis(
        infra,
        { mmsis: ['413123456'], filters: { shipType: 70 } },
        2,
      ),
    ).toEqual([]);
    expect(calls).toEqual([[70, ['413123456'], 3]]);
  });
  it('fails closed when ship-type candidates exceed the analysis limit', async () => {
    const infra = {
      pool: { query: async () => ({ rows: [{ mmsi: '413123456' }, { mmsi: '413123457' }] }) },
    } as unknown as Infrastructure;
    await expect(
      resolveAgentAnalysisMmsis(infra, { filters: { shipType: 70 } }, 1),
    ).rejects.toThrow('explicit maximum');
  });
  it('queries vessels with exact count and date-line bounds in a single read', async () => {
    const calls: Array<{ sql: string; values: unknown[] }> = [];
    const infra = {
      pool: {
        query: async (sql: string, values: unknown[]) => {
          calls.push({ sql, values });
          return {
            rows: [
              {
                total: '101',
                items: [
                  {
                    mmsi: '413123456',
                    name: '本地船',
                    imo: null,
                    shipType: 70,
                    latestPosition: {
                      lat: 10,
                      lon: 175,
                      observedAt: '2026-10-13T01:00:00+00:00',
                      sogKnots: 2,
                      sourceId: 'test',
                    },
                  },
                ],
                as_of: new Date('2026-10-13T01:00:00Z'),
              },
            ],
          };
        },
      },
    } as unknown as Infrastructure;
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_list',
      inputRevision: 3,
      selection: {
        bbox: [170, -20, -170, 20],
        mmsis: ['413123456'],
        filters: { hours: 6, sourceId: 'test', shipType: 70 },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain('p.longitude >= $5 OR p.longitude <= $7');
    expect(calls[0]!.sql).toContain('SELECT count(*) FROM eligible');
    expect(calls[0]!.sql).not.toMatch(/INSERT|UPDATE|DELETE|cluster/i);
    expect(calls[0]!.values).toEqual([6, 'test', 70, ['413123456'], 170, -20, -170, 20]);
    expect(result.total).toBe(101);
    expect(result.truncated).toBe(true);
    expect(result.inputRevision).toBe(3);
    expect(result.items[0]!.latestPosition!.observedAt).toBe('2026-10-13T01:00:00.000Z');
  });
  it('detail preserves static data for vessels without a recent position', async () => {
    let statement = '';
    const infra = {
      pool: {
        query: async (sql: string) => {
          statement = sql;
          return {
            rows: [
              {
                total: '1',
                items: [
                  {
                    mmsi: '413123456',
                    name: null,
                    imo: null,
                    shipType: null,
                    latestPosition: null,
                  },
                ],
                as_of: new Date(),
              },
            ],
          };
        },
      },
    } as unknown as Infrastructure;
    const result = await queryAgentVessels(infra, {
      kind: 'vessel_detail',
      inputRevision: 0,
      selection: { mmsis: ['413123456'] },
    });
    expect(statement).not.toContain('p.mmsi IS NOT NULL');
    expect(result.items[0]!.latestPosition).toBeNull();
  });
  it('requires a region for lists and concrete vessels for detail', async () => {
    const infra = {} as Infrastructure;
    await expect(
      queryAgentVessels(infra, { kind: 'vessel_list', inputRevision: 0, selection: {} }),
    ).rejects.toThrow('region_required');
    await expect(
      queryAgentVessels(infra, {
        kind: 'vessel_detail',
        inputRevision: 0,
        selection: { mmsis: [] },
      }),
    ).rejects.toThrow('vessels_required');
  });
});
