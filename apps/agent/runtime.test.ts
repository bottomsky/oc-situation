import { describe, expect, it } from 'vitest';
import { executeAgent, guardedFetch, type RuntimePorts } from './runtime';
import type { AgentTask, AgentQueryResult, AgentInputSpec } from '../../packages/contracts/agent';
import type { AnalysisResult, TopicDataset } from '../../packages/contracts/topics';

export const task = {
  id: 'local-task',
  ownerId: 'local-owner',
  goal: '分析低速 413123456 秘密名称 121.5,31.2 api_key=secret',
  bbox: [120, 30, 122, 32],
  from: new Date(Date.now() - 24 * 3600_000).toISOString(),
  to: new Date().toISOString(),
  historyHours: 24,
  definitionId: null,
  resultVersion: 0,
  modelCalls: 0,
  toolCalls: 0,
  generation: 1,
} as AgentTask;
export function memoryPorts(dataset?: TopicDataset) {
  const state = {
    modelCalls: 0,
    toolCalls: 0,
    results: [] as AnalysisResult[],
    version: 0,
    status: '',
    summary: '',
    error: '',
    errorCode: '',
    queries: 0,
    reuseCalls: 0,
    definitions: [] as string[],
    steps: new Map<string, unknown>(),
  };
  const ports: RuntimePorts = {
    async active() {
      return true;
    },
    async reserve(kind, maximum) {
      const key = kind === 'model' ? 'modelCalls' : 'toolCalls';
      return ++state[key] <= maximum;
    },
    async setDefinition(definition) {
      state.definitions.push(definition);
      return true;
    },
    async reusePrevious() {
      state.reuseCalls++;
      return { ...task, resultVersion: 1, definitionId: 'port-restriction' };
    },
    async saveStep(key, _name, output) {
      state.steps.set(key, output);
      return true;
    },
    async query() {
      state.queries++;
      return (
        dataset ?? { from: task.from, to: task.to, queriedAt: task.to, ais: [], intelligence: [] }
      );
    },
    async saveResults(results) {
      state.results = results;
      state.version = 1;
      return 1;
    },
    async finish(outcome) {
      state.status = outcome.status;
      state.summary = outcome.summary ?? '';
      state.error = outcome.error ?? '';
      state.errorCode = outcome.errorCode ?? '';
      return true;
    },
  };
  return { ports, state };
}

/** OpenAI-compatible SSE fixture exercises the real Pi provider serializer and agent loop. */
export function sse(content: Record<string, unknown>, finish: string) {
  const chunk = {
    id: 'fixture',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'deepseek-flash',
    choices: [{ index: 0, delta: content, finish_reason: null }],
  };
  return new Response(
    `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('结构化补充与只读查询续作', () => {
  const queryResult: AgentQueryResult = {
    kind: 'vessel_list',
    version: 0,
    inputRevision: 1,
    total: 1,
    truncated: false,
    asOf: '2026-10-13T01:00:00.000Z',
    selection: { bbox: [120, 30, 122, 32], purpose: 'vessel_list' },
    items: [
      { mmsi: '413123456', name: '本地秘密船名', imo: null, shipType: 70, latestPosition: null },
    ],
  };
  it('同任务补充后查询不调用模型，提交结果版本后才完成', async () => {
    const { ports, state } = memoryPorts();
    const calls: string[] = [];
    ports.queryVessels = async () => {
      calls.push('query');
      return queryResult;
    };
    ports.saveQueryResult = async () => {
      calls.push('save');
      return 2;
    };
    const finish = ports.finish;
    ports.finish = async (outcome) => {
      calls.push('finish');
      expect(outcome.summaryResultVersion).toBe(2);
      return finish(outcome);
    };
    await executeAgent(
      {
        task: {
          ...task,
          goal: '当前视野有哪些船舶',
          intent: 'vessel_list',
          inputRevision: 1,
          selection: queryResult.selection,
        },
        steps: [],
        results: [],
      },
      ports,
      {
        apiKey: '',
        fetch: async () => {
          throw new Error('must stay local');
        },
      },
    );
    expect(calls).toEqual(['query', 'save', 'finish']);
    expect(state.status).toBe('completed');
    expect(state.modelCalls).toBe(0);
    expect(state.summary).toContain('1 艘');
  });
  it('缺区域用requestInput原子挂起，不再调用finish', async () => {
    const { ports } = memoryPorts();
    const requests: AgentInputSpec[] = [];
    ports.requestInput = async (spec) => {
      requests.push(spec);
      return true;
    };
    ports.finish = async () => {
      throw new Error('lease already released');
    };
    await executeAgent(
      {
        task: {
          ...task,
          goal: '有哪些船舶',
          bbox: null,
          intent: 'vessel_list',
          selection: { purpose: 'vessel_list' },
        },
        steps: [],
        results: [],
      },
      ports,
      { apiKey: '' },
    );
    expect(requests).toEqual([{ fields: ['region'], reason: 'missing_region' }]);
  });
  it('模型补问持久化后立即结束，不再保存步骤或调用模型', async () => {
    const { ports } = memoryPorts();
    let paused = false;
    ports.requestInput = async () => {
      paused = true;
      return true;
    };
    ports.active = async () => !paused;
    ports.finish = async () => {
      throw new Error('must not finish after pause');
    };
    ports.saveStep = async () => {
      throw new Error('must not save after pause');
    };
    let calls = 0;
    await executeAgent({ task, steps: [], results: [] }, ports, {
      apiKey: 'synthetic',
      fetch: async () => {
        calls++;
        return sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'request',
                type: 'function',
                function: {
                  name: 'request_input',
                  arguments: JSON.stringify({ fields: ['time'], reason: 'missing_time' }),
                },
              },
            ],
          },
          'tool_calls',
        );
      },
    });
    expect(paused).toBe(true);
    expect(calls).toBe(1);
  });
  it.each([0, 1])('只恢复相同输入修订的查询快照：已有修订 %s', async (resultRevision) => {
    const { ports, state } = memoryPorts();
    let queries = 0;
    ports.queryVessels = async () => {
      queries++;
      return queryResult;
    };
    ports.saveQueryResult = async () => 3;
    await executeAgent(
      {
        task: {
          ...task,
          intent: 'vessel_list',
          selection: queryResult.selection,
          inputRevision: 1,
          resultInputRevision: resultRevision,
          resultVersion: 2,
        },
        steps: [],
        results: [],
        queryResult: { ...queryResult, inputRevision: resultRevision, version: 2 },
      },
      ports,
      { apiKey: '' },
    );
    expect(queries).toBe(resultRevision === 1 ? 0 : 1);
    expect(state.status).toBe('completed');
  });
  it('查询预算耗尽是终态失败，不创建补充请求', async () => {
    const { ports, state } = memoryPorts();
    ports.reserve = async () => false;
    ports.queryVessels = async () => {
      throw new Error('must not query');
    };
    ports.saveQueryResult = async () => 1;
    ports.requestInput = async () => {
      throw new Error('budget cannot be fixed by input');
    };
    await executeAgent(
      {
        task: { ...task, intent: 'vessel_list', selection: queryResult.selection },
        steps: [],
        results: [],
      },
      ports,
      { apiKey: '' },
    );
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('budget_exhausted');
  });
  it('查询追问绑定已保存的快照，不重新查询或向模型外发船舶资料', async () => {
    const { ports, state } = memoryPorts();
    let saved: AgentQueryResult | undefined;
    ports.queryVessels = async () => {
      throw new Error('must not refresh snapshot');
    };
    ports.saveQueryResult = async (result) => {
      saved = result;
      return 1;
    };
    await executeAgent(
      {
        task: { ...task, goal: '解释上次查询结果', intent: 'explain', inputRevision: 0 },
        steps: [],
        results: [],
        previous: {
          task: { ...task, inputRevision: 1, resultInputRevision: 1, resultVersion: 4 },
          steps: [],
          results: [],
          queryResult: { ...queryResult, version: 4 },
        },
      },
      ports,
      {
        apiKey: '',
        fetch: async () => {
          throw new Error('private query stays local');
        },
      },
    );
    expect(saved?.asOf).toBe(queryResult.asOf);
    expect(saved?.inputRevision).toBe(0);
    expect(state.summary).toContain('上次已保存的查询快照');
    expect(state.status).toBe('completed');
    expect(state.modelCalls).toBe(0);
  });
  it('解释任务重试或恢复时优先当前修订快照，无需原父任务', async () => {
    const { ports, state } = memoryPorts();
    ports.queryVessels = async () => {
      throw new Error('snapshot must not be refreshed');
    };
    ports.saveQueryResult = async () => {
      throw new Error('already persisted');
    };
    await executeAgent(
      {
        task: {
          ...task,
          goal: '解释上次查询结果',
          intent: 'explain',
          inputRevision: 0,
          resultInputRevision: 0,
          resultVersion: 1,
        },
        steps: [],
        results: [],
        queryResult: { ...queryResult, version: 1, inputRevision: 0 },
      },
      ports,
      {
        apiKey: '',
        fetch: async () => {
          throw new Error('must not call supplier');
        },
      },
    );
    expect(state.status).toBe('completed');
    expect(state.summary).toContain('上次已保存的查询快照');
    expect(state.modelCalls).toBe(0);
  });
  it.each([false, true])('视野变化：明确重查=%s时决定执行新查询或解释原快照', async (rerun) => {
    const { ports, state } = memoryPorts();
    let calls = 0;
    let saved: AgentQueryResult | undefined;
    const bbox: [number, number, number, number] = [130, 35, 140, 40];
    ports.queryVessels = async (_kind, selection) => {
      calls++;
      return { ...queryResult, selection, inputRevision: 0 };
    };
    ports.saveQueryResult = async (result) => {
      saved = result;
      return 1;
    };
    await executeAgent(
      {
        task: {
          ...task,
          goal: rerun ? '解释上次结果，然后按当前视野再查一次' : '解释上次查询结果，当前范围变了',
          bbox,
          inputRevision: 0,
        },
        steps: [],
        results: [],
        previous: {
          task: { ...task, resultVersion: 1, inputRevision: 1, resultInputRevision: 1 },
          steps: [],
          results: [],
          queryResult,
        },
      },
      ports,
      {
        apiKey: '',
        fetch: async () => {
          throw new Error('must not call supplier');
        },
      },
    );
    expect(calls).toBe(rerun ? 1 : 0);
    expect(saved!.selection.bbox).toEqual(rerun ? bbox : queryResult.selection.bbox);
    expect(state.status).toBe('completed');
    expect(state.modelCalls).toBe(0);
  });
});

describe('真实 Pi 循环与外发请求', () => {
  it.each([{ bbox: null }, { bbox: task.bbox }])(
    '问候在区域 $bbox 下都经过真实 Pi provider 并保持分析上下文本地',
    async ({ bbox }) => {
      const { ports, state } = memoryPorts();
      const bodies: string[] = [];
      await executeAgent(
        {
          task: { ...task, goal: '你好', bbox },
          results: [],
          steps: [],
          previous: {
            task: { ...task, definitionId: 'port-restriction', resultVersion: 1 },
            results: [],
            steps: [],
          },
        },
        ports,
        {
          apiKey: 'synthetic-test-key',
          fetch: async (_url, init) => {
            bodies.push(String(init?.body));
            return sse({ role: 'assistant', content: '您好，我可以协助海上情报研判。' }, 'stop');
          },
        },
      );
      expect(state.status).toBe('completed');
      expect(state.summary).toBe('您好，我可以协助海上情报研判。');
      expect(state.version).toBe(0);
      expect(state.queries).toBe(0);
      expect(state.reuseCalls).toBe(0);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain('greeting');
      for (const secret of [
        '你好',
        '413123456',
        '秘密名称',
        '121.5',
        '31.2',
        'api_key=secret',
        'local-task',
        task.from,
      ])
        expect(bodies[0]).not.toContain(secret);
    },
  );
  it.each([{ bbox: null }, { bbox: task.bbox }])(
    '当前北京时间在区域 $bbox 经过模型语义回复，真实时间仅保存在本地',
    async ({ bbox }) => {
      const { ports, state } = memoryPorts();
      const bodies: string[] = [];
      await executeAgent(
        { task: { ...task, goal: '当前北京时间', bbox }, results: [], steps: [] },
        ports,
        {
          apiKey: 'synthetic-test-key',
          now: () => new Date('2026-10-11T18:23:45Z'),
          fetch: async (_url, init) => {
            bodies.push(String(init?.body));
            return sse({ role: 'assistant', content: '北京时间为 CURRENT_TIME。' }, 'stop');
          },
        },
      );
      expect(state.status).toBe('completed');
      expect(state.summary).toContain('2026-10-12 02:23:45');
      expect(state.summary).not.toContain('CURRENT_TIME');
      expect(state.steps.get('clock_snapshot')).toEqual({
        instant: '2026-10-11T18:23:45.000Z',
        timeZone: 'Asia/Shanghai',
        status: 'available',
      });
      expect(state.queries).toBe(0);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).not.toContain('2026-10');
    },
  );
  it.each(['北京时间是 2020 年。', 'CURRENT_TIME CURRENT_TIME', '时间为 CURRENT_TIME_UTC'])(
    '时间回复缺少唯一占位符时失败：%s',
    async (content) => {
      const { ports, state } = memoryPorts();
      await executeAgent(
        { task: { ...task, goal: '现在几点', bbox: null }, results: [], steps: [] },
        ports,
        {
          apiKey: 'synthetic-test-key',
          fetch: async () => sse({ role: 'assistant', content }, 'stop'),
        },
      );
      expect(state.status).toBe('failed');
      expect(state.summary).toBe('');
      expect(state.error).toContain('时间');
    },
  );
  it.each([
    '**当前北京时间为 CURRENT_TIME。**',
    '北京时间：`CURRENT_TIME`。',
    '时间为二零二零年，当前为 CURRENT_TIME',
    '当前北京时间为 CURRENT_TIME，今天是星期一。',
    '当前北京时间为 CURRENT_TIME，今天日期为二 零二六 年。',
    '当前北京时间为 CURRENT_TIME，今天是２０２６年。',
  ])('完整模型措辞经平台规范呈现，所有额外断言丢弃：%s', async (content) => {
    const { ports, state } = memoryPorts();
    await executeAgent(
      { task: { ...task, goal: '现在几点', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        now: () => new Date('2026-10-11T18:23:45Z'),
        fetch: async () => sse({ role: 'assistant', content }, 'stop'),
      },
    );
    expect(state.status).toBe('completed');
    expect(state.summary).toBe('当前北京时间为 2026-10-12 02:23:45（Asia/Shanghai，UTC+08:00）。');
    expect(state.error).toBe('');
  });
  it('普通对话 provider 失败如实落盘，错误原文不进入可见信息', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent(
      { task: { ...task, goal: '你好', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () => new Response('private provider error', { status: 400 }),
      },
    );
    expect(state.status).toBe('failed');
    expect(state.summary).toBe('');
    expect(state.error).not.toContain('private');
  });
  it('普通对话预算耗尽不会发请求或假完成', async () => {
    const { ports, state } = memoryPorts();
    let requests = 0;
    await executeAgent(
      { task: { ...task, goal: '你能做什么', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        maxModelCalls: 0,
        fetch: async () => {
          requests++;
          throw new Error('must not call');
        },
      },
    );
    expect(requests).toBe(0);
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('budget_exhausted');
    expect(state.error).toContain('预算');
  });
  it('普通对话取消后拒绝迟到回复，且不写成功状态', async () => {
    const { ports, state } = memoryPorts();
    const controller = new AbortController();
    await executeAgent(
      { task: { ...task, goal: '你好', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        signal: controller.signal,
        fetch: async () => {
          controller.abort();
          return sse({ role: 'assistant', content: '迟到回复' }, 'stop');
        },
      },
    );
    expect(state.status).toBe('');
    expect(state.summary).toBe('');
  });
  it('普通对话服务端错误仅重试三次，每次消耗预算且不外发错误原文', async () => {
    const { ports, state } = memoryPorts();
    const bodies: string[] = [];
    await executeAgent(
      { task: { ...task, goal: '你好', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          return new Response('private 413123456 provider error', { status: 503 });
        },
      },
    );
    expect(bodies).toHaveLength(3);
    expect(state.modelCalls).toBe(3);
    expect(state.status).toBe('failed');
    expect(bodies.every((body) => !body.includes('private'))).toBe(true);
    expect(state.error).not.toContain('413123456');
  });
  it('普通对话超时释放任务且保留如实失败信息', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent(
      { task: { ...task, goal: '你好', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        runtimeTimeoutMs: 30,
        fetch: async (_url, init) =>
          new Promise<Response>((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            }),
          ),
      },
    );
    expect(state.status).toBe('failed');
    expect(state.error).toContain('超时');
  });
  it('时间任务恢复后重新取得回复时钟，不将旧快照或分析证据发给模型', async () => {
    const { ports, state } = memoryPorts();
    const bodies: string[] = [];
    await executeAgent(
      {
        task: { ...task, goal: '现在几点', bbox: null, modelCalls: 1 },
        results: [],
        steps: [
          {
            key: 'clock_snapshot',
            name: '平台时间快照',
            input: null,
            createdAt: task.to,
            output: {
              instant: '2020-01-01T00:00:00Z',
              timeZone: 'Asia/Shanghai',
              status: 'available',
              private: '413123456',
            },
          },
        ],
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        now: () => new Date('2026-10-12T01:02:03Z'),
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          return sse({ role: 'assistant', content: '当前北京时间为 CURRENT_TIME。' }, 'stop');
        },
      },
    );
    expect(state.status).toBe('completed');
    expect(state.summary).toContain('2026-10-12 09:02:03');
    expect(state.steps.get('clock_snapshot')).toEqual({
      instant: '2026-10-12T01:02:03.000Z',
      timeZone: 'Asia/Shanghai',
      status: 'available',
    });
    expect(bodies[0]).not.toContain('2020-01-01');
    expect(bodies[0]).not.toContain('413123456');
    expect(state.queries).toBe(0);
  });
  it('时间快照保存失去租约时不提交成功回复', async () => {
    const { ports, state } = memoryPorts();
    ports.saveStep = async () => false;
    await executeAgent(
      { task: { ...task, goal: '现在几点', bbox: null }, results: [], steps: [] },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () => sse({ role: 'assistant', content: '北京时间为 CURRENT_TIME。' }, 'stop'),
      },
    );
    expect(state.status).toBe('');
    expect(state.summary).toBe('');
  });
  it('多轮受控工具调用完成空结果研判，每个 HTTP body 都不包含原始内容', async () => {
    const { ports, state } = memoryPorts();
    const bodies: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      bodies.push(String(init?.body));
      if (bodies.length === 1)
        return sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: {
                  name: 'create_task',
                  arguments: '{"algorithm":"area-low-speed-notice"}',
                },
              },
              {
                index: 1,
                id: 'c2',
                type: 'function',
                function: { name: 'run_analysis', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        );
      return sse(
        {
          role: 'assistant',
          content: '观测事实：没有匹配结果。规则匹配：无。推测与限制：数据覆盖不足，无法确定原因。',
        },
        'stop',
      );
    };
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      fetch: fetcher,
    });
    expect(state.status).toBe('completed');
    expect(state.queries).toBe(1);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      const payload = JSON.parse(body);
      expect(Array.isArray(payload.tools) || payload.tools === undefined).toBe(true);
      expect(
        (payload.tools ?? []).every(
          (tool: { type: string; function: { parameters: { type: string } } }) =>
            tool.type === 'function' && tool.function.parameters.type === 'object',
        ),
      ).toBe(true);
    }
    expect(
      JSON.parse(bodies[0]!).tools.map((t: { function: { name: string } }) => t.function.name),
    ).toEqual(['list_algorithms', 'region_overview', 'related_notices', 'request_input']);
    for (const body of bodies)
      for (const secret of [
        '413123456',
        '秘密名称',
        '121.5',
        '31.2',
        'api_key=secret',
        'local-task',
        '2026-10-10',
      ])
        expect(body).not.toContain(secret);
    expect(bodies[1]).toContain('no_ais');
  });
  it('缺少区域只在本地补问，不调用模型', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent({ task: { ...task, bbox: null }, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      fetch: async () => {
        throw new Error('must not call');
      },
    });
    expect(state.status).toBe('awaiting_input');
    expect(state.modelCalls).toBe(0);
  });
  it('达到模型预算保存进度且不执行额外请求', async () => {
    const { ports, state } = memoryPorts();
    let calls = 0;
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      maxModelCalls: 1,
      fetch: async () => {
        calls++;
        return sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'list_algorithms', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        );
      },
    });
    expect(calls).toBe(1);
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('budget_exhausted');
  });
  it('取消或失去租约后停止所有计算及模型请求', async () => {
    const { ports, state } = memoryPorts();
    ports.active = async () => false;
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      fetch: async () => {
        throw new Error('must not call');
      },
    });
    expect(state.queries).toBe(0);
    expect(state.status).toBe('');
  });
  it('港口证据追问继承原算法与结果，且不重新查询数据', async () => {
    const { ports, state } = memoryPorts();
    const bodies: string[] = [];
    await executeAgent(
      {
        task: { ...task, goal: '解释上次的证据' },
        results: [],
        steps: [],
        previous: {
          task: { ...task, definitionId: 'port-restriction', resultVersion: 1 },
          results: [],
          steps: [],
        },
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async (_url, init) => {
          bodies.push(String(init?.body));
          return sse(
            {
              role: 'assistant',
              content: '观测事实：上次没有匹配结果。规则匹配：无。推测与限制：无法确定原因。',
            },
            'stop',
          );
        },
      },
    );
    expect(state.status).toBe('completed');
    expect(state.queries).toBe(0);
    expect(bodies[0]).toContain('explain_evidence');
    expect(bodies[0]).toContain('port-restriction');
  });
  it('429 重试有界，逐次计入持久模型预算，错误原文不入历史', async () => {
    const { ports, state } = memoryPorts();
    const bodies: string[] = [];
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      maxModelCalls: 2,
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        return new Response('raw private provider error', { status: 429 });
      },
    });
    expect(bodies).toHaveLength(2);
    expect(bodies.every((b) => !b.includes('private provider error'))).toBe(true);
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('budget_exhausted');
  });
  it('内部超时落入失败状态，释放任务而不冒充租约失效', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      runtimeTimeoutMs: 30,
      fetch: async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          }),
        ),
    });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('超时');
  });
  it('租约恢复复用已保存结果，不重新查询或计算', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent(
      {
        task: { ...task, resultVersion: 1, definitionId: 'area-low-speed-notice' },
        results: [],
        steps: [],
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          sse(
            {
              role: 'assistant',
              content: '观测事实：未发现匹配结果。规则匹配：无。推测与限制：无法判断原因。',
            },
            'stop',
          ),
      },
    );
    expect(state.status).toBe('completed');
    expect(state.queries).toBe(0);
  });
  it('新低速分析附带总结要求优先于旧港口追问上下文', async () => {
    const { ports, state } = memoryPorts();
    let calls = 0;
    await executeAgent(
      {
        task: { ...task, goal: '分析低速活动并总结证据' },
        results: [],
        steps: [],
        previous: {
          task: { ...task, definitionId: 'port-restriction', resultVersion: 1 },
          results: [],
          steps: [],
        },
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          ++calls === 1
            ? sse(
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c1',
                      type: 'function',
                      function: {
                        name: 'create_task',
                        arguments: '{"algorithm":"area-low-speed-notice"}',
                      },
                    },
                    {
                      index: 1,
                      id: 'c2',
                      type: 'function',
                      function: { name: 'run_analysis', arguments: '{}' },
                    },
                  ],
                },
                'tool_calls',
              )
            : sse(
                {
                  role: 'assistant',
                  content: '观测事实：无匹配。规则匹配：无。推测与限制：无法确定原因。',
                },
                'stop',
              ),
      },
    );
    expect(state.reuseCalls).toBe(0);
    expect(state.queries).toBe(1);
    expect(state.definitions).toEqual(['area-low-speed-notice']);
    expect(state.status).toBe('completed');
  });
  it('模型选择的算法与明确意图不符时不会运行错误算法', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      maxModelCalls: 1,
      fetch: async () =>
        sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'create_task', arguments: '{"algorithm":"port-restriction"}' },
              },
              {
                index: 1,
                id: 'c2',
                type: 'function',
                function: { name: 'run_analysis', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
    });
    expect(state.definitions).toEqual([]);
    expect(state.queries).toBe(0);
    expect(state.version).toBe(0);
    expect(state.status).toBe('failed');
    expect(state.errorCode).toBe('budget_exhausted');
  });
  it('输入快照保存后崩溃可重建公告概况，不再查询数据', async () => {
    const { ports, state } = memoryPorts();
    let calls = 0;
    await executeAgent(
      {
        task: { ...task, definitionId: 'area-low-speed-notice' },
        results: [],
        steps: [
          {
            key: 'input_snapshot',
            name: 'snapshot',
            input: null,
            createdAt: task.to,
            output: { from: task.from, to: task.to, queriedAt: task.to, ais: [], intelligence: [] },
          },
        ],
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          ++calls === 1
            ? sse(
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c1',
                      type: 'function',
                      function: { name: 'related_notices', arguments: '{}' },
                    },
                    {
                      index: 1,
                      id: 'c2',
                      type: 'function',
                      function: { name: 'run_analysis', arguments: '{}' },
                    },
                  ],
                },
                'tool_calls',
              )
            : sse(
                {
                  role: 'assistant',
                  content: '观测事实：无匹配。规则匹配：无。推测与限制：无法确定原因。',
                },
                'stop',
              ),
      },
    );
    expect(state.queries).toBe(0);
    expect(state.steps.get('overview')).toEqual({
      observations: 0,
      vessels: 0,
      notices: 0,
      coverage: 'no_ais',
    });
    expect(state.status).toBe('completed');
  });
  it('挂起查询超过整体时限时立即失败，迟到查询不保存快照', async () => {
    const { ports, state } = memoryPorts();
    let resolveQuery!: (dataset: TopicDataset) => void;
    ports.query = async () =>
      new Promise<TopicDataset>((resolve) => {
        resolveQuery = resolve;
      });
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      runtimeTimeoutMs: 40,
      fetch: async () =>
        sse(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'c1',
                type: 'function',
                function: { name: 'region_overview', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
    });
    expect(state.status).toBe('failed');
    expect(state.error).toContain('超时');
    resolveQuery({ from: task.from, to: task.to, queriedAt: task.to, ais: [], intelligence: [] });
    await Promise.resolve();
    expect(state.steps.has('input_snapshot')).toBe(false);
  });
  it('仅依据实际HTTP声明的阶段工具完成任务，不重复发现阶段', async () => {
    const { ports, state } = memoryPorts();
    const batches: string[][] = [];
    await executeAgent({ task, results: [], steps: [] }, ports, {
      apiKey: 'synthetic-test-key',
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        const names = (payload.tools ?? [])
          .map((t: { function: { name: string } }) => t.function.name)
          .filter((name: string) => name !== 'request_input');
        batches.push(names);
        return names.length
          ? sse(
              {
                role: 'assistant',
                tool_calls: names.map((name: string, index: number) => ({
                  index,
                  id: `call-${batches.length}-${index}`,
                  type: 'function',
                  function: {
                    name,
                    arguments:
                      name === 'create_task' ? '{"algorithm":"area-low-speed-notice"}' : '{}',
                  },
                })),
              },
              'tool_calls',
            )
          : sse(
              {
                role: 'assistant',
                content: '观测事实：无匹配结果。规则匹配：无。推测与限制：数据覆盖不足。',
              },
              'stop',
            );
      },
    });
    expect(state.status).toBe('completed');
    expect(batches).toEqual([
      ['list_algorithms', 'region_overview', 'related_notices'],
      ['create_task', 'run_analysis'],
      ['read_results', 'read_evidence'],
      [],
    ]);
    expect(state.queries).toBe(1);
  });
  it('缺区补问后确认区域沿用明确目标，开始计算而不再次补问', async () => {
    const { ports, state } = memoryPorts();
    let calls = 0;
    await executeAgent(
      {
        task: { ...task, goal: '已确认区域，请执行' },
        results: [],
        steps: [],
        previous: {
          task: { ...task, status: 'awaiting_input', bbox: null, goal: '分析低速活动与公告关联' },
          results: [],
          steps: [],
        },
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          ++calls === 1
            ? sse(
                {
                  role: 'assistant',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'c1',
                      type: 'function',
                      function: {
                        name: 'create_task',
                        arguments: '{"algorithm":"area-low-speed-notice"}',
                      },
                    },
                    {
                      index: 1,
                      id: 'c2',
                      type: 'function',
                      function: { name: 'run_analysis', arguments: '{}' },
                    },
                  ],
                },
                'tool_calls',
              )
            : sse(
                {
                  role: 'assistant',
                  content: '观测事实：无匹配结果。规则匹配：无。推测与限制：数据覆盖不足。',
                },
                'stop',
              ),
      },
    );
    expect(state.status).toBe('completed');
    expect(state.reuseCalls).toBe(0);
    expect(state.queries).toBe(1);
  });
  it('纯追问伴随选区变化时明确补问，不悄悄回到旧范围', async () => {
    const { ports, state } = memoryPorts();
    await executeAgent(
      {
        task: { ...task, goal: '解释上次证据', bbox: [100, 10, 101, 11] },
        results: [],
        steps: [],
        previous: {
          task: { ...task, definitionId: 'port-restriction', resultVersion: 1 },
          results: [],
          steps: [],
        },
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () => {
          throw new Error('must not call');
        },
      },
    );
    expect(state.status).toBe('awaiting_input');
    expect(state.summary).toContain('选区');
    expect(state.reuseCalls).toBe(1);
    expect(state.steps.get('requested_scope')).toEqual({
      bbox: [100, 10, 101, 11],
      historyHours: 24,
    });
  });
  it('解释上次低速分析的证据只复用旧结果，不把名词分析当成重算指令', async () => {
    const { ports, state } = memoryPorts();
    ports.reusePrevious = async () => {
      state.reuseCalls++;
      return { ...task, definitionId: 'area-low-speed-notice', resultVersion: 1 };
    };
    await executeAgent(
      {
        task: { ...task, goal: '解释上次低速分析的证据' },
        results: [],
        steps: [],
        previous: {
          task: { ...task, definitionId: 'area-low-speed-notice', resultVersion: 1 },
          results: [],
          steps: [],
        },
      },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          sse(
            {
              role: 'assistant',
              content: '观测事实：上次没有匹配结果。规则匹配：无。解释与局限：无法确定原因。',
            },
            'stop',
          ),
      },
    );
    expect(state.status).toBe('completed');
    expect(state.reuseCalls).toBe(1);
    expect(state.queries).toBe(0);
  });
  it('补问任务保留原结果后，恢复原区域可以直接解释父任务证据', async () => {
    const { ports, state } = memoryPorts();
    const previous = {
      task: {
        ...task,
        id: 'clarification-task',
        status: 'awaiting_input' as const,
        goal: '解释上次结果',
        definitionId: 'port-restriction' as const,
        resultVersion: 1,
      },
      results: [],
      steps: [],
    };
    await executeAgent(
      { task: { ...task, goal: '解释上次结果' }, results: [], steps: [], previous },
      ports,
      {
        apiKey: 'synthetic-test-key',
        fetch: async () =>
          sse(
            {
              role: 'assistant',
              content: '观测事实：原区域未匹配结果。规则匹配：无。解释与局限：无法确定原因。',
            },
            'stop',
          ),
      },
    );
    expect(state.status).toBe('completed');
    expect(state.reuseCalls).toBe(1);
    expect(state.queries).toBe(0);
  });
});

it('provider transport disables redirects even when the serializer asks to follow them', async () => {
  const { ports } = memoryPorts();
  let redirected: 'error' | 'follow' | 'manual' | undefined;
  const transport = guardedFetch(
    ports,
    {
      apiKey: 'test',
      fetch: async (_url, init) => {
        redirected = init?.redirect;
        return new Response(null, {
          status: 302,
          headers: { location: 'https://untrusted.example' },
        });
      },
    },
    new AbortController().signal,
  );
  await transport('https://api.deepseek.com/chat/completions', { redirect: 'follow' });
  expect(redirected).toBe('error');
});
