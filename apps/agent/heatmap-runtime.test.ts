import { describe, expect, it, vi } from 'vitest';
import { executeAgent, type RuntimePorts, type RuntimeContext } from './runtime';
import type { AgentHeatmapResult } from '../../packages/contracts/heatmap';
import { getBusinessSkillCatalog } from './business-capabilities';

const selection = {
  purpose: 'ais_heatmap' as const,
  bbox: [120, 30, 122, 32] as [number, number, number, number],
  timeRange: { from: '2026-10-13T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' },
};
const result: AgentHeatmapResult = {
  kind: 'ais_heatmap',
  version: 0,
  inputRevision: 0,
  query: { bbox: selection.bbox, ...selection.timeRange },
  grid: { level: 0, cellDegrees: 360 },
  cells: [],
  totalVessels: 0,
  generatedAt: selection.timeRange.to,
  metric: 'unique_vessels',
  shipTypeBasis: 'current_profile',
};
function setup() {
  const context: RuntimeContext = {
    task: {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      goal: '生成当前视野AIS热力图',
      intent: 'ais_heatmap',
      selection,
      bbox: selection.bbox,
      from: selection.timeRange.from,
      to: selection.timeRange.to,
      historyHours: 24,
      generation: 1,
      resultVersion: 0,
      modelCalls: 0,
      toolCalls: 0,
      definitionId: null,
      summaryResultVersion: null,
      summary: null,
      error: null,
      status: 'running',
      createdAt: selection.timeRange.to,
      updatedAt: selection.timeRange.to,
    },
    steps: [],
    results: [],
  };
  const ports: RuntimePorts = {
    active: vi.fn(async () => true),
    reserve: vi.fn(async () => true),
    setDefinition: vi.fn(async () => true),
    reusePrevious: vi.fn(async () => null),
    saveStep: vi.fn(async () => true),
    query: vi.fn(),
    saveResults: vi.fn(),
    requestInput: vi.fn(async () => true),
    finish: vi.fn(async () => true),
    queryHeatmap: vi.fn(async () => result),
    saveHeatmapResult: vi.fn(async () => 1),
  };
  return { context, ports, fetch: vi.fn() };
}
describe('热力图本地技能执行', () => {
  it('激活技能、读取参考和统一工具调用各计一次，零模型生成并绑定结果版本', async () => {
    const { context, ports, fetch } = setup();
    await executeAgent(context, ports, { apiKey: '', fetch });
    expect(ports.queryHeatmap).toHaveBeenCalledOnce();
    expect(ports.reserve).toHaveBeenCalledTimes(3);
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', summaryResultVersion: 1 }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['data_limit', 'retention'])('%s 同任务补问', async (category) => {
    const { context, ports } = setup();
    ports.queryHeatmap = vi.fn(async () => {
      throw Object.assign(new Error(category), { category });
    });
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.requestInput).toHaveBeenCalledWith(expect.objectContaining({ reason: category }));
    expect(ports.saveHeatmapResult).not.toHaveBeenCalled();
  });
  it('新尝试复用结果时绑定当前技能且不重复查询', async () => {
    const { context, ports } = setup();
    context.heatmapResult = { ...result, version: 4 };
    context.task.resultVersion = 4;
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryHeatmap).not.toHaveBeenCalled();
    expect(ports.reserve).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledWith(expect.objectContaining({ summaryResultVersion: 4 }));
  });
  it('取消后的查询结果不能持久化', async () => {
    const { context, ports } = setup();
    const controller = new AbortController();
    ports.queryHeatmap = vi.fn(async () => {
      controller.abort();
      return result;
    });
    await executeAgent(context, ports, { apiKey: '', signal: controller.signal });
    expect(ports.saveHeatmapResult).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });
  it('恢复当前尝试仍校验旧技能绑定；历史解释保持可读', async () => {
    const { context, ports } = setup();
    const catalog = await getBusinessSkillCatalog();
    context.heatmapResult = { ...result, version: 1 };
    context.steps = [
      {
        key: 'skill:0:ais-heatmap:activate',
        name: '激活可信技能',
        input: null,
        createdAt: result.generatedAt,
        output: {
          kind: 'skill_activation',
          binding: { ...catalog.get('ais-heatmap').binding, contentHash: '0'.repeat(64) },
          identity: {
            taskId: context.task.id,
            ownerId: context.task.ownerId,
            inputRevision: 0,
            generation: 1,
          },
        },
      },
    ];
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.finish).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'skill_changed' }),
    );
    context.task.intent = 'explain';
    context.task.selection = {};
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.finish).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'completed' }));
  });
});
