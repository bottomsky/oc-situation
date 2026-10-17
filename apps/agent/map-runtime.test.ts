import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executeAgent, type RuntimeContext, type RuntimePorts } from './runtime';
import { AgentTaskSchema } from '../../packages/contracts/agent';

function setup() {
  const now = new Date().toISOString();
  const context: RuntimeContext = {
    results: [],
    steps: [],
    task: AgentTaskSchema.parse({
      id: randomUUID(),
      ownerId: randomUUID(),
      sessionId: randomUUID(),
      status: 'running',
      goal: '高亮 MMSI 123456789 并聚焦',
      intent: 'vessel_highlights',
      selection: {
        mmsis: ['123456789'],
        vesselSelector: { mmsis: ['123456789'] },
        highlightAndFocus: true,
      },
      uiBinding: {
        clientId: randomUUID(),
        pageGeneration: 1,
        highlightsVersion: 1,
        cameraVersion: 1,
      },
      bbox: null,
      historyHours: 24,
      from: now,
      to: now,
      definitionId: null,
      generation: 1,
      modelCalls: 0,
      toolCalls: 0,
      resultVersion: 0,
      summaryResultVersion: null,
      summary: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    }),
  };
  const statuses = new Map<string, string>();
  const ports: RuntimePorts = {
    active: vi.fn(async () => true),
    reserve: vi.fn(async () => true),
    setDefinition: vi.fn(),
    reusePrevious: vi.fn(),
    saveResults: vi.fn(),
    query: vi.fn(),
    requestInput: vi.fn(async () => true),
    finish: vi.fn(async () => true),
    saveStep: vi.fn(async (key, name, output) => {
      if (!context.steps.some((s) => s.key === key))
        context.steps.push({ key, name, input: null, output, createdAt: now });
      return true;
    }),
    queryVessels: vi.fn(async () => ({
      kind: 'vessel_detail' as const,
      version: 0,
      inputRevision: 0,
      total: 1,
      truncated: false,
      items: [
        {
          mmsi: '123456789',
          name: '测试船',
          imo: null,
          shipType: 70,
          latestPosition: { lon: 120, lat: 30, observedAt: now, sogKnots: null, sourceId: 'test' },
        },
      ],
      asOf: now,
      selection: context.task.selection!,
    })),
    mapUi: {
      command: vi.fn(async (id) => (statuses.has(id) ? { status: statuses.get(id)! } : null)),
      queue: vi.fn(async (id) => {
        statuses.set(id, 'queued');
        return randomUUID();
      }),
    },
  };
  return { context, ports, statuses };
}
describe('builtin map skills', () => {
  it('runs highlight then camera only after successful browser receipts and restores without querying twice', async () => {
    const { context, ports, statuses } = setup();
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.mapUi!.queue).toHaveBeenLastCalledWith(
      'map_vessel_highlights',
      expect.any(String),
      { componentId: 'chart.vessel-highlights', action: 'show' },
    );
    expect(ports.finish).not.toHaveBeenCalled();
    statuses.set('map_vessel_highlights', 'succeeded');
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.mapUi!.queue).toHaveBeenLastCalledWith('map_map_camera', expect.any(String), {
      componentId: 'chart.viewport',
      action: 'focus',
    });
    statuses.set('map_map_camera', 'succeeded');
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryVessels).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        summary: expect.stringContaining('高亮并聚焦'),
      }),
    );
  });
  it('highlight alone leaves camera unchanged and does not claim success before receipt', async () => {
    const { context, ports } = setup();
    context.task.selection!.highlightAndFocus = false;
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.mapUi!.queue).toHaveBeenCalledTimes(1);
    expect(ports.finish).not.toHaveBeenCalled();
  });
  it('clears groups using trusted selection without a vessel query', async () => {
    const { context, ports } = setup();
    context.task.selection = { highlightClear: { mode: 'all' } };
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryVessels).not.toHaveBeenCalled();
    expect(ports.mapUi!.queue).toHaveBeenLastCalledWith(
      'map_vessel_highlights',
      expect.any(String),
      { componentId: 'chart.vessel-highlights', action: 'close' },
    );
  });
  it('asks for disambiguation and never queues an ambiguous single ship', async () => {
    const { context, ports } = setup();
    context.task.selection = { vesselSelector: { query: '测试船' } };
    const query = ports.queryVessels!;
    ports.queryVessels = vi.fn(async (kind, selection) => {
      const result = await query(kind, selection);
      return {
        ...result,
        total: 2,
        items: [...result.items, { ...result.items[0]!, mmsi: '987654321' }],
      };
    });
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.requestInput).toHaveBeenCalledWith({
      fields: ['vessel_selector'],
      reason: 'missing_vessel_selector',
    });
    expect(ports.mapUi!.queue).not.toHaveBeenCalled();
  });
  it('a rejected command is terminal and never replays an old effect', async () => {
    const { context, ports, statuses } = setup();
    await executeAgent(context, ports, { apiKey: '' });
    statuses.set('map_vessel_highlights', 'rejected');
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.mapUi!.queue).toHaveBeenCalledTimes(1);
    expect(ports.finish).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', errorCode: 'ui_rejected' }),
    );
  });
  it('attaches zoom to resolved ship coordinates, not the current camera', async () => {
    const { context, ports } = setup();
    context.task.intent = 'map_camera';
    context.task.selection!.mapTargetZoom = 8;
    await executeAgent(context, ports, { apiKey: '' });
    expect(context.steps.find((s) => s.key === 'map_map_camera')?.output).toMatchObject({
      payload: { request: { mode: 'point', center: [120, 30], zoom: 8 } },
    });
  });
  it('clears only the displayed task group chosen by index', async () => {
    const { context, ports } = setup();
    context.task.selection = { highlightTaskIndex: 2 };
    const first = { groupId: randomUUID(), taskId: randomUUID(), mmsis: ['123456789'] },
      second = { groupId: randomUUID(), taskId: randomUUID(), mmsis: ['987654321'] };
    ports.readHighlightGroups = vi.fn(async () => [first, second]);
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.queryVessels).not.toHaveBeenCalled();
    expect(context.steps.find((s) => s.key === 'map_vessel_highlights')?.output).toMatchObject({
      payload: { operation: 'clear', clear: { mode: 'groups', groupIds: [second.groupId] } },
    });
  });
  it('never clears unrelated ships in a partially matching group', async () => {
    const { context, ports } = setup();
    context.task.selection!.highlightClearUnclear = true;
    ports.readHighlightGroups = vi.fn(async () => [
      { groupId: randomUUID(), taskId: randomUUID(), mmsis: ['123456789', '987654321'] },
    ]);
    await executeAgent(context, ports, { apiKey: '' });
    expect(ports.requestInput).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'missing_vessel_selector' }),
    );
    expect(ports.mapUi!.queue).not.toHaveBeenCalled();
  });
});
