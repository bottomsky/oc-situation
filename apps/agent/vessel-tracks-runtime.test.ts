import { describe, expect, it, vi } from 'vitest';
import { executeAgent, type RuntimePorts, type RuntimeContext } from './runtime';
import type { AgentVesselTracksResult } from '../../packages/contracts/vessel-tracks';
import { getBusinessSkillCatalog } from './business-capabilities';

const selection = {
  purpose: 'vessel_tracks' as const,
  vesselSelector: { shipTypes: [70] },
  bbox: [120, 30, 122, 32] as [number, number, number, number],
  timeRange: { from: '2026-10-13T00:00:00.000Z', to: '2026-10-14T00:00:00.000Z' },
};
const result: AgentVesselTracksResult = {
  kind: 'vessel_tracks',
  version: 0,
  inputRevision: 0,
  query: {
    bbox: selection.bbox,
    ...selection.timeRange,
    selector: selection.vesselSelector,
    maxVessels: 20,
    maxPointsPerVessel: 500,
  },
  tracks: [],
  returnedVessels: 0,
  matchedVesselsLowerBound: 0,
  hasMoreVessels: false,
  generatedAt: selection.timeRange.to,
  asOf: selection.timeRange.to,
  selectionBasis: 'historical_observation_in_bbox',
  trackScope: 'full_time_window',
  shipTypeBasis: 'current_profile',
};
function setup() {
  const context: RuntimeContext = {
    task: {
      id: '11111111-1111-4111-8111-111111111111',
      ownerId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      goal: '生成当前视野AIS历史航线',
      intent: 'vessel_tracks',
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
    queryVesselTracks: vi.fn(async () => result),
    saveTracksResult: vi.fn(async () => 1),
  };
  return { context, ports, fetch: vi.fn() };
}
describe('历史航线本地技能执行', () => {
  it('摘要报告采样及截断且不外发轨迹', async () => {
    const { context, ports, fetch } = setup();
    ports.queryVesselTracks = vi.fn(async () => ({
      ...result,
      returnedVessels: 1,
      matchedVesselsLowerBound: 1,
      tracks: [
        {
          mmsi: '413123456',
          name: 'test',
          shipType: 70,
          segments: [{ points: [{ lon: 121, lat: 31, observedAt: selection.timeRange.from }] }],
          total: 3,
          returned: 1,
          sampled: true,
          truncated: true,
        },
      ],
    }));
    await executeAgent(context, ports, { apiKey: '', fetch });
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        summary: expect.stringContaining('1 条航线已采样'),
      }),
    );
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining('1 条航线因点数上限截断') }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it('缺少船舶目标进入补问且不查询', async () => {
    const { context, ports } = setup();
    context.task.selection = { ...selection, vesselSelector: undefined };
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryVesselTracks).not.toHaveBeenCalled();
    expect(ports.requestInput).toHaveBeenCalledWith({
      fields: ['vessel_selector'],
      reason: 'missing_vessel_selector',
    });
  });
  it('激活技能、读取参考和统一工具调用各计一次，零模型生成并绑定结果版本', async () => {
    const { context, ports, fetch } = setup();
    await executeAgent(context, ports, { apiKey: '', fetch });
    expect(ports.queryVesselTracks).toHaveBeenCalledOnce();
    expect(ports.reserve).toHaveBeenCalledTimes(3);
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', summaryResultVersion: 1 }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['data_limit', 'retention'])('%s 同任务补问', async (category) => {
    const { context, ports } = setup();
    ports.queryVesselTracks = vi.fn(async () => {
      throw Object.assign(new Error(category), { category });
    });
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.requestInput).toHaveBeenCalledWith(expect.objectContaining({ reason: category }));
    expect(ports.saveTracksResult).not.toHaveBeenCalled();
  });
  it('新尝试复用结果时绑定当前技能且不重复查询', async () => {
    const { context, ports } = setup();
    context.tracksResult = { ...result, version: 4 };
    context.task.resultVersion = 4;
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryVesselTracks).not.toHaveBeenCalled();
    expect(ports.reserve).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledWith(expect.objectContaining({ summaryResultVersion: 4 }));
  });
  it('取消后的查询结果不能持久化', async () => {
    const { context, ports } = setup();
    const controller = new AbortController();
    ports.queryVesselTracks = vi.fn(async () => {
      controller.abort();
      return result;
    });
    await executeAgent(context, ports, { apiKey: '', signal: controller.signal });
    expect(ports.saveTracksResult).not.toHaveBeenCalled();
    expect(ports.finish).not.toHaveBeenCalled();
  });
  it('恢复当前尝试仍校验旧技能绑定；历史解释保持可读', async () => {
    const { context, ports } = setup();
    const catalog = await getBusinessSkillCatalog();
    context.tracksResult = { ...result, version: 1 };
    context.steps = [
      {
        key: 'skill:0:vessel-tracks:activate',
        name: '激活可信技能',
        input: null,
        createdAt: result.generatedAt,
        output: {
          kind: 'skill_activation',
          binding: { ...catalog.get('vessel-tracks').binding, contentHash: '0'.repeat(64) },
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
