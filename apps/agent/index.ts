import { randomUUID } from 'node:crypto';
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
  workerId = randomUUID(),
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
        query: async () => {
          if (!boundTask.bbox) throw new Error('region_required');
          const dataset = await queryFusionDataset(infra, {
            from: boundTask.from,
            to: boundTask.to,
            bbox: boundTask.bbox,
            maxRecords: options.maxRecords ?? 50000,
          });
          return {
            ...dataset,
            intelligence: dataset.intelligence.map((d) => ({ ...d, kind: d.category })),
          };
        },
        saveResults: (results) => saveAgentResults(...fence, results),
        finish: (outcome) => finishAgentTask(...fence, outcome),
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
  if (!options.apiKey) throw new Error('DEEPSEEK_API_KEY is required when AGENT_ENABLED=true');
  let stage: WorkerStage = 'bus';
  try {
    await ensureAgentBus(infra);
    stage = 'consumer';
    const consumer = await infra.js.consumers.get(AGENT_STREAM, AGENT_CONSUMER);
    const workerId = randomUUID();
    while (!signal.aborted) {
      stage = 'publish';
      await publishRunnableAgentTasks(infra);
      stage = 'fetch';
      const messages = await consumer.fetch({ max_messages: 1, expires: 1000 });
      const close = () => {
        void messages.close();
      };
      signal.addEventListener('abort', close, { once: true });
      if (signal.aborted) close();
      const batch: JsMsg[] = [];
      try {
        // Drain the pull iterator before slow work, allowing NATS's queued stop callback
        // to close the NATS heartbeat monitor as soon as the one-message batch is received.
        for await (const message of messages) batch.push(message);
      } finally {
        signal.removeEventListener('abort', close);
        await messages.close();
      }
      stage = 'task';
      for (const message of batch) {
        if (signal.aborted) {
          message.nak();
          continue;
        }
        try {
          const job = JobSchema.parse(message.json());
          await processAgentTask(infra, job.taskId, { ...options, signal }, workerId);
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
  }
}
