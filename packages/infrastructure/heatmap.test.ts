import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import { chooseHeatmapGrid, heatmapCellCoordinates, queryAisHeatmap } from './heatmap';

const query = () => ({
  bbox: [-180, -90, 180, 90] as [number, number, number, number],
  from: new Date(Date.now() - 3_600_000).toISOString(),
  to: new Date(Date.now() - 1000).toISOString(),
});
function fixture() {
  const json = vi.fn(async () => [{ isTotal: 3, x: 0, y: 0, vesselCount: '0' }]);
  const clickhouseQuery = vi.fn(async () => ({ json }));
  const poolQuery = vi.fn(async () => ({ rows: [] }));
  return {
    infra: {
      clickhouse: { query: clickhouseQuery },
      pool: { query: poolQuery },
    } as unknown as Infrastructure,
    json,
    clickhouseQuery,
    poolQuery,
  };
}

describe('deterministic global heatmap grid', () => {
  it('chooses the finest level covering no more than 4096 world cells', () => {
    expect(chooseHeatmapGrid([-180, -90, 180, 90])).toEqual({ level: 6, cellDegrees: 5.625 });
    expect(chooseHeatmapGrid([10, 10, 10.00001, 10.00001]).level).toBe(20);
  });
  it('normalizes the date line and clamps both poles with a valid level-zero centre', () => {
    expect(heatmapCellCoordinates(180, 90, 6)).toEqual(heatmapCellCoordinates(-180, 90, 6));
    expect(heatmapCellCoordinates(-180, -90, 6)).toMatchObject({ x: 0, y: 0 });
    expect(heatmapCellCoordinates(180, 90, 6)).toMatchObject({ x: 0, y: 31, lat: 87.1875 });
    expect(heatmapCellCoordinates(90, 90, 0)).toEqual({ id: '0:0:0', x: 0, y: 0, lon: 0, lat: 0 });
  });
  it('allocates a narrow crossing bbox using its two date-line intervals', () => {
    expect(chooseHeatmapGrid([179, -1, -179, 1]).level).toBeGreaterThan(6);
    expect(chooseHeatmapGrid([180, -90, 180, 90]).level).toBe(13);
  });
});

describe('bounded read-only AIS heatmap', () => {
  it('returns an exact total separately from overlapping cell counts', async () => {
    const f = fixture();
    f.json.mockResolvedValue([
      { isTotal: 3, x: 0, y: 0, vesselCount: '2' },
      { isTotal: 0, x: 0, y: 0, vesselCount: '2' },
      { isTotal: 0, x: 1, y: 0, vesselCount: '1' },
    ]);
    const result = await queryAisHeatmap(f.infra, query());
    expect(result.totalVessels).toBe(2);
    expect(result.cells.map((cell) => cell.vesselCount)).toEqual([2, 1]);
    expect(result.metric).toBe('unique_vessels');
    expect(result.shipTypeBasis).toBe('current_profile');
    expect(f.poolQuery).not.toHaveBeenCalled();
    const args = f.clickhouseQuery.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(args[0].clickhouse_settings).toMatchObject({
      max_execution_time: 20,
      max_memory_usage: '536870912',
      max_rows_to_read: '50000000',
      max_bytes_to_read: '4294967296',
      read_overflow_mode: 'throw',
    });
  });
  it('coalesces normalized owner queries and cancelling one subscriber preserves the other', async () => {
    const f = fixture();
    let release!: () => void;
    f.clickhouseQuery.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { json: f.json };
    });
    const firstAbort = new AbortController();
    const input = { ...query(), mmsis: ['123456789', '987654321'] };
    const first = queryAisHeatmap(f.infra, input, { ownerId: 'one', signal: firstAbort.signal });
    const firstError = first.catch((error: unknown) => error);
    const second = queryAisHeatmap(
      f.infra,
      { ...input, mmsis: [...input.mmsis].reverse() },
      { ownerId: 'one' },
    );
    firstAbort.abort();
    expect(await firstError).toMatchObject({ category: 'cancelled' });
    release();
    const result = await second;
    expect(result.totalVessels).toBe(0);
    expect(f.clickhouseQuery).toHaveBeenCalledTimes(1);
    expect(await queryAisHeatmap(f.infra, input, { ownerId: 'one' })).toEqual(result);
    expect(f.clickhouseQuery).toHaveBeenCalledTimes(1);
    await queryAisHeatmap(f.infra, input, { ownerId: 'two' });
  });
  it('rejects a different concurrent request with a safe busy category', async () => {
    const f = fixture();
    let release!: () => void;
    f.clickhouseQuery.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { json: f.json };
    });
    const first = queryAisHeatmap(f.infra, query(), { ownerId: 'one' });
    await expect(queryAisHeatmap(f.infra, query(), { ownerId: 'two' })).rejects.toMatchObject({
      category: 'busy',
    });
    release();
    await first;
  });
  it('aborts the shared query when its final subscriber cancels and permits a subsequent request', async () => {
    const f = fixture();
    f.clickhouseQuery.mockImplementationOnce(async (...args: unknown[]) => {
      const { abort_signal } = args[0] as { abort_signal: AbortSignal };
      await new Promise<void>((_resolve, reject) =>
        abort_signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }),
      );
      return { json: f.json };
    });
    const abort = new AbortController();
    const pending = queryAisHeatmap(f.infra, query(), { ownerId: 'one', signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ category: 'cancelled' });
    abort.abort();
    await rejected;
    await vi.waitFor(async () =>
      expect((await queryAisHeatmap(f.infra, query(), { ownerId: 'two' })).totalVessels).toBe(0),
    );
  });
  it('classifies server resource limits without leaking SQL or server details', async () => {
    const f = fixture();
    f.clickhouseQuery.mockRejectedValueOnce(
      Object.assign(new Error('private SQL details'), { code: '241' }),
    );
    await expect(queryAisHeatmap(f.infra, query())).rejects.toMatchObject({
      category: 'data_limit',
      message: '热力查询数据量超过限制，请缩小时间、区域或船舶范围。',
    });
  });
  it('keeps the slot busy until a transport that ignores abort actually settles', async () => {
    const f = fixture();
    let finish!: () => void;
    f.clickhouseQuery.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return { json: f.json };
    });
    const abort = new AbortController();
    const pending = queryAisHeatmap(f.infra, query(), { signal: abort.signal });
    const rejected = expect(pending).rejects.toMatchObject({ category: 'cancelled' });
    abort.abort();
    await rejected;
    await expect(queryAisHeatmap(f.infra, query())).rejects.toMatchObject({ category: 'busy' });
    expect(f.clickhouseQuery).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(
      async () => expect((await queryAisHeatmap(f.infra, query())).totalVessels).toBe(0),
      { timeout: 100 },
    );
  });
  it('holds the slot while a cancelled profile lookup finishes its read-only transaction', async () => {
    const f = fixture();
    let finish!: () => void;
    const statements: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        statements.push(text);
        if (text.startsWith('SELECT mmsi')) {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { rows: [{ mmsi: '123456789' }] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    f.infra.pool.connect = vi.fn(
      async () => client,
    ) as unknown as Infrastructure['pool']['connect'];
    const abort = new AbortController();
    const pending = queryAisHeatmap(
      f.infra,
      { ...query(), shipType: 70 },
      { signal: abort.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({ category: 'cancelled' });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    abort.abort();
    await rejected;
    await expect(queryAisHeatmap(f.infra, query())).rejects.toMatchObject({ category: 'busy' });
    expect(f.clickhouseQuery).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(client.release).toHaveBeenCalledTimes(1));
    expect(statements).toContain('BEGIN READ ONLY');
    expect(statements).toContain("SET LOCAL statement_timeout='5000ms'");
    expect(statements).toContain('COMMIT');
    await expect(queryAisHeatmap(f.infra, query())).resolves.toMatchObject({ totalVessels: 0 });
  });
  it('keeps cached results immutable to callers and expires entries after 30 seconds', async () => {
    const f = fixture();
    const q = query();
    const first = await queryAisHeatmap(f.infra, q, { ownerId: 'cache-test' });
    first.totalVessels = 900;
    expect((await queryAisHeatmap(f.infra, q, { ownerId: 'cache-test' })).totalVessels).toBe(0);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 31000);
      await queryAisHeatmap(f.infra, q, { ownerId: 'cache-test' });
      expect(f.clickhouseQuery).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it('validates retention and cancellation before touching storage', async () => {
    const f = fixture();
    const old = {
      ...query(),
      from: new Date(Date.now() - 31 * 86400000).toISOString(),
      to: new Date(Date.now() - 30.5 * 86400000).toISOString(),
    };
    await expect(queryAisHeatmap(f.infra, old)).rejects.toMatchObject({ category: 'retention' });
    await expect(
      queryAisHeatmap(f.infra, query(), { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(f.clickhouseQuery).not.toHaveBeenCalled();
  });
});
