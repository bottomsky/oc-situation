import { describe, expect, it } from 'vitest';
import { executeAgent } from './runtime';
import { memoryPorts, task, sse } from './runtime.test';
import {
  projectIntelligence,
  projectIntelligenceWindow,
  sanitizeIntelligenceSummary,
} from './intelligence-runtime';
import type {
  AgentIntelligenceResult,
  IntelligenceSourceHealth,
  IntelligenceSearchItem,
} from '../../packages/contracts/intelligence-search';
const health: IntelligenceSourceHealth[] = [
  {
    sourceId: 'public',
    name: 'Public',
    visibility: 'public',
    enabled: true,
    status: 'ready',
    lastPolledAt: null,
    lastSuccessfulAt: null,
    nextPollAt: null,
    lastError: null,
  },
];
const event = {
  id: 'document-id',
  sourceId: 'public',
  sourceName: 'source real name',
  externalId: 'external-id',
  version: 1,
  title: '公开通告 413123456 121.5',
  summary: '公开海事通告 413123456 121.5 2026-10-13T02:00:00Z https://private.example/secret',
  snippet: '',
  category: 'notice',
  status: 'active',
  reviewStatus: 'candidate',
  visibility: 'public',
  publishedAt: null,
  observedAt: task.to,
  effectiveFrom: null,
  effectiveTo: null,
  collectedAt: task.to,
  timeBasis: 'index-observation',
  originalUrl: 'https://example.com',
  originalArchiveId: null,
  geometry: null,
  matchBasis: 'keyword',
  locationNote: 'not geolocated',
} as IntelligenceSearchItem;
const snapshot: AgentIntelligenceResult = {
  kind: 'intelligence_search',
  version: 1,
  inputRevision: 0,
  asOf: task.to,
  spec: { kind: 'events' },
  total: 2,
  truncated: false,
  evidence: [
    { kind: 'event', reference: 'I1', event },
    {
      kind: 'event',
      reference: 'I2',
      event: {
        ...event,
        id: 'private-id',
        sourceId: 'private',
        visibility: 'internal',
        summary: 'PRIVATE SECRET',
      },
    },
  ],
  sourceHealth: health,
  coverageNotes: ['LOCAL ONLY NOTE'],
};
function setup(result = snapshot) {
  const { ports, state } = memoryPorts();
  let searches = 0;
  ports.searchIntelligence = async () => {
    searches++;
    return result;
  };
  ports.saveIntelligenceResult = async () => 1;
  ports.intelligenceSourceHealth = async () => health;
  const context = {
    task: {
      ...task,
      goal: '找新闻 USER SECRET 413123456',
      intent: 'intelligence_search' as const,
      selection: {
        purpose: 'intelligence_search' as const,
        intelligenceQuery: { kind: 'events' as const },
      },
      inputRevision: 0,
    },
    results: [],
    steps: [],
  };
  return { ports, state, context, searches: () => searches };
}
function toolReply(name: string, args: Record<string, string> = {}) {
  return sse(
    {
      tool_calls: [
        {
          index: 0,
          id: 'tool-' + name,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    'tool_calls',
  );
}
function intelligenceFlow(content: string, reference = 'I1', name = 'read_intelligence') {
  let calls = 0;
  return async () =>
    ++calls === 1
      ? toolReply('search_intelligence')
      : calls === 2
        ? toolReply(name, { reference })
        : sse({ content }, 'stop');
}
describe('frozen intelligence tools and privacy gate', () => {
  it('pauses unsupported-port marine requests without searching or calling a model, then resumes the same task with a selected point', async () => {
    const m = setup({ ...snapshot, evidence: [], total: 0 });
    const context = {
      ...m.context,
      task: {
        ...m.context.task,
        goal: '明天香港港海况',
        selection: {
          purpose: 'intelligence_search' as const,
          intelligenceQuery: { kind: 'marine' as const, keyword: '香港港' },
        },
      },
    };
    const requests: unknown[] = [];
    m.ports.requestInput = async (spec) => {
      requests.push(spec);
      return true;
    };
    await executeAgent(context, m.ports, {
      apiKey: 'test',
      fetch: async () => {
        throw new Error('must not reach provider');
      },
    });
    expect(requests).toEqual([{ fields: ['topic'], reason: 'missing_topic' }]);
    expect(m.searches()).toBe(0);
    expect(m.state.modelCalls).toBe(0);
    expect(m.state.status).toBe('');
    await executeAgent(
      {
        ...context,
        task: {
          ...context.task,
          inputRevision: 1,
          selection: {
            ...context.task.selection,
            intelligenceQuery: {
              ...context.task.selection.intelligenceQuery,
              samplePointId: 'east-china-sea',
            },
          },
        },
      },
      m.ports,
      { apiKey: 'test' },
    );
    expect(m.searches()).toBe(1);
    expect(m.state.status).toBe('completed');
  });
  it('explains the representative-point coverage limit in legacy input prompts', async () => {
    const m = setup();
    await executeAgent(
      {
        ...m.context,
        task: {
          ...m.context.task,
          selection: { purpose: 'intelligence_search', intelligenceQuery: { kind: 'marine' } },
        },
      },
      m.ports,
      { apiKey: 'test' },
    );
    expect(m.state.status).toBe('awaiting_input');
    expect(m.state.summary).toContain('仅覆盖六个代表点');
    expect(m.state.summary).toContain('不能替代港口海况');
    expect(m.searches()).toBe(0);
  });
  it('projects UTC query windows as explicitly labelled Beijing dates across midnight', () => {
    expect(projectIntelligenceWindow('2026-10-13T16:00:00Z', '2026-10-14T16:00:00Z')).toEqual({
      from: '2026-10-14 00:00',
      to: '2026-10-15 00:00',
      timeZone: 'Asia/Shanghai',
    });
    expect(projectIntelligenceWindow('2026-12-31T23:30:00Z', '2027-01-01T00:00:00Z')).toEqual({
      from: '2027-01-01 07:30',
      to: '2027-01-01 08:00',
      timeZone: 'Asia/Shanghai',
    });
  });
  it('anonymizes quoted and explicitly labelled vessel names without erasing source facts', () => {
    const safe = sanitizeIntelligenceSummary(
      '中国海事局：拖轮“华达X”与“HUA DA 12”轮拖带“天龙座”船，长宁洲轮作业。公告称开展拖航作业。',
    );
    for (const name of ['华达', 'HUA DA', '天龙座', '长宁洲']) expect(safe).not.toContain(name);
    expect(safe).toContain('中国海事局');
    expect(safe).toContain('公告称开展拖航作业');
  });
  it('anonymizes unquoted English prefixes and concatenated Chinese vessel names from notice formats', () => {
    const english = sanitizeIntelligenceSummary(
      'EAST CHINA SEA M/V HUA DA 618 SEA TRIAL IN AREA. ZHEJIANG MSA CHINA.',
    );
    const brokenQuote = sanitizeIntelligenceSummary('M/V “OCEAN STAR 22 SEA TRIAL IN AREA.');
    const chinese = sanitizeIntelligenceSummary(
      '10月13日1245时至15日1400时由长宁洲轮和驭能蛟龙轮在29-58.51N 121-55.72E从天龙座轮过驳。希各航船注意。',
    );
    const otherNames = sanitizeIntelligenceSummary('由“海上晨光轮与远洋先锋轮拖带施工平台。');
    for (const name of [
      'HUA DA',
      'OCEAN STAR',
      '长宁洲',
      '驭能蛟龙',
      '天龙座',
      '海上晨光',
      '远洋先锋',
    ])
      expect([english, brokenQuote, chinese, otherNames].join('')).not.toContain(name);
    expect(english).toContain('SEA TRIAL');
    expect(english).toContain('ZHEJIANG MSA CHINA');
    expect(sanitizeIntelligenceSummary('HUA DA 618 SEA TRIAL—ZJ376/26')).toContain(
      '[船舶标识已省略] SEA TRIAL',
    );
    expect(sanitizeIntelligenceSummary('OCEAN STAR SEA TRIAL')).not.toContain('OCEAN STAR');
    expect(chinese).toContain('过驳');
    expect(otherNames).toContain('拖带施工平台');
  });
  it('locally routes evidence followups to source basis and transmits only fixed query semantics', async () => {
    const m = setup();
    const payloads: string[] = [];
    const flow = intelligenceFlow('来源称这是候选通告，索引观测时间不等于事件发生时间 [I1]。');
    await executeAgent(
      {
        ...m.context,
        task: {
          ...m.context.task,
          goal: '这条公告依据是什么 PRIVATE QUESTION',
          intent: 'explain',
          selection: {},
        },
        previous: { ...m.context, intelligenceResult: snapshot },
      },
      m.ports,
      {
        apiKey: 'test',
        fetch: async (_url, init) => {
          payloads.push(String(init?.body));
          return flow();
        },
      },
    );
    expect(m.state.status).toBe('completed');
    const body = JSON.parse(payloads.at(-1)!);
    const prompt = JSON.parse(
      body.messages.find((message: { role: string }) => message.role === 'user').content,
    );
    expect(prompt).toMatchObject({
      replyMode: 'source_basis',
      queryKind: 'events',
      category: null,
    });
    expect(prompt.publicEvidence[0]).toMatchObject({
      sourceName: 'source real name',
      timeBasis: 'index-observation',
      recordStatus: 'active',
    });
    expect(payloads.join('')).not.toContain('PRIVATE QUESTION');
  });
  it('repairs unsupported candidate navigation advice and event answers demanding marine evidence', async () => {
    const m = setup();
    let calls = 0;
    const bodies: string[] = [];
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async (_url, init) => {
        bodies.push(String(init?.body));
        calls++;
        if (calls === 1) return toolReply('search_intelligence');
        if (calls === 2) return toolReply('read_intelligence', { reference: 'I1' });
        if (calls === 3) return sse({ content: '来源称有候选公告，建议船舶避让 [I1]。' }, 'stop');
        if (calls === 4) return sse({ content: '候选线索 [I1]，没有海况无法回答。' }, 'stop');
        return sse(
          { content: '来源称存在公告线索，尚待审核，不能据此认定有效限制 [I1]。' },
          'stop',
        );
      },
    });
    expect(m.state.status).toBe('completed');
    expect(bodies[3]).toContain('do_not_infer_navigation_action_from_candidate');
    expect(bodies[4]).toContain('answer_event_topic_without_marine_requirement');
    expect(m.state.summary).not.toContain('建议船舶避让');
  });
  it('only projects public currently authorized evidence and bounded sanitized text', () => {
    const projection = JSON.stringify(projectIntelligence(snapshot, health));
    for (const secret of [
      'PRIVATE SECRET',
      'private-id',
      '121.5',
      '413123456',
      '2026-10-13',
      'document-id',
      'LOCAL ONLY',
    ])
      expect(projection).not.toContain(secret);
    expect(projectIntelligence(snapshot, [{ ...health[0]!, visibility: 'internal' }])).toEqual([]);
  });
  it('requires search then read, preserves source status in rebuilt prompts, and keeps transcripts private', async () => {
    const m = setup();
    const payloads: string[] = [];
    let calls = 0;
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async (_url, init) => {
        payloads.push(String(init?.body));
        calls++;
        if (calls === 1) return sse({ content: '尝试提前回答 [I1]。' }, 'stop');
        if (calls === 2) return toolReply('search_intelligence');
        if (calls === 3) return toolReply('get_intelligence_source_status');
        if (calls === 4) return toolReply('read_intelligence', { reference: 'I1' });
        return sse({ content: '候选线索：已检索到公开通告 [I1]。' }, 'stop');
      },
    });
    expect(m.state.status).toBe('completed');
    expect(m.searches()).toBe(1);
    expect(calls).toBe(5);
    expect(
      JSON.parse(payloads[0]!).tools.map(
        (item: { function: { name: string } }) => item.function.name,
      ),
    ).toEqual(['search_intelligence']);
    expect(JSON.parse(payloads[4]!).tools ?? []).toEqual([]);
    expect(m.state.summary).toContain('尚待审核');
    expect(m.state.summary).toContain('索引观测时间不等于事件发生时间');
    expect(payloads[4]).toContain('completedReadReferences');
    expect(payloads[4]).toContain('ready');
    const payload = JSON.parse(payloads[4]!);
    const prompt = JSON.parse(
      payload.messages.find((message: { role: string }) => message.role === 'user').content,
    );
    expect(prompt.completedReadReferences).toEqual(['I1']);
    expect(prompt.sourceStatuses).toEqual(['ready']);
    for (const p of payloads)
      for (const secret of [
        'USER SECRET',
        'PRIVATE SECRET',
        'private-id',
        '121.5',
        '413123456',
        '2026-10-13',
        'LOCAL ONLY',
      ])
        expect(p).not.toContain(secret);
  });
  it('does not call provider for private-only results', async () => {
    const m = setup({ ...snapshot, evidence: [snapshot.evidence[1]!], total: 1 });
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async () => {
        throw new Error('must not call');
      },
    });
    expect(m.state.status).toBe('completed');
    expect(m.state.modelCalls).toBe(0);
  });
  it('restores a current result and explains previous frozen evidence without searching', async () => {
    const m = setup();
    await executeAgent(
      {
        ...m.context,
        task: { ...m.context.task, intent: 'explain', selection: {} },
        previous: { ...m.context, intelligenceResult: snapshot },
      },
      m.ports,
      { apiKey: 'test', fetch: intelligenceFlow('候选线索：原结果为通告 [I1]。') },
    );
    expect(m.state.status).toBe('completed');
    expect(m.searches()).toBe(0);
  });
  it('rejects invented references', async () => {
    const m = setup();
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: intelligenceFlow('有事件 [I99]。'),
    });
    expect(m.state.status).toBe('failed');
    expect(m.state.errorCode).toBe('invalid_summary');
  });
  it('budget exhaustion saves evidence but fails explicitly', async () => {
    const m = setup();
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      maxModelCalls: 0,
      fetch: async () => {
        throw new Error('not reached');
      },
    });
    expect(m.state.status).toBe('failed');
    expect(m.state.errorCode).toBe('budget_exhausted');
    expect(m.searches()).toBe(1);
  });
  it('rechecks public visibility before HTTP retries and never resends revoked content', async () => {
    const m = setup();
    let visible = true;
    let sent = 0;
    m.ports.intelligenceSourceHealth = async () => [
      { ...health[0]!, visibility: visible ? 'public' : 'internal' },
    ];
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async () => {
        sent++;
        visible = false;
        return new Response('server private error', { status: 503 });
      },
    });
    expect(sent).toBe(1);
    expect(m.state.status).toBe('failed');
    expect(m.state.errorCode).toBe('configuration');
  });
  it('a changed input revision re-searches rather than restoring a stale snapshot', async () => {
    const m = setup();
    await executeAgent(
      {
        ...m.context,
        task: { ...m.context.task, inputRevision: 1, resultInputRevision: 0, resultVersion: 1 },
        intelligenceResult: snapshot,
      },
      m.ports,
      { apiKey: 'test', fetch: intelligenceFlow('候选线索：新查询通告 [I1]。') },
    );
    expect(m.searches()).toBe(1);
    expect(m.state.status).toBe('completed');
  });
  it('an invalid read never marks the reference completed and cannot pass the completion gate', async () => {
    const m = setup();
    const payloads: string[] = [];
    let calls = 0;
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      maxModelCalls: 4,
      fetch: async (_url, init) => {
        payloads.push(String(init?.body));
        calls++;
        return calls === 1
          ? toolReply('search_intelligence')
          : calls === 2
            ? toolReply('read_intelligence', { reference: 'I99' })
            : sse({ content: '不可跳过读取 [I1]。' }, 'stop');
      },
    });
    expect(m.state.status).toBe('failed');
    expect(m.state.errorCode).toBe('budget_exhausted');
    const body = JSON.parse(payloads[2]!);
    const data = JSON.parse(body.messages.find((m: { role: string }) => m.role === 'user').content);
    expect(data.completedReadReferences).toEqual([]);
    expect(data.completedTools).not.toContain('read_intelligence');
  });
  it('deterministically marks mention-only location and representative-point forecast', async () => {
    const marine = {
      kind: 'marine' as const,
      reference: 'I3',
      forecast: {
        id: 'forecast',
        sourceId: 'public',
        samplePointId: 'bohai',
        pointName: '渤海',
        point: { lon: 120, lat: 39 },
        grid: { lon: 120, lat: 39 },
        fetchedAt: task.to,
        modelPublishedAt: null,
        validFrom: task.from,
        validTo: task.to,
        series: [{ validAt: task.from, waveHeight: 2, waveDirection: 90, wavePeriod: 5 }],
        originalArchiveId: 'archive',
        originalUrl: 'https://example.com',
        visibility: 'public' as const,
      },
    };
    const m = setup({
      ...snapshot,
      spec: { kind: 'both', forecastFrom: task.from, forecastTo: task.to },
      evidence: [
        { kind: 'event', reference: 'I1', event: { ...event, matchBasis: 'mention' } },
        marine,
      ],
    });
    const projection = projectIntelligence(
      {
        ...snapshot,
        spec: { kind: 'marine', forecastFrom: task.from, forecastTo: task.to },
        evidence: [marine],
      },
      health,
    );
    expect(projection[0]).toMatchObject({
      pointName: '渤海代表点',
      forecastWindow: projectIntelligenceWindow(task.from, task.to),
    });
    expect(JSON.stringify(projection)).not.toContain('"lon"');
    expect(JSON.stringify(projection)).not.toContain('"lat"');
    let calls = 0;
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async () => {
        calls++;
        return calls === 1
          ? toolReply('search_intelligence')
          : calls === 2
            ? toolReply('read_intelligence', { reference: 'I1' })
            : calls === 3
              ? toolReply('read_marine_forecast', { reference: 'I3' })
              : sse({ content: '候选线索：通告 [I1]，海况 [I3]。' }, 'stop');
      },
    });
    expect(m.state.status).toBe('completed');
    expect(m.state.summary).toContain('发生位置未知');
    expect(m.state.summary).toContain('代表点预报，不是全海域实测');
  });
  it('repairs an overlong answer using safe validation metadata without relaxing citation rules', async () => {
    const m = setup();
    let calls = 0;
    const payloads: string[] = [];
    await executeAgent(m.context, m.ports, {
      apiKey: 'test',
      fetch: async (_url, init) => {
        payloads.push(String(init?.body));
        calls++;
        return calls === 1
          ? toolReply('search_intelligence')
          : calls === 2
            ? toolReply('read_intelligence', { reference: 'I1' })
            : calls === 3
              ? sse({ content: '过长内容'.repeat(150) + ' [I1]' }, 'stop')
              : sse({ content: '候选线索：精简公开通告 [I1]。' }, 'stop');
      },
    });
    expect(m.state.status).toBe('completed');
    expect(calls).toBe(4);
    expect(payloads[3]).toContain('summary_over_500_chars');
    expect(payloads[3]).not.toContain('过长内容');
    expect(m.state.steps.get('intelligence_summary_validation:0')).toMatchObject({
      issue: 'summary_over_500_chars',
    });
  });
});
