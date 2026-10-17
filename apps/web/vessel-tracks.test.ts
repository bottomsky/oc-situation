import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type {
  AgentVesselTracksResult,
  VesselTracksQuery,
  VesselTracksResult,
} from '@ais/contracts';
import { useVesselTracks } from './app/composables/useVesselTracks';

afterEach(() => vi.unstubAllGlobals());
const query: VesselTracksQuery = {
  bbox: [110, 10, 130, 40],
  from: '2026-10-16T00:00:00Z',
  to: '2026-10-17T00:00:00Z',
  selector: { shipTypes: [70] },
  maxVessels: 20,
  maxPointsPerVessel: 500,
};
const result: VesselTracksResult = {
  query,
  asOf: query.to,
  generatedAt: query.to,
  shipTypeBasis: 'current_profile',
  selectionBasis: 'historical_observation_in_bbox',
  trackScope: 'full_time_window',
  returnedVessels: 1,
  matchedVesselsLowerBound: 1,
  hasMoreVessels: false,
  tracks: [
    {
      mmsi: '123456789',
      name: '测试船',
      shipType: 70,
      total: 2,
      returned: 2,
      sampled: false,
      truncated: false,
      segments: [
        {
          points: [
            { lon: 122, lat: 30, observedAt: query.from },
            { lon: 123, lat: 31, observedAt: '2026-10-16T01:00:00Z' },
          ],
        },
      ],
    },
  ],
};
function setup(api: (path: string, options?: Record<string, unknown>) => Promise<unknown>) {
  const scope = effectScope();
  const identity = ref({ user: { id: 'a' } });
  vi.stubGlobal('usePlatform', () => ({ api, session: identity }));
  return { state: scope.run(() => useVesselTracks())!, identity, stop: () => scope.stop() };
}
it('固定JSON查询，关闭中止请求，迟到结果不能恢复航线', async () => {
  let release!: (value: unknown) => void;
  let sent: Record<string, unknown> | undefined;
  const h = setup(async (_path, options) => {
    sent = options;
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const input = structuredClone(query);
  const pending = h.state.generate(input, new Date(query.to));
  input.bbox[0] = 1;
  expect(sent?.method).toBe('POST');
  expect((sent?.body as VesselTracksQuery).bbox[0]).toBe(110);
  h.state.close();
  expect((sent?.signal as AbortSignal).aborted).toBe(true);
  release(result);
  await pending;
  expect(h.state.result.value).toBeNull();
  expect(h.state.loading.value).toBe(false);
  h.stop();
});
it('人工更新和账号切换使旧Agent票据失效，同版本只接受一次', async () => {
  const h = setup(async () => result);
  const agent: AgentVesselTracksResult = {
    ...result,
    kind: 'vessel_tracks',
    version: 1,
    inputRevision: 1,
  };
  const old = h.state.beginAgent();
  await h.state.generate(query, new Date(query.to));
  expect(h.state.result.value?.returnedVessels).toBe(1);
  expect(h.state.acceptAgent(agent, 's:t', old)).toBe(false);
  const token = h.state.beginAgent();
  expect(h.state.acceptAgent(agent, 's:t', token)).toBe(true);
  expect(h.state.acceptAgent(agent, 's:t', token)).toBe(false);
  h.identity.value = { user: { id: 'b' } };
  expect(h.state.result.value).toBeNull();
  expect(h.state.lastSnapshot.value).toBeNull();
  expect(h.state.acceptAgent(agent, 's:t', token)).toBe(false);
  h.stop();
});
it('空结果作为真实完成展示，超期和无选择条件不会发请求', async () => {
  const api = vi.fn(async () => ({
    ...result,
    tracks: [],
    returnedVessels: 0,
    matchedVesselsLowerBound: 0,
  }));
  const h = setup(api);
  await h.state.generate({ ...query, selector: {} }, new Date(query.to));
  await h.state.generate({ ...query, from: '2026-08-01T00:00:00Z' }, new Date(query.to));
  expect(api).not.toHaveBeenCalled();
  await h.state.generate(query, new Date(query.to));
  expect(h.state.result.value?.returnedVessels).toBe(0);
  expect(h.state.displayed.value).toBe(false);
  h.stop();
});
