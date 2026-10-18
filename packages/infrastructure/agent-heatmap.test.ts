import { describe, expect, it, vi } from 'vitest';
import * as agent from './agent';
import type { Infrastructure } from './clients';
import type { AgentHeatmapResult } from '../contracts/heatmap';

// These focused SQL fixtures exercise heatmap admission/persistence, with memory as an independent port.
vi.mock('./agent-memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-memory')>()),
  getAgentMemorySettings: async () => ({
    readEnabled: true,
    proposalsEnabled: true,
    generation: 0,
    revision: 0,
  }),
  getAgentAccountMemory: async () => ({ revision: 0, entries: [] }),
  getAgentSessionMemory: async () => null,
  getAgentTaskMemoryContext: async () => null,
}));

const result: AgentHeatmapResult = {
  kind: 'ais_heatmap',
  version: 0,
  inputRevision: 0,
  query: {
    bbox: [120, 30, 122, 32],
    from: '2026-10-13T00:00:00.000Z',
    to: '2026-10-14T00:00:00.000Z',
  },
  grid: { level: 0, cellDegrees: 360 },
  cells: [],
  totalVessels: 0,
  generatedAt: '2026-10-14T00:00:00.000Z',
  metric: 'unique_vessels',
  shipTypeBasis: 'current_profile',
};
function database(overrides: Record<string, unknown> = {}) {
  const row = {
    id: 'task',
    session_id: 'session',
    owner_id: 'owner',
    worker_id: 'worker',
    generation: 2,
    status: 'running',
    lease_valid: true,
    result_version: 0,
    input_revision: 3,
    result_input_revision: null,
    ...overrides,
  };
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: sql.startsWith('SELECT') ? [row] : [],
  }));
  const client = { query, release: vi.fn() };
  return { infra: { pool: { connect: async () => client } } as unknown as Infrastructure, query };
}
describe('热力图结果持久化防护', () => {
  it('超过100个明确MMSI时拒绝整条请求并保持无任务写入', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('INSERT INTO agent_tasks')) throw new Error('超限请求仍试图创建任务');
      if (sql.includes('FROM agent_sessions') || sql.includes('FROM users'))
        return { rowCount: 1, rows: [{ id: 'authorized' }] };
      return { rowCount: 0, rows: [] };
    });
    const infra = {
      pool: { connect: async () => ({ query, release: vi.fn() }) },
    } as unknown as Infrastructure;
    const content = `生成当前视野热力图：${Array.from({ length: 101 }, (_, index) => String(413000000 + index)).join(' ')}`;
    await expect(
      agent.submitAgentMessage(infra, 'owner', 'session', 'key', {
        content,
        historyHours: 24,
        bbox: [120, 30, 122, 32],
      }),
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: '热力图一次最多筛选 100 艘船舶，请缩小船舶范围后重试。',
    });
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO agent_tasks'))).toBe(false);
  });
  it('提供带版本和当前输入修订绑定的保存入口', async () => {
    expect(agent).toHaveProperty('saveAgentHeatmapResult');
    const { infra, query } = database();
    expect(
      await agent.saveAgentHeatmapResult(infra, 'task', 'worker', 2, {
        ...result,
        inputRevision: 3,
      }),
    ).toBe(1);
    const insert = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO agent_results'));
    expect(insert?.[0]).toContain('heatmap_result');
  });
  it('拒绝属于旧输入修订的热力图结果', async () => {
    const { infra, query } = database();
    expect(await agent.saveAgentHeatmapResult(infra, 'task', 'worker', 2, result)).toBeNull();
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO agent_results'))).toBe(
      false,
    );
  });
  it('取消和过期 generation 阻止写入', async () => {
    expect(agent).toHaveProperty('saveAgentHeatmapResult');
    for (const overrides of [{ status: 'cancelled' }, { generation: 3 }, { lease_valid: false }]) {
      const { infra, query } = database(overrides);
      expect(await agent.saveAgentHeatmapResult(infra, 'task', 'worker', 2, result)).toBeNull();
      expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO agent_results'))).toBe(
        false,
      );
    }
  });
});
