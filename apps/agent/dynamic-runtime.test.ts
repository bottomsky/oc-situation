import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AgentTask } from '../../packages/contracts/agent';
import type {
  DynamicSkillDefinition,
  DynamicSkillExecution,
  DynamicSkillCall,
} from '../../packages/contracts/dynamic-skills';
import type { RuntimeContext, RuntimePorts } from './runtime';
import { executeDynamicSkill, type DynamicRuntimePorts } from './dynamic-runtime';

const definition: DynamicSkillDefinition = {
  schemaVersion: 1,
  name: 'cargo-tracks-heatmap',
  description: '货船历史航线与热力图',
  body: '按宿主输入先筛选货船，再查询历史航线和热力图。',
  references: {},
  requiredInputs: ['region', 'time'],
  expectedArtifacts: [
    { stepId: 'cargo', kind: 'vessel_list' },
    { stepId: 'tracks', kind: 'vessel_tracks' },
    { stepId: 'heatmap', kind: 'ais_heatmap' },
  ],
  requiredDisplays: ['tracks', 'heatmap'],
  toolIds: ['query_vessels', 'query_vessel_tracks', 'query_ais_heatmap'],
  steps: [
    {
      id: 'cargo',
      toolId: 'query_vessels',
      input: { selection: { $ref: 'input.selection' }, vesselClass: 'cargo' },
      artifactKind: 'vessel_list',
    },
    {
      id: 'tracks',
      toolId: 'query_vessel_tracks',
      input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
      artifactKind: 'vessel_tracks',
      ui: { componentId: 'chart.vessel-tracks', action: 'show' },
    },
    {
      id: 'heatmap',
      toolId: 'query_ais_heatmap',
      input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
      artifactKind: 'ais_heatmap',
      ui: { componentId: 'chart.heatmap', action: 'show' },
    },
  ],
};
function sseCandidate(candidate: unknown) {
  const envelope = {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
  };
  return new Response(
    `data: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'create', type: 'function', function: { name: 'skills_create', arguments: JSON.stringify({ definition: candidate }) } }] }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...envelope, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function fixture(bound = true) {
  const task = {
    id: randomUUID(),
    ownerId: randomUUID(),
    generation: 1,
    inputRevision: 0,
    goal: '筛选当前区域货船413123456，展示历史航线和热力图 api_key=secret',
    selection: {
      bbox: [120, 30, 122, 32],
      timeRange: { from: '2026-10-16T00:00:00Z', to: '2026-10-16T01:00:00Z' },
    },
    uiBinding: { clientId: randomUUID(), pageGeneration: 1 },
  } as AgentTask;
  const binding = {
    skillId: 'cargo-tracks-heatmap',
    version: '1',
    contentHash: 'a'.repeat(64),
    adapterVersion: '1',
  };
  const version = {
    ownerId: task.ownerId,
    binding,
    definition,
    source: 'agent' as const,
    createdAt: '2026-10-16T00:00:00Z',
    revokedAt: null,
  };
  const execution: DynamicSkillExecution = {
    taskBinding: bound
      ? {
          ownerId: task.ownerId,
          taskId: task.id,
          inputRevision: 0,
          binding,
          toolCeiling: [...definition.toolIds],
          boundAt: '2026-10-16T00:00:00Z',
        }
      : null,
    version: bound ? version : null,
    calls: [],
    artifacts: [],
    createdVersions: [],
  };
  const context: RuntimeContext = { task, steps: [], results: [] };
  const counts = {
    models: 0,
    tools: 0,
    query: 0,
    tracks: 0,
    heatmap: 0,
    publish: 0,
    finish: '',
    error: '',
  };
  const commands = new Map<string, { status: string; result?: unknown }>();
  const ports = {
    active: async () => true,
    reserve: async (kind: string) => {
      if (kind === 'model') counts.models++;
      else counts.tools++;
      return true;
    },
    saveStep: async (key: string, name: string, output: unknown) => {
      context.steps.push({ key, name, input: null, output, createdAt: new Date().toISOString() });
      return true;
    },
    queryVessels: async (kind: string, selection: unknown) => {
      counts.query++;
      return {
        kind,
        version: 0,
        inputRevision: 0,
        total: 1,
        truncated: false,
        asOf: '2026-10-16T01:00:00Z',
        selection,
        items: [
          { mmsi: '413123456', name: '秘密船名', imo: null, shipType: 70, latestPosition: null },
        ],
      };
    },
    queryVesselTracks: async (query: unknown) => {
      counts.tracks++;
      return {
        query,
        asOf: '2026-10-16T01:00:00Z',
        generatedAt: '2026-10-16T01:00:00Z',
        shipTypeBasis: 'current_profile',
        selectionBasis: 'historical_observation_in_bbox',
        trackScope: 'full_time_window',
        returnedVessels: 0,
        matchedVesselsLowerBound: 0,
        hasMoreVessels: false,
        tracks: [],
      };
    },
    queryHeatmap: async (query: unknown) => {
      counts.heatmap++;
      return {
        query,
        grid: { level: 0, cellDegrees: 360 },
        cells: [],
        totalVessels: 0,
        generatedAt: '2026-10-16T01:00:00Z',
        metric: 'unique_vessels',
        shipTypeBasis: 'current_profile',
      };
    },
    finish: async (outcome: { status: string; errorCode?: string }) => {
      counts.finish = outcome.status;
      counts.error = outcome.errorCode ?? '';
      return true;
    },
  } as unknown as RuntimePorts;
  const dynamic: DynamicRuntimePorts = {
    read: async () => execution,
    catalog: async () => ({ catalogRevision: 0, items: [] }),
    detail: async () => null,
    bind: async () => execution,
    publish: async () => {
      counts.publish++;
      execution.version = version;
      execution.taskBinding = {
        ownerId: task.ownerId,
        taskId: task.id,
        inputRevision: 0,
        binding,
        toolCeiling: [...definition.toolIds],
        boundAt: version.createdAt,
      };
      return execution;
    },
    authorize: async () => true,
    begin: async (stepId, toolId, input) => {
      const existing = execution.calls.find((call) => call.stepId === stepId);
      if (existing) return existing;
      const call: DynamicSkillCall = {
        callId: randomUUID(),
        taskId: task.id,
        inputRevision: 0,
        stepId,
        toolId,
        generation: task.generation,
        status: 'running',
        input,
        localResult: null,
        modelProjection: null,
        artifactRefs: [],
        errorCode: null,
        createdAt: version.createdAt,
        updatedAt: version.createdAt,
      };
      execution.calls.push(call);
      return call;
    },
    complete: async (stepId, localResult, modelProjection, artifact) => {
      const call = execution.calls.find((entry) => entry.stepId === stepId)!;
      call.localResult = localResult;
      call.modelProjection = modelProjection;
      call.status = definition.steps.find((step) => step.id === stepId)?.ui
        ? 'waiting_ui'
        : 'completed';
      if (artifact) {
        const id = randomUUID();
        execution.artifacts.push({
          id,
          ownerId: task.ownerId,
          taskId: task.id,
          inputRevision: 0,
          stepId,
          ...artifact,
          createdAt: version.createdAt,
        });
        call.artifactRefs = [id];
      }
      return call;
    },
    fail: async () => {},
    uiCommand: async (stepId) => commands.get(stepId) ?? null,
    queueUi: async (stepId) => {
      commands.set(stepId, { status: 'queued' });
      return randomUUID();
    },
  };
  const acknowledge = (stepId: string) => {
    commands.set(stepId, { status: 'succeeded', result: {} });
    execution.calls.find((call) => call.stepId === stepId)!.status = 'completed';
    task.generation++;
  };
  return { context, ports, dynamic, counts, execution, acknowledge, commands, version };
}

describe('durable dynamic composition', () => {
  it('rejects a skill that multiplies a single explicit business write across steps', async () => {
    const prior = process.env.AGENT_BUSINESS_WRITE_ENABLED;
    process.env.AGENT_BUSINESS_WRITE_ENABLED = 'true';
    try {
      const m = fixture();
      m.context.task.goal = '创建事件 标题：单次授权';
      m.version.definition = {
        ...definition,
        name: 'duplicate-business-write',
        requiredInputs: [],
        requiredDisplays: [],
        toolIds: ['create_event'],
        steps: ['first', 'second'].map((id) => ({
          id,
          toolId: 'create_event',
          input: { selection: { $ref: 'input.selection' } },
          artifactKind: 'operational_event',
        })),
        expectedArtifacts: ['first', 'second'].map((stepId) => ({
          stepId,
          kind: 'operational_event',
        })),
      };
      m.execution.taskBinding!.toolCeiling = ['create_event'];
      let writes = 0;
      m.ports.businessTool = async () => {
        writes++;
        return { kind: 'operational_event', event: { id: randomUUID() } };
      };
      await executeDynamicSkill(m.context, m.ports, m.dynamic, {
        apiKey: 'fixture',
        dynamicSkillsEnabled: true,
      });
      expect(writes).toBe(0);
      expect(m.counts.finish).toBe('failed');
      expect(m.counts.error).toBe('duplicate_business_operation');
    } finally {
      if (prior === undefined) delete process.env.AGENT_BUSINESS_WRITE_ENABLED;
      else process.env.AGENT_BUSINESS_WRITE_ENABLED = prior;
    }
  });
  it('composes a queried vessel set into highlight and camera artifacts with separate required receipts', async () => {
    const m = fixture();
    m.context.task.goal = '筛选当前区域货船并高亮聚焦';
    m.version.definition = {
      ...definition,
      name: 'cargo-highlights-camera',
      description: '查询船舶后高亮并聚焦',
      body: '按宿主输入查询后高亮，聚焦同一查询快照。',
      requiredInputs: ['region'],
      toolIds: ['query_vessels', 'prepare_vessel_highlights', 'prepare_map_camera'],
      steps: [
        definition.steps[0]!,
        {
          id: 'highlights',
          toolId: 'prepare_vessel_highlights',
          input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
          artifactKind: 'vessel_highlights',
          ui: { componentId: 'chart.vessel-highlights', action: 'show' },
        },
        {
          id: 'camera',
          toolId: 'prepare_map_camera',
          input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
          artifactKind: 'map_camera',
          ui: { componentId: 'chart.viewport', action: 'focus' },
        },
      ],
      expectedArtifacts: [
        { stepId: 'cargo', kind: 'vessel_list' },
        { stepId: 'highlights', kind: 'vessel_highlights' },
        { stepId: 'camera', kind: 'map_camera' },
      ],
      requiredDisplays: ['highlights', 'camera'],
    };
    m.execution.taskBinding!.toolCeiling = [...m.version.definition.toolIds];
    const query = m.ports.queryVessels!;
    m.ports.queryVessels = async (...args) => {
      const result = await query(...args);
      return {
        ...result,
        items: result.items.map((v) => ({
          ...v,
          latestPosition: {
            lat: 31,
            lon: 121,
            observedAt: result.asOf,
            sogKnots: 0,
            sourceId: 'test',
          },
        })),
      };
    };
    const complete = m.dynamic.complete;
    m.dynamic.complete = async (...args) => {
      const call = await complete(...args);
      if (m.version.definition.steps.find((s) => s.id === call.stepId)?.ui)
        call.status = 'waiting_ui';
      return call;
    };
    const options = { apiKey: 'fixture', dynamicSkillsEnabled: true };
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.commands.get('highlights')?.status).toBe('queued');
    expect(
      m.execution.artifacts.find((a) => a.kind === 'vessel_highlights')?.modelProjection,
    ).toEqual({ operation: 'show', targetCount: 1, missingCount: 0 });
    m.acknowledge('highlights');
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.commands.get('camera')?.status).toBe('queued');
    expect(m.execution.artifacts.find((a) => a.kind === 'map_camera')?.payload).toMatchObject({
      request: { mode: 'point', center: [121, 31], zoom: 10 },
    });
    m.acknowledge('camera');
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.counts).toMatchObject({ query: 1, models: 0, finish: 'completed' });
  });
  it('waits for each presentation and resumes without repeating prior queries', async () => {
    const m = fixture();
    const options = { apiKey: 'fixture', dynamicSkillsEnabled: true };
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.counts).toMatchObject({ query: 1, tracks: 1, heatmap: 0, finish: '' });
    m.acknowledge('tracks');
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.counts).toMatchObject({ query: 1, tracks: 1, heatmap: 1, finish: '' });
    m.acknowledge('heatmap');
    await executeDynamicSkill(m.context, m.ports, m.dynamic, options);
    expect(m.counts.finish).toBe('completed');
    expect(m.execution.artifacts).toHaveLength(3);
  });
  it('creates, validates, publishes, loads and executes a missing skill in the same task', async () => {
    const m = fixture(false);
    const requests: string[] = [];
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async (_input, init) => {
        requests.push(String(init?.body));
        return sseCandidate(definition);
      },
    });
    expect(m.counts).toMatchObject({ models: 1, publish: 1, query: 1, tracks: 1 });
    expect(requests.join('')).not.toMatch(/413123456|120,30|secret|秘密船名/);
  });
  it('rejects a candidate that omits a host-required result and stops after two requests', async () => {
    const m = fixture(false);
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async () =>
        sseCandidate({
          ...definition,
          toolIds: ['query_vessels'],
          steps: [definition.steps[0]],
          expectedArtifacts: [],
          requiredDisplays: [],
        }),
    });
    expect(m.counts).toMatchObject({ models: 2, publish: 0, query: 0, finish: 'failed' });
  });
  it('keeps candidate attempts bounded across restart and stops on the shared tool budget', async () => {
    const m = fixture(false);
    for (const attempt of [0, 1])
      m.context.steps.push({
        key: `dynamic_candidate:0:${attempt}`,
        name: '生成技能候选',
        input: null,
        output: { status: 'allocated' },
        createdAt: new Date().toISOString(),
      });
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async () => {
        throw new Error('allocated attempts cannot be repeated');
      },
    });
    expect(m.counts).toMatchObject({ models: 0, publish: 0, error: 'candidate_limit' });
    const n = fixture(false);
    const reserve = n.ports.reserve;
    n.ports.reserve = async (kind, maximum) => (kind === 'tool' ? false : reserve(kind, maximum));
    await executeDynamicSkill(n.context, n.ports, n.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async () => sseCandidate(definition),
    });
    expect(n.counts).toMatchObject({ models: 1, publish: 0, error: 'budget_exhausted' });
  });
  it('loads an explicit single-chart method and retains its persisted cargo class on a bare request', async () => {
    const m = fixture();
    m.context.task.goal = '运行这个技能';
    m.context.task.skillRef = { skillId: m.version.binding.skillId, version: '1' };
    m.version.definition = {
      ...definition,
      toolIds: ['query_vessels', 'query_ais_heatmap'],
      steps: definition.steps.filter((step) => step.id !== 'tracks'),
      expectedArtifacts: definition.expectedArtifacts.filter(
        (artifact) => artifact.stepId !== 'tracks',
      ),
      requiredDisplays: ['heatmap'],
    };
    m.execution.taskBinding!.toolCeiling = [...m.version.definition.toolIds];
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(m.counts).toMatchObject({ query: 1, tracks: 0, heatmap: 1, models: 0 });
    expect(
      m.execution.artifacts.find((artifact) => artifact.stepId === 'cargo')?.payload,
    ).toMatchObject({
      selection: { vesselSelector: { shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79] } },
    });
    m.acknowledge('heatmap');
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(m.counts.finish).toBe('completed');
  });
  it('executes a published vessel detail step from its version rather than the new request text', async () => {
    const m = fixture();
    m.context.task.goal = '运行这个技能';
    m.context.task.skillRef = { skillId: m.version.binding.skillId, version: '1' };
    m.context.task.selection = { ...m.context.task.selection, mmsis: ['413123456'] };
    m.version.definition = {
      ...definition,
      requiredInputs: ['vessels'],
      toolIds: ['query_vessels'],
      steps: [
        {
          id: 'cargo',
          toolId: 'query_vessels',
          input: { selection: { $ref: 'input.selection' } },
          artifactKind: 'vessel_detail',
        },
      ],
      expectedArtifacts: [{ stepId: 'cargo', kind: 'vessel_detail' }],
      requiredDisplays: [],
    };
    m.execution.taskBinding!.toolCeiling = ['query_vessels'];
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(m.counts).toMatchObject({ query: 1, models: 0, finish: 'completed' });
    expect(m.execution.artifacts[0]?.payload).toMatchObject({ kind: 'vessel_detail' });
  });
  it('runs list and detail variants in separate steps of the same immutable method', async () => {
    const m = fixture();
    m.context.task.goal = '运行这个技能';
    m.context.task.skillRef = { skillId: m.version.binding.skillId, version: '1' };
    m.version.definition = {
      ...definition,
      requiredInputs: ['region'],
      toolIds: ['query_vessels'],
      steps: [
        definition.steps[0]!,
        {
          id: 'detail',
          toolId: 'query_vessels',
          input: { selection: { $ref: 'input.selection' }, vessels: { $ref: 'steps.cargo' } },
          artifactKind: 'vessel_detail',
        },
      ],
      expectedArtifacts: [
        { stepId: 'cargo', kind: 'vessel_list' },
        { stepId: 'detail', kind: 'vessel_detail' },
      ],
      requiredDisplays: [],
    };
    m.execution.taskBinding!.toolCeiling = ['query_vessels'];
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(m.counts).toMatchObject({ query: 2, finish: 'completed' });
    expect(m.execution.artifacts.map((artifact) => artifact.kind)).toEqual([
      'vessel_list',
      'vessel_detail',
    ]);
  });
  it('rejects a candidate that drops one requested vessel class from a union', async () => {
    const m = fixture(false);
    m.context.task.goal = '展示货船和油轮最近24小时航线与热力图';
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      fetch: async () => sseCandidate(definition),
    });
    expect(m.counts).toMatchObject({ models: 2, publish: 0, query: 0, error: 'candidate_limit' });
  });
  it('reuses one compatible published skill without another model or publication', async () => {
    const m = fixture(false);
    m.dynamic.catalog = async () => ({
      catalogRevision: 1,
      items: [
        {
          skillId: m.version.binding.skillId,
          name: definition.name,
          description: definition.description,
          toolIds: definition.toolIds,
          enabled: true,
          currentVersion: '1',
          source: 'agent',
          createdAt: m.version.createdAt,
          updatedAt: m.version.createdAt,
        },
      ],
    });
    m.dynamic.detail = async () => ({ versions: [m.version] });
    m.dynamic.bind = async () => {
      m.execution.version = m.version;
      m.execution.taskBinding = {
        ownerId: m.context.task.ownerId,
        taskId: m.context.task.id,
        inputRevision: 0,
        binding: m.version.binding,
        toolCeiling: definition.toolIds,
        boundAt: m.version.createdAt,
      };
      return m.execution;
    };
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(m.counts).toMatchObject({ models: 0, publish: 0, query: 1, tracks: 1 });
  });
  it('requests missing tool inputs before querying and never randomly executes an unknown goal', async () => {
    const m = fixture();
    const requested: unknown[] = [];
    m.ports.requestInput = async (spec) => {
      requested.push(spec);
      return true;
    };
    m.context.task.selection = {};
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(requested).toEqual([{ fields: ['region', 'time'], reason: 'missing_region' }]);
    expect(m.counts.query).toBe(0);
    const n = fixture(false);
    n.context.task.goal = '对比区域内多种观测';
    n.ports.requestInput = async (spec) => {
      requested.push(spec);
      return true;
    };
    await executeDynamicSkill(n.context, n.ports, n.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
    });
    expect(requested.at(-1)).toEqual({ fields: ['goal'], reason: 'missing_goal' });
    expect(n.counts.models).toBe(0);
  });
  it('rechecks the live feature switch and treats an unknown UI result as unconfirmed', async () => {
    const m = fixture();
    await executeDynamicSkill(m.context, m.ports, m.dynamic, {
      apiKey: 'fixture',
      dynamicSkillsEnabled: true,
      dynamicSkillsAllowed: () => false,
    });
    expect(m.counts.query).toBe(0);
    expect(m.counts.finish).toBe('failed');
    const n = fixture();
    const options = { apiKey: 'fixture', dynamicSkillsEnabled: true };
    await executeDynamicSkill(n.context, n.ports, n.dynamic, options);
    n.commands.set('tracks', { status: 'unknown' });
    await executeDynamicSkill(n.context, n.ports, n.dynamic, options);
    expect(n.counts.finish).toBe('failed');
    expect(n.counts.error).toBe('ui_unknown');
    expect(n.counts.heatmap).toBe(0);
  });
});
