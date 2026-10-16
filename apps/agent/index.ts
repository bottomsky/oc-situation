import { executeUiTask } from './ui-runtime';
import {
  expireUiCommands,
  createUiCommand,
  getUiTaskCommand,
} from '../../packages/infrastructure/agent-ui';
import {
  searchAgentIntelligence,
  getIntelligenceSourceHealth,
} from '../../packages/infrastructure/intelligence-search';
import { randomUUID } from 'node:crypto';
import { queryAisHeatmap } from '../../packages/infrastructure/heatmap';
import { getBusinessSkillCatalog } from './business-capabilities';
import { setTimeout as delay } from 'node:timers/promises';
import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JsMsg,
} from '@nats-io/jetstream';
import { z } from 'zod';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import { queryFusionDataset } from '../../packages/infrastructure/fusion-data';
import {
  queryAgentVessels,
  resolveAgentAnalysisMmsis,
} from '../../packages/infrastructure/agent-query';
import {
  claimAgentTask,
  finishAgentTask,
  getAgentTaskContext,
  getPreviousAgentTask,
  listRunnableAgentTasks,
  renewAgentTask,
  reserveAgentCall,
  reusePreviousAgentTask,
  saveAgentResults,
  saveAgentStep,
  setAgentDefinition,
  requestAgentInput,
  saveAgentQueryResult,
  saveAgentIntelligenceResult,
  saveAgentHeatmapResult,
} from '../../packages/infrastructure/agent';
import { executeAgent, type RuntimeOptions } from './runtime';

export const AGENT_STREAM = 'AGENT_TASKS';
export const AGENT_SUBJECT = 'agent.task.requested';
export const AGENT_CONSUMER = 'agent-worker';
const JobSchema = z.strictObject({ taskId: z.uuid() });
type WorkerStage = 'startup' | 'bus' | 'consumer' | 'publish' | 'fetch' | 'task';
type WorkerFailureDetails = { stage: WorkerStage; kind: string };
class WorkerOperationError extends Error {
  readonly details: WorkerFailureDetails;
  constructor(stage: WorkerStage, cause: unknown) {
    super('Agent worker operation failed', { cause });
    this.details = agentWorkerFailure(cause, stage);
  }
}

/** Return only known fault categories; error messages, URLs and credentials stay out of logs. */
export function agentWorkerFailure(
  error: unknown,
  stage: WorkerStage = 'startup',
): WorkerFailureDetails {
  if (error instanceof WorkerOperationError) return error.details;
  const value = error as { name?: string; message?: string; code?: string } | null;
  const codes: Record<string, string> = {
    '57014': 'database_timeout',
    '55P03': 'database_lock_timeout',
    '53300': 'database_capacity',
    ECONNREFUSED: 'connection_refused',
    ECONNRESET: 'connection_reset',
    ETIMEDOUT: 'connection_timeout',
  };
  const kind =
    value?.name === 'JetStreamError' && value.message === 'heartbeats missed'
      ? 'nats_heartbeat'
      : value?.name === 'JetStreamApiError'
        ? 'nats_api'
        : value?.code && Object.hasOwn(codes, value.code)
          ? codes[value.code]!
          : 'unexpected';
  return { stage, kind };
}
const positive = (value: string | undefined, fallback: number, maximum: number) =>
  z.coerce
    .number()
    .int()
    .min(1)
    .max(maximum)
    .parse(value ?? fallback);
export function agentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RuntimeOptions & { enabled: boolean; maxRecords: number } {
  return {
    enabled: env.AGENT_ENABLED === 'true',
    apiKey: env.DEEPSEEK_API_KEY ?? '',
    model: env.DEEPSEEK_MODEL ?? 'deepseek-flash',
    maxModelCalls: positive(env.AGENT_MAX_MODEL_CALLS, 12, 100),
    maxToolCalls: positive(env.AGENT_MAX_TOOL_CALLS, 24, 200),
    maxRecords: positive(env.AGENT_MAX_RECORDS, 50000, 100000),
  };
}
function missing(error: unknown) {
  const value = error as { code?: number | string; api_error?: { code?: number }; name?: string };
  return (
    value.code === 404 ||
    value.code === '404' ||
    value.api_error?.code === 404 ||
    value.name === 'StreamNotFoundError' ||
    value.name === 'ConsumerNotFoundError'
  );
}
export async function ensureAgentBus(infra: Infrastructure): Promise<void> {
  const streamMatches = (config: {
    storage: StorageType;
    retention: RetentionPolicy;
    subjects?: string[];
  }) =>
    config.storage === StorageType.File &&
    config.retention === RetentionPolicy.Workqueue &&
    JSON.stringify(config.subjects) === JSON.stringify([AGENT_SUBJECT]);
  try {
    if (!streamMatches((await infra.jsm.streams.info(AGENT_STREAM)).config))
      throw new Error('AGENT_TASKS topology drift');
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await infra.jsm.streams.add({
        name: AGENT_STREAM,
        subjects: [AGENT_SUBJECT],
        storage: StorageType.File,
        retention: RetentionPolicy.Workqueue,
        discard: DiscardPolicy.New,
        max_bytes: 100_000_000,
        duplicate_window: 5e9,
      });
    } catch {
      if (!streamMatches((await infra.jsm.streams.info(AGENT_STREAM)).config))
        throw new Error('AGENT_TASKS topology drift');
    }
  }
  const consumerMatches = (config: { ack_policy: AckPolicy; filter_subject?: string }) =>
    config.ack_policy === AckPolicy.Explicit && config.filter_subject === AGENT_SUBJECT;
  try {
    if (!consumerMatches((await infra.jsm.consumers.info(AGENT_STREAM, AGENT_CONSUMER)).config))
      throw new Error('Agent consumer topology drift');
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await infra.jsm.consumers.add(AGENT_STREAM, {
        durable_name: AGENT_CONSUMER,
        filter_subject: AGENT_SUBJECT,
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_ack_pending: 8,
        ack_wait: 240e9,
        max_deliver: -1,
      });
    } catch {
      if (!consumerMatches((await infra.jsm.consumers.info(AGENT_STREAM, AGENT_CONSUMER)).config))
        throw new Error('Agent consumer topology drift');
    }
  }
}
/** PostgreSQL's queued/expired task rows are the outbox; loss of a publish never loses a task. */
export async function publishRunnableAgentTasks(infra: Infrastructure) {
  await expireUiCommands(infra);
  const tasks = await listRunnableAgentTasks(infra);
  for (const taskId of tasks)
    await infra.js.publish(AGENT_SUBJECT, JSON.stringify({ taskId }), {
      msgID: `${taskId}:${Math.floor(Date.now() / 5000)}`,
    });
  return tasks.length;
}

export async function processAgentTask(
  infra: Infrastructure,
  taskId: string,
  options: RuntimeOptions & { maxRecords?: number },
  workerId: string = randomUUID(),
): Promise<boolean> {
  const task = await claimAgentTask(infra, workerId, taskId);
  if (!task) return false;
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  const fence = [infra, task.id, workerId, task.generation] as const;
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void renewAgentTask(...fence)
      .then((ok) => {
        if (!ok) stop();
      })
      .catch(stop)
      .finally(() => {
        renewing = false;
      });
  }, 20_000);
  try {
    const context = await getAgentTaskContext(infra, task.id);
    if (!context) return false;
    if (
      task.intent === 'ui_control' ||
      (task.intent === 'ais_heatmap' &&
        (await getUiTaskCommand(infra, task.id, task.inputRevision ?? 0)))
    ) {
      await executeUiTask(infra, task, workerId, options.maxToolCalls ?? 24);
      return true;
    }
    const previous = await getPreviousAgentTask(infra, task.id);
    let boundTask = task;
    await executeAgent(
      { ...context, previous },
      {
        active: async () => !controller.signal.aborted && (await renewAgentTask(...fence)),
        reserve: (kind, maximum) => reserveAgentCall(...fence, kind, maximum),
        setDefinition: (definition) => setAgentDefinition(...fence, definition),
        reusePrevious: async (previousId) => {
          const reused = await reusePreviousAgentTask(...fence, previousId);
          if (reused) boundTask = reused;
          return reused;
        },
        saveStep: (key, name, output) =>
          saveAgentStep(...fence, { key, name, input: null, output }),
        requestInput: (spec) => requestAgentInput(...fence, spec),
        queryVessels: (kind, selection) =>
          queryAgentVessels(infra, {
            kind,
            selection,
            inputRevision: boundTask.inputRevision ?? 0,
          }),
        searchIntelligence: (selection) => searchAgentIntelligence(infra, selection),
        intelligenceSourceHealth: () => getIntelligenceSourceHealth(infra),
        saveIntelligenceResult: (result) => saveAgentIntelligenceResult(...fence, result),
        saveQueryResult: (result) => saveAgentQueryResult(...fence, result),
        queryHeatmap: (query, signal) =>
          queryAisHeatmap(infra, query, { ownerId: task.ownerId, signal }),
        saveHeatmapResult: (result) => saveAgentHeatmapResult(...fence, result),
        query: async () => {
          if (!boundTask.bbox) throw new Error('region_required');
          const mmsis = await resolveAgentAnalysisMmsis(
            infra,
            boundTask.selection ?? {},
            options.maxRecords ?? 50000,
          );
          const dataset = await queryFusionDataset(infra, {
            from: boundTask.from,
            to: boundTask.to,
            bbox: boundTask.bbox,
            maxRecords: options.maxRecords ?? 50000,
            mmsis,
            sourceId: boundTask.selection?.filters?.sourceId,
          });
          return {
            ...dataset,
            intelligence: dataset.intelligence.map((d) => ({ ...d, kind: d.category })),
          };
        },
        saveResults: (results) => saveAgentResults(...fence, results),
        finish: async (outcome) => {
          if (
            task.intent === 'ais_heatmap' &&
            outcome.status === 'completed' &&
            task.uiBinding &&
            process.env.AGENT_UI_ENABLED === 'true'
          ) {
            await saveAgentStep(...fence, {
              key: 'ui_presentation_summary',
              name: '热图计算结果',
              input: null,
              output: outcome,
            });
            try {
              return !!(await createUiCommand(...fence, {
                componentId: 'chart.heatmap',
                action: 'show',
              }));
            } catch {
              return finishAgentTask(...fence, {
                ...outcome,
                summary:
                  outcome.summary +
                  ' 计算结果已保存；当前页面状态已改变，未自动展示，请从历史结果重新展示。',
              });
            }
          }
          return finishAgentTask(...fence, outcome);
        },
      },
      { ...options, signal: controller.signal },
    );
    return true;
  } finally {
    clearInterval(timer);
    options.signal?.removeEventListener('abort', stop);
  }
}

export async function runAgentWorker(
  infra: Infrastructure,
  signal: AbortSignal,
  options = agentEnvironment(),
): Promise<void> {
  if (!options.enabled) return;
  const skillCatalog = options.skillCatalog ?? (await getBusinessSkillCatalog());
  if (!options.apiKey) throw new Error('DEEPSEEK_API_KEY is required when AGENT_ENABLED=true');
  let stage: WorkerStage = 'bus';
  // A bounded UI lane keeps close/hide commands responsive while a data/model task is running.
  // Both lanes claim the same durable tasks; PostgreSQL fencing prevents double execution.
  let uiWork: Promise<void> | undefined;
  const uiWorkerId = `ui-${randomUUID()}`;
  const uiTimer = setInterval(() => {
    if (uiWork || signal.aborted || process.env.AGENT_UI_ENABLED !== 'true') return;
    uiWork = (async () => {
      await expireUiCommands(infra);
      const tasks = await infra.pool
        .query(`SELECT t.id FROM agent_tasks t WHERE t.status='queued' AND
        (t.intent='ui_control' OR EXISTS (SELECT 1 FROM agent_ui_commands c WHERE c.task_id=t.id AND c.input_revision=t.input_revision)) ORDER BY t.created_at LIMIT 4`);
      for (const row of tasks.rows) {
        if (signal.aborted) break;
        await processAgentTask(infra, row.id, { ...options, skillCatalog, signal }, uiWorkerId);
      }
    })()
      .catch(() => {
        /* Durable queued tasks are retried on the next bounded scan. */
      })
      .finally(() => {
        uiWork = undefined;
      });
  }, 1000);
  try {
    await ensureAgentBus(infra);
    stage = 'consumer';
    let consumer = await infra.js.consumers.get(AGENT_STREAM, AGENT_CONSUMER);
    let heartbeatFailures = 0;
    const workerId = randomUUID();
    while (!signal.aborted) {
      stage = 'publish';
      await publishRunnableAgentTasks(infra);
      stage = 'fetch';
      const batch: JsMsg[] = [];
      try {
        const messages = await consumer.fetch({ max_messages: 1, expires: 1000 });
        const close = () => {
          void Promise.resolve(messages.close()).catch(() => {});
        };
        signal.addEventListener('abort', close, { once: true });
        if (signal.aborted) close();
        try {
          // Drain before task work so the iterator's heartbeat monitor can stop immediately.
          for await (const message of messages) batch.push(message);
        } finally {
          signal.removeEventListener('abort', close);
          await messages.close();
        }
        heartbeatFailures = 0;
      } catch (error) {
        // An interrupted iterator may already have yielded one job. Release it for redelivery;
        // PostgreSQL leases/fences and the runnable-task outbox remain the source of truth.
        for (const message of batch) message.nak(5000);
        if (signal.aborted) return;
        if (agentWorkerFailure(error, 'fetch').kind !== 'nats_heartbeat') throw error;
        const backoffMs = Math.min(5000, 250 * 2 ** Math.min(heartbeatFailures++, 5));
        await delay(backoffMs, undefined, { signal }).catch((error: unknown) => {
          if (!signal.aborted) throw error;
        });
        if (signal.aborted) return;
        stage = 'consumer';
        consumer = await infra.js.consumers.get(AGENT_STREAM, AGENT_CONSUMER);
        continue;
      }
      stage = 'task';
      for (const message of batch) {
        if (signal.aborted) {
          message.nak();
          continue;
        }
        try {
          const job = JobSchema.parse(message.json());
          await processAgentTask(infra, job.taskId, { ...options, skillCatalog, signal }, workerId);
          message.ack();
        } catch (error) {
          if (error instanceof z.ZodError) message.term('invalid task envelope');
          else message.nak(5000);
        }
      }
      if (!signal.aborted) await delay(500, undefined, { signal }).catch(() => {});
    }
  } catch (error) {
    throw new WorkerOperationError(stage, error);
  } finally {
    clearInterval(uiTimer);
    await uiWork;
  }
}
