import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from './clients';
import { buildVesselTrack, queryVesselTracks } from './vessel-tracks';
import { VesselTracksQuerySchema } from '../contracts/vessel-tracks';

const now = new Date('2026-10-17T01:00:00.000Z');
const input = () =>
  VesselTracksQuerySchema.parse({
    bbox: [170, -10, -170, 10],
    from: '2026-10-17T00:00:00.000Z',
    to: now.toISOString(),
    selector: { shipTypes: [70] },
  });
const point = (minute: number, lon = 179) => ({
  lon,
  lat: 0,
  observedAt: new Date(Date.parse(input().from) + minute * 60000).toISOString(),
});
const profile = { mmsi: '123456789', name: 'Test', shipType: 70 };
function fixture() {
  const client = {
    query: vi.fn(async (sql: string) => ({ rows: sql.startsWith('WITH') ? [profile] : [] })),
    release: vi.fn(),
  };
  const query = vi
    .fn()
    .mockResolvedValueOnce({ json: async () => [{ mmsi: profile.mmsi }] })
    .mockResolvedValueOnce({
      json: async () => [
        { mmsi: profile.mmsi, lon: 179, lat: 0, observedMs: Date.parse(input().from) },
      ],
    });
  return {
    client,
    query,
    infra: {
      pool: { connect: async () => client },
      clickhouse: { query },
    } as unknown as Infrastructure,
  };
}
describe('historical track segmentation and sampling', () => {
  it('does not create a false date-line connection when sampling a long continuous segment', () => {
    const track = buildVesselTrack(profile, [point(0, 170), point(1, 0), point(2, -170)], 2);
    expect(track.segments.map((segment) => segment.points.length)).toEqual([1, 1]);
    expect(track).toMatchObject({ returned: 2, total: 3, sampled: true, truncated: false });
  });
  it('breaks date-line crossings and long gaps without joining unrelated paths', () => {
    const track = buildVesselTrack(profile, [point(0), point(1, -179), point(40, -178)], 10);
    expect(track.segments.map((segment) => segment.points.length)).toEqual([1, 1, 1]);
    expect(track).toMatchObject({ total: 3, returned: 3, sampled: false, truncated: false });
  });
  it('keeps segment endpoints while sampling and explicitly reports segment truncation', () => {
    const points = Array.from({ length: 20 }, (_, i) => point(i, 170 + i / 10));
    const sampled = buildVesselTrack(profile, points, 4);
    expect(sampled.segments[0]?.points[0]).toEqual(points[0]);
    expect(sampled.segments[0]?.points.at(-1)).toEqual(points.at(-1));
    expect(sampled).toMatchObject({ returned: 4, sampled: true, truncated: false });
    const truncated = buildVesselTrack(profile, [point(0), point(31), point(62)], 2);
    expect(truncated).toMatchObject({ returned: 2, sampled: true, truncated: true });
    expect(buildVesselTrack(profile, [], 2)).toMatchObject({ total: 0, returned: 0, segments: [] });
  });
});
describe('bounded shared vessel track query', () => {
  it('returns a fixed-clock result and applies database budgets to both queries', async () => {
    const f = fixture();
    const result = await queryVesselTracks(f.infra, input(), { ownerId: 'actor', now });
    expect(result).toMatchObject({
      asOf: now.toISOString(),
      returnedVessels: 1,
      matchedVesselsLowerBound: 1,
      hasMoreVessels: false,
    });
    expect(result.tracks[0]).toMatchObject({ total: 1, returned: 1, shipType: 70 });
    expect(f.query).toHaveBeenCalledTimes(2);
    for (const [args] of f.query.mock.calls)
      expect(args.clickhouse_settings).toMatchObject({
        max_execution_time: 20,
        read_overflow_mode: 'throw',
        result_overflow_mode: 'throw',
        cancel_http_readonly_queries_on_client_close: 1,
      });
    expect(f.client.release).toHaveBeenCalledOnce();
  });
  it('returns a genuine empty result without querying historical positions for no selector matches', async () => {
    const f = fixture();
    f.client.query.mockResolvedValue({ rows: [] });
    expect(await queryVesselTracks(f.infra, input(), { now })).toMatchObject({
      tracks: [],
      returnedVessels: 0,
    });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('reports candidate overflow without presenting its lower bound as an exact count', async () => {
    const f = fixture();
    f.query
      .mockReset()
      .mockResolvedValueOnce({ json: async () => [{ mmsi: profile.mmsi }, { mmsi: '223456789' }] })
      .mockResolvedValueOnce({ json: async () => [] });
    const result = await queryVesselTracks(f.infra, { ...input(), maxVessels: 1 }, { now });
    expect(result).toMatchObject({
      hasMoreVessels: true,
      matchedVesselsLowerBound: 2,
      returnedVessels: 1,
    });
  });
  it('rejects future and expired windows and already cancelled requests before I/O', async () => {
    const f = fixture();
    await expect(
      queryVesselTracks(f.infra, input(), { now: new Date(input().from) }),
    ).rejects.toMatchObject({ category: 'invalid_input' });
    await expect(
      queryVesselTracks(f.infra, input(), { now: new Date('2026-12-01') }),
    ).rejects.toMatchObject({ category: 'retention' });
    await expect(
      queryVesselTracks(f.infra, input(), { now, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ category: 'cancelled' });
    expect(f.client.query).not.toHaveBeenCalled();
  });
  it('maps resource exhaustion without returning a partial success', async () => {
    const f = fixture();
    f.query.mockReset().mockRejectedValueOnce({ code: '241', message: 'private database detail' });
    await expect(queryVesselTracks(f.infra, input(), { now })).rejects.toMatchObject({
      category: 'data_limit',
    });
  });
  it('holds the concurrency slot until cancelled transport settles', async () => {
    const f = fixture();
    let release!: () => void;
    f.query.mockReset().mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { json: async () => [] };
    });
    const controller = new AbortController();
    const pending = queryVesselTracks(f.infra, input(), { now, signal: controller.signal });
    const failure = pending.catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.query).toHaveBeenCalledOnce());
    controller.abort();
    expect(await failure).toMatchObject({ category: 'cancelled' });
    await expect(queryVesselTracks(f.infra, input(), { now })).rejects.toMatchObject({
      category: 'busy',
    });
    release();
    await vi.waitFor(() => expect(f.client.release).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
