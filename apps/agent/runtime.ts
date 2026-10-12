import { Agent, type AgentTool } from '@earendil-works/pi-agent-core';
import { Type, createModels, createInitialSystemMessage } from '@earendil-works/pi-ai';
import { deepseekProvider } from '@earendil-works/pi-ai/providers/deepseek';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { AgentTask, AgentStep } from '../../packages/contracts/agent';
import {
  AnalysisResultSchema,
  TopicConfigSchema,
  type AnalysisResult,
  type TopicDataset,
  type TopicDefinitionId,
  type TopicInstance,
} from '../../packages/contracts/topics';
import { analysisIdentity, evaluateTopic } from '../../packages/domain/topics';
import {
  classifyConversationIntent,
  type ConversationIntent,
} from '../../packages/domain/agent-conversation';
import {
  classifyRequest,
  classifyGoal,
  projectResults,
  safePrompt,
  SYSTEM_PROMPT,
  validateSummary,
} from './gateway';

export interface RuntimePorts {
  active(): Promise<boolean>;
  reserve(kind: 'model' | 'tool', maximum: number): Promise<boolean>;
  setDefinition(definition: TopicDefinitionId): Promise<boolean>;
  reusePrevious(taskId: string): Promise<AgentTask | null>;
  saveStep(key: string, name: string, output: unknown): Promise<boolean>;
  query(): Promise<TopicDataset>;
  saveResults(results: AnalysisResult[]): Promise<number | null>;
  finish(outcome: {
    status: 'completed' | 'failed' | 'awaiting_input';
    summary?: string;
    summaryResultVersion?: number;
    error?: string;
  }): Promise<boolean>;
}
export interface RuntimeOptions {
  apiKey: string;
  model?: string;
  maxModelCalls?: number;
  maxToolCalls?: number;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  runtimeTimeoutMs?: number;
  now?: () => Date;
}
export interface RuntimeContext {
  task: AgentTask;
  results: AnalysisResult[];
  steps: AgentStep[];
  previous?: RuntimeContext | null;
}

const overviewSchema = z.strictObject({
  observations: z.number().int().nonnegative(),
  vessels: z.number().int().nonnegative(),
  notices: z.number().int().nonnegative(),
  coverage: z.enum(['no_ais', 'no_notices', 'insufficient_observations', 'available']),
});
class RuntimeStop extends Error {
  constructor(
    readonly code:
      | 'fenced'
      | 'budget'
      | 'limit'
      | 'retention'
      | 'provider'
      | 'invalid_summary'
      | 'configuration'
      | 'timeout'
      | 'invalid_time'
      | 'invalid_conversation',
  ) {
    super(code);
  }
}
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new RuntimeStop('fenced'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
const algorithms = ['port-restriction', 'area-low-speed-notice'] as const;

/** The only transport boundary. Every retry is charged and only official DeepSeek is reachable. */
function guardedFetch(
  ports: RuntimePorts,
  options: RuntimeOptions,
  signal: AbortSignal,
): typeof fetch {
  const fetcher = options.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    if (url.origin !== 'https://api.deepseek.com') throw new RuntimeStop('configuration');
    for (let attempt = 0; attempt < 3; attempt++) {
      if (signal.aborted || !(await ports.active())) throw new RuntimeStop('fenced');
      if (!(await ports.reserve('model', options.maxModelCalls ?? 12)))
        throw new RuntimeStop('budget');
      const response = await fetcher(input, { ...init, signal });
      if (response.status !== 429 && response.status < 500) return response;
      if (attempt === 2) return response;
      await response.body?.cancel();
      await delay(250 * 2 ** attempt, undefined, { signal });
    }
    throw new RuntimeStop('provider');
  };
}

const CONVERSATION_PROMPT = `你是海上多元情报分析系统的中文助手。根据固定语义意图简短自然地回复。
greeting：礼貌问候，可以简要介绍系统。
capabilities：只介绍所列平台能力：港口限制船舶识别、区域低速活动与公告关联，以及已有结果和证据的解释。分析任务需要海图选区。
current_time：回复中必须出现且只出现一次独立的 CURRENT_TIME 语义标记。平台会读取服务器时钟，并规范呈现北京时间和时区。你只负责确认时间查询意图；具体时间、日期与星期由平台提供。
只输出助手回复文本，不调用工具，不声称已执行分析，不生成船舶或证据数据。`;

async function executeConversation(
  intent: ConversationIntent,
  ports: RuntimePorts,
  options: RuntimeOptions,
): Promise<void> {
  if (!options.apiKey) {
    await ports.finish({ status: 'failed', error: '智能体服务尚未配置模型密钥。' });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.runtimeTimeoutMs ?? 180_000);
  let stop: RuntimeStop | undefined;
  const checkActive = async () => {
    if (timedOut) throw new RuntimeStop('timeout');
    if (controller.signal.aborted || !(await ports.active())) throw new RuntimeStop('fenced');
  };
  try {
    await checkActive();
    const models = createModels();
    models.setProvider(deepseekProvider());
    const model = models.getModel('deepseek', options.model ?? 'deepseek-flash');
    if (!model) throw new RuntimeStop('configuration');
    const transport = guardedFetch(ports, options, controller.signal);
    const prompt = JSON.stringify({
      intent,
      capabilities: algorithms,
      ...(intent === 'current_time'
        ? { timeSource: 'platform_clock', placeholder: 'CURRENT_TIME' }
        : {}),
    });
    const agent = new Agent({
      initialState: { model, systemPrompt: CONVERSATION_PROMPT, tools: [], thinkingLevel: 'off' },
      streamFn: (currentModel, transcript, streamOptions) =>
        models.streamSimple(currentModel, transcript, {
          ...streamOptions,
          apiKey: options.apiKey,
          maxTokens: 500,
          maxRetries: 0,
          timeoutMs: 60_000,
          maxRetryDelayMs: 2000,
          fetch: async (input, init) => {
            try {
              return await transport(input, init);
            } catch (error) {
              stop = error instanceof RuntimeStop ? error : new RuntimeStop('provider');
              throw stop;
            }
          },
        }),
      // The request contains no original message, history, geographic data or analysis state.
      prepareRequest: async ({ context: current }) => ({
        context: {
          ...current,
          messages: [
            createInitialSystemMessage(CONVERSATION_PROMPT, [])!,
            { role: 'user', content: prompt, timestamp: 0 },
          ],
        },
      }),
      finishTurn: async () => ({ action: 'end' }),
    });
    controller.signal.addEventListener('abort', () => agent.abort(), { once: true });
    await abortable(agent.prompt(prompt), controller.signal);
    await checkActive();
    if (stop) throw stop;
    const final = [...agent.state.messages]
      .reverse()
      .find((message) => message.role === 'assistant');
    if (!final || final.role !== 'assistant' || final.stopReason !== 'stop')
      throw new RuntimeStop('provider');
    if (final.content.some((part) => part.type !== 'text'))
      throw new RuntimeStop('invalid_conversation');
    let summary = final.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
      .trim();
    if (!summary || summary.length > 2000) throw new RuntimeStop('invalid_conversation');
    if (intent === 'current_time') {
      if (
        (summary.match(/CURRENT_TIME/g) ?? []).length !== 1 ||
        !/(?<![A-Z0-9_])CURRENT_TIME(?![A-Z0-9_])/.test(summary)
      )
        throw new RuntimeStop('invalid_time');
      const now = (options.now ?? (() => new Date()))();
      if (!Number.isFinite(now.getTime())) throw new RuntimeStop('invalid_time');
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const time = `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}（Asia/Shanghai，UTC+08:00）`;
      if (
        !(await ports.saveStep('clock_snapshot', '平台时间快照', {
          instant: now.toISOString(),
          timeZone: 'Asia/Shanghai',
          status: 'available',
        }))
      )
        throw new RuntimeStop('fenced');
      // The model acknowledges the intent; only the platform renders clock facts.
      summary = `当前北京时间为 ${time}。`;
    }
    await checkActive();
    if (await ports.finish({ status: 'completed', summary, summaryResultVersion: 0 }))
      options.onTextDelta?.(summary);
  } catch (error) {
    const code = timedOut ? 'timeout' : error instanceof RuntimeStop ? error.code : 'provider';
    if (code === 'fenced') return;
    const message =
      code === 'budget'
        ? '本次对话已达到模型调用预算，请稍后在新消息中重试。'
        : code === 'timeout'
          ? '本次智能体对话超时，请稍后重试。'
          : code === 'configuration'
            ? '配置的 DeepSeek 模型不在已验证模型目录中。'
            : code === 'invalid_time'
              ? '模型时间回复未通过平台时间格式校验，请稍后重试。'
              : code === 'invalid_conversation'
                ? '模型回复格式无效，请稍后重试。'
                : '模型服务暂不可用，请稍后重试。';
    await ports.finish({
      status: code === 'budget' ? 'awaiting_input' : 'failed',
      error: message,
      ...(code === 'budget' ? { summary: message } : {}),
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function executeAgent(
  context: RuntimeContext,
  ports: RuntimePorts,
  options: RuntimeOptions,
): Promise<void> {
  let task = context.task;
  if (!(await ports.active())) return;
  const conversation = classifyConversationIntent(task.goal);
  if (conversation) {
    await executeConversation(conversation, ports, options);
    return;
  }
  const previousDefinition =
    context.previous?.task.definitionId ??
    (context.previous ? classifyGoal(context.previous.task.goal) : null);
  const continuation = [
    '已确认区域请执行',
    '已确认区域',
    '确认区域',
    '已选择区域请执行',
    '请执行',
    '开始',
    '继续',
    '继续分析',
  ].includes(task.goal.replace(/[，,。！!\s]/g, ''));
  const request =
    classifyRequest(task.goal, context.previous?.task.resultVersion ? previousDefinition : null) ??
    (context.previous?.task.status === 'awaiting_input' &&
    !context.previous.task.resultVersion &&
    previousDefinition &&
    continuation
      ? { action: 'analyze' as const, algorithm: previousDefinition }
      : null);
  if (request && request.action !== 'analyze' && context.previous && !task.resultVersion) {
    const scopeChanged =
      !isDeepStrictEqual(task.bbox, context.previous.task.bbox) ||
      task.historyHours !== context.previous.task.historyHours;
    const inherited = await ports.reusePrevious(context.previous.task.id);
    if (!inherited) {
      await ports.finish({
        status: 'awaiting_input',
        summary: '上次结果的可用状态已变化，请明确新的分析目标后重试。',
      });
      return;
    }
    if (scopeChanged) {
      if (
        !(await ports.saveStep('requested_scope', '追问请求范围', {
          bbox: task.bbox,
          historyHours: task.historyHours,
        }))
      )
        return;
      await ports.finish({
        status: 'awaiting_input',
        summary:
          '已保留上次结果及原分析范围。当前选区或分析时长已变化；请恢复原选区与时长继续解释，或明确分析目标按新选区重算。',
      });
      return;
    }
    task = inherited;
    context = {
      ...context,
      task,
      results: context.previous.results,
      steps: context.previous.steps.filter((s) => s.key === 'overview'),
    };
  }
  if (!task.bbox) {
    await ports.finish({
      status: 'awaiting_input',
      summary: '请先在海图选择分析区域，再描述希望研判的目标。',
    });
    return;
  }
  if (!request) {
    await ports.finish({
      status: 'awaiting_input',
      summary: '当前支持港口限制船舶识别、区域低速活动与公告关联。请说明需要分析哪一类情况。',
    });
    return;
  }
  const intent = request.algorithm;
  if (!options.apiKey) {
    await ports.finish({ status: 'failed', error: '智能体服务尚未配置模型密钥。' });
    return;
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.runtimeTimeoutMs ?? 180_000);
  const snapshot = overviewSchema.safeParse(
    context.steps.find((s) => s.key === 'overview')?.output,
  );
  let overview = snapshot.success ? snapshot.data : undefined;
  // Full input snapshot stays local; restore it on lease recovery before recomputing.
  let dataset = context.steps.find((s) => s.key === 'input_snapshot')?.output as
    TopicDataset | undefined;
  let results = context.results;
  let version = task.resultVersion;
  let definition = task.definitionId;
  let asked = false;
  let stop: RuntimeStop | undefined;
  const done = new Set(context.steps.filter((s) => s.key.startsWith('tool:')).map((s) => s.name));
  const toolStatuses: Record<string, string> = {};
  const checkActive = async () => {
    if (timedOut) throw new RuntimeStop('timeout');
    if (controller.signal.aborted || !(await ports.active())) throw new RuntimeStop('fenced');
  };
  const load = async () => {
    await checkActive();
    if (!dataset) {
      if (Date.parse(task.from) < Date.now() - 30 * 86400_000) throw new RuntimeStop('retention');
      try {
        dataset = await abortable(ports.query(), controller.signal);
        await checkActive();
      } catch (error) {
        if (
          error instanceof Error &&
          /exceeds explicit maximum|TOO_MANY|MEMORY_LIMIT_EXCEEDED|TOO_LARGE/.test(error.message)
        )
          throw new RuntimeStop('limit');
        throw error;
      }
      if (dataset.truncated) throw new RuntimeStop('limit');
      const serialized = JSON.stringify(dataset);
      if (Buffer.byteLength(serialized) > 32 * 1024 * 1024) throw new RuntimeStop('limit');
      if (!(await ports.saveStep('input_snapshot', '保存本地输入快照', dataset)))
        throw new RuntimeStop('fenced');
      if (
        !(await ports.saveStep('input_digest', '输入校验摘要', {
          sha256: createHash('sha256').update(serialized).digest('hex'),
        }))
      )
        throw new RuntimeStop('fenced');
    }
    if (!overview) {
      overview = {
        observations: dataset.ais.length,
        vessels: new Set(dataset.ais.map((p) => p.vesselId ?? p.mmsi)).size,
        notices: dataset.intelligence.length,
        coverage: !dataset.ais.length
          ? 'no_ais'
          : !dataset.intelligence.length
            ? 'no_notices'
            : dataset.ais.length < 3
              ? 'insufficient_observations'
              : 'available',
      };
      if (!(await ports.saveStep('overview', '区域数据概况', overview)))
        throw new RuntimeStop('fenced');
    }
    return dataset;
  };
  const tool = (
    name: string,
    description: string,
    execute: (args: Record<string, unknown>) => Promise<unknown>,
    parameters = Type.Object({}, { additionalProperties: false }),
  ): AgentTool => ({
    name,
    label: description,
    description,
    parameters,
    async execute(_id, args) {
      try {
        await checkActive();
        if (!(await ports.reserve('tool', options.maxToolCalls ?? 24)))
          throw new RuntimeStop('budget');
        const value = await execute(args as Record<string, unknown>);
        const status =
          value && typeof value === 'object' && 'status' in value ? value.status : undefined;
        const rejected = [
          'algorithm_must_match_request',
          'algorithm_already_bound',
          'choose_algorithm_first',
          'run_analysis_first',
        ].includes(String(status));
        if (rejected) toolStatuses[name] = String(status);
        else {
          delete toolStatuses[name];
          done.add(name);
          if (!(await ports.saveStep(`tool:${name}`, name, { completed: true })))
            throw new RuntimeStop('fenced');
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          details: undefined,
          ...(asked ? { terminate: true } : {}),
        };
      } catch (error) {
        stop = error instanceof RuntimeStop ? error : new RuntimeStop('provider');
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: stop.code }) }],
          details: undefined,
          terminate: true,
        };
      }
    },
  });
  const tools: AgentTool[] = [
    tool('list_algorithms', '查询可用算法', async () => ({ algorithms })),
    tool('region_overview', '区域数据概况', async () => {
      if (!overview) await load();
      return overview;
    }),
    tool('related_notices', '查询公告统计，原文留在平台', async () => {
      if (!overview) await load();
      return { count: overview!.notices, rawTextAvailableToModel: false };
    }),
    tool(
      'create_task',
      '确认当前一次性任务的算法',
      async (args) => {
        const selected = z.enum(algorithms).parse(args.algorithm);
        if (selected !== intent)
          return { status: 'algorithm_must_match_request', algorithm: intent };
        if (definition && definition !== selected)
          return { status: 'algorithm_already_bound', algorithm: definition };
        if (!(await ports.setDefinition(selected))) throw new RuntimeStop('fenced');
        definition = selected;
        return {
          status: 'bound',
          algorithm: selected,
          region: 'R1',
          parameters: { lowSpeedKnots: 3, minPositions: 3, windowMinutes: 60 },
        };
      },
      Type.Object(
        { algorithm: Type.Union(algorithms.map((id) => Type.Literal(id))) },
        { additionalProperties: false },
      ),
    ),
    tool('run_analysis', '运行本地算法；已有结果时复用', async () => {
      if (!definition) return { status: 'choose_algorithm_first' };
      if (!version) {
        const input = await load();
        const instance: TopicInstance = {
          id: task.id,
          definitionId: definition,
          name: '一次性分析',
          enabled: false,
          generation: task.generation,
          status: 'disabled',
          checkpoint: null,
          lastRunAt: null,
          lastError: null,
          createdAt: task.createdAt,
          config: TopicConfigSchema.parse({ bbox: task.bbox, historyHours: task.historyHours }),
        };
        const evaluated = evaluateTopic(instance, input).map((r) => AnalysisResultSchema.parse(r));
        const positions = new Map(input.ais.map((p) => [p.recordId, p]));
        const documents = new Map(input.intelligence.map((d) => [d.id, d]));
        for (const result of evaluated) {
          const document = documents.get(result.documentId);
          if (
            !document ||
            result.id !== analysisIdentity(instance, document, result.vesselId ?? result.mmsi) ||
            !result.evidence.ais.every((p) => isDeepStrictEqual(positions.get(p.recordId), p)) ||
            !result.evidence.documents.every((d) => isDeepStrictEqual(documents.get(d.id), d))
          )
            throw new Error('evidence_mismatch');
        }
        // Persistence performs the fence and retains late computation in audit.
        const persisted = await ports.saveResults(evaluated);
        if (persisted === null) throw new RuntimeStop('fenced');
        results = evaluated;
        version = persisted;
      }
      return {
        status: 'ready',
        ...projectResults(results, version),
        coverage: overview?.coverage ?? 'available',
      };
    }),
    tool('read_results', '读取算法结果版本与摘要', async () =>
      version ? projectResults(results, version) : { status: 'run_analysis_first' },
    ),
    tool('read_evidence', '读取去标识证据摘要', async () =>
      version ? projectResults(results, version) : { status: 'run_analysis_first' },
    ),
    tool('ask_user', '请用户补充任务目标', async () => {
      asked = true;
      return { status: 'awaiting_input' };
    }),
  ];
  const models = createModels();
  models.setProvider(deepseekProvider());
  const model = models.getModel('deepseek', options.model ?? 'deepseek-flash');
  if (!model) {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
    await ports.finish({ status: 'failed', error: '配置的 DeepSeek 模型不在已验证模型目录中。' });
    return;
  }
  const transport = guardedFetch(ports, options, controller.signal);
  const currentTools = () => {
    const stage =
      version > 0
        ? ['read_results', 'read_evidence']
        : definition
          ? ['run_analysis']
          : ['list_algorithms', 'region_overview', 'related_notices'].every((name) =>
                done.has(name),
              )
            ? ['create_task', 'run_analysis']
            : ['list_algorithms', 'region_overview', 'related_notices'];
    if (version > 0 && stage.every((name) => done.has(name))) return [];
    return tools.filter(
      (item) => item.name === 'ask_user' || (stage.includes(item.name) && !done.has(item.name)),
    );
  };
  const agent = new Agent({
    initialState: { model, systemPrompt: SYSTEM_PROMPT, tools, thinkingLevel: 'off' },
    toolExecution: 'sequential',
    streamFn: (currentModel, transcript, streamOptions) =>
      models.streamSimple(currentModel, transcript, {
        ...streamOptions,
        apiKey: options.apiKey,
        maxTokens: 1500,
        maxRetries: 0,
        timeoutMs: 60_000,
        maxRetryDelayMs: 2000,
        fetch: async (input, init) => {
          try {
            return await transport(input, init);
          } catch (error) {
            stop = error instanceof RuntimeStop ? error : new RuntimeStop('provider');
            throw stop;
          }
        },
      }),
    // Rebuild every request from allowlisted state. No free text, historical assistant text,
    // provider errors, raw document or tool argument can enter a later retry/request.
    prepareRequest: async ({ context: current }) => ({
      context: {
        ...current,
        messages: [
          createInitialSystemMessage(SYSTEM_PROMPT, currentTools())!,
          {
            role: 'user',
            content: JSON.stringify({
              request: { ...JSON.parse(safePrompt(intent, true)), action: request.action },
              completedTools: [...done],
              toolStatuses,
              overview: overview ?? null,
              algorithm: definition,
              parameters: { lowSpeedKnots: 3, minPositions: 3, windowMinutes: 60 },
              result: projectResults(results, version),
            }),
            timestamp: 0,
          },
        ],
      },
    }),
    finishTurn: async ({ message }) => {
      if (stop || asked) return { action: 'end' };
      if (message.stopReason === 'error' || message.stopReason === 'aborted') return;
      // A successful task requires a persisted algorithm result, including the empty result.
      if (!version) return { action: 'continue' };
    },
  });
  controller.signal.addEventListener('abort', () => agent.abort(), { once: true });
  agent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta')
      options.onTextDelta?.(event.assistantMessageEvent.delta);
  });
  try {
    await abortable(agent.prompt(safePrompt(intent, true)), controller.signal);
    await checkActive();
    if (stop) throw stop;
    if (asked) {
      await ports.finish({
        status: 'awaiting_input',
        summary: '请补充需要关注的行为或公告类型；已完成步骤已保存。',
      });
      return;
    }
    const final = [...agent.state.messages].reverse().find((m) => m.role === 'assistant');
    if (
      !final ||
      final.role !== 'assistant' ||
      final.stopReason === 'error' ||
      final.stopReason === 'aborted'
    )
      throw new RuntimeStop('provider');
    const summary = final.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    if (!version || !validateSummary(summary, projectResults(results, version)))
      throw new RuntimeStop('invalid_summary');
    await ports.finish({ status: 'completed', summary, summaryResultVersion: version });
  } catch (error) {
    const code = timedOut ? 'timeout' : error instanceof RuntimeStop ? error.code : 'provider';
    if (code === 'fenced') return;
    const messages = {
      budget: '本次运行已达到调用预算，已保存进度。请缩小任务或在新消息中继续。',
      limit: '数据量超过查询或算法上限，请缩小选区或时间范围。',
      retention: '查询超出 30 天在线历史保留范围，请选择近期时间。',
      provider: '模型或数据服务暂不可用；已完成步骤保留，请稍后重试。',
      invalid_summary: '模型总结未通过证据引用校验；算法结果已保存，可在证据面板查看。',
      configuration: '模型连接配置无效。',
      timeout: '本次智能体运行超时，已完成步骤保留，请稍后重试。',
      invalid_time: '模型时间回复格式无效。',
      invalid_conversation: '模型回复格式无效。',
    };
    await ports.finish({
      status: ['budget', 'limit', 'retention'].includes(code) ? 'awaiting_input' : 'failed',
      error: messages[code],
      ...(code === 'budget' ? { summary: messages.budget } : {}),
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
