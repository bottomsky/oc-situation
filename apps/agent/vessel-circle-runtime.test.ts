import { expect, it } from 'vitest';
import { executeAgent, type RuntimeContext, type RuntimePorts } from './runtime';
import type { AgentQueryResult } from '../../packages/contracts/agent';

const selection = {
  purpose: 'vessel_list' as const,
  vesselCircle: { mmsi: '257288000', radiusMeters: 100000 },
  filters: { hours: 24 },
};
const context = (): RuntimeContext => ({
  task: {
    id: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    goal: '船舶257288000 中心及半径100公里的圆形区域多少船舶',
    intent: 'vessel_list',
    inputRevision: 0,
    resultInputRevision: 0,
    generation: 1,
    selection,
  } as never,
  steps: [],
  results: [],
});
function ports(query: () => Promise<AgentQueryResult>) {
  const state = { status: '', summary: '', error: '', errorCode: '', saved: 0 };
  const value = {
    active: async () => true,
    reserve: async () => true,
    saveStep: async () => true,
    queryVessels: query,
    saveQueryResult: async () => {
      state.saved++;
      return 1;
    },
    finish: async (outcome: {
      status: string;
      summary?: string;
      error?: string;
      errorCode?: string;
    }) => {
      Object.assign(state, outcome);
      return true;
    },
  } as unknown as RuntimePorts;
  return { value, state };
}
it('explains the circle anchor observation time and center ship count semantics', async () => {
  const p = ports(async () => ({
    kind: 'vessel_list',
    version: 0,
    inputRevision: 0,
    total: 0,
    truncated: false,
    items: [],
    asOf: '2026-10-18T01:00:00.000Z',
    selection: {
      ...selection,
      region: { kind: 'circle', center: [121, 30], radiusMeters: 100000 },
    },
    regionAnchor: {
      mmsi: '257288000',
      observedAt: '2026-10-18T00:00:00.000Z',
      sourceId: 'fixture',
    },
  }));
  await executeAgent(context(), p.value, { apiKey: 'unused' });
  expect(p.state.status).toBe('completed');
  expect(p.state.summary).toContain('257288000');
  expect(p.state.summary).toContain('定位时间');
  expect(p.state.summary).toContain('北京时间');
  expect(p.state.summary).toContain('中心船计入区域数量');
  expect(p.state.summary).toContain('所选区域');
});
it('reports a missing effective anchor position explicitly and never saves a substitute query result', async () => {
  const p = ports(async () => {
    throw Object.assign(new Error('anchor_position_unavailable'), {
      code: 'anchor_position_unavailable',
    });
  });
  await executeAgent(context(), p.value, { apiKey: 'unused' });
  expect(p.state.status).toBe('failed');
  expect(p.state.errorCode).toBe('anchor_position_unavailable');
  expect(p.state.error).toContain('257288000');
  expect(p.state.error).toContain('24 小时内没有有效船位');
  expect(p.state.saved).toBe(0);
});
