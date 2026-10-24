import {
  AckPolicy,
  DeliverPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type ConsumerMessages,
} from '@nats-io/jetstream';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import { logger } from '../../packages/infrastructure/clients';
import { ensureFusionBus, queryFusionDataset } from '../../packages/infrastructure/fusion-data';
import {
  claimTopicRun,
  completeTopicRun,
  expireExhaustedTopicRuns,
  failTopicRun,
  flushAnalysisOutbox,
  listTopicInstances,
  recordTopicReady,
  renewTopicLease,
  saveTopicInput,
  scheduleTopicRuns,
} from '../../packages/infrastructure/topics';
import { evaluateTopic } from '../../packages/domain/topics';
import type {
  TopicDataset,
  TopicDefinitionId,
  TopicInstance,
} from '../../packages/contracts/topics';
import { executeExternalTopic } from './protocol';
import { isPredictionDefinition } from '../../packages/contracts/topics';
import { executePredictionTopic } from './prediction-execution';
import { schedulePredictionRuns } from '../../packages/infrastructure/predictions';

const ReadyEvent = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(['ais', 'intelligence']),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  recordIds: z.array(z.string()).max(100000),
  createdAt: z.iso.datetime(),
});
function missing(error: unknown) {
  const e = error as {
    code?: number | string;
    name?: string;
    api_error?: { code?: number };
    apiError?: { code?: number };
  };
  return (
    e.code === 404 ||
    e.code === '404' ||
    e.api_error?.code === 404 ||
    e.apiError?.code === 404 ||
    e.name === 'StreamNotFoundError' ||
    e.name === 'ConsumerNotFoundError'
  );
}
export async function ensureAnalysisBus(infra: Infrastructure) {
  try {
    const info = await infra.jsm.streams.info('FUSION_ANALYSIS');
    if (
      info.config.storage !== StorageType.File ||
      info.config.retention !== RetentionPolicy.Limits ||
      JSON.stringify(info.config.subjects) !== JSON.stringify(['fusion.analysis.updated'])
    )
      throw new Error('FUSION_ANALYSIS topology drift');
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await infra.jsm.streams.add({
        name: 'FUSION_ANALYSIS',
        subjects: ['fusion.analysis.updated'],
        storage: StorageType.File,
        retention: RetentionPolicy.Limits,
        discard: DiscardPolicy.Old,
        max_bytes: 500_000_000,
        max_age: 7 * 86400e9,
        duplicate_window: 120e9,
      });
    } catch {
      const existing = await infra.jsm.streams.info('FUSION_ANALYSIS');
      if (
        existing.config.storage !== StorageType.File ||
        existing.config.retention !== RetentionPolicy.Limits ||
        JSON.stringify(existing.config.subjects) !== JSON.stringify(['fusion.analysis.updated'])
      )
        throw new Error('FUSION_ANALYSIS topology drift');
    }
  }
}
export const topicDurableName = (id: string) => `topic-${id}`;
export async function ensureTopicConsumer(infra: Infrastructure, id: string) {
  const durable = topicDurableName(id);
  try {
    const info = await infra.jsm.consumers.info('FUSION_READY', durable);
    if (
      info.config.ack_policy !== AckPolicy.Explicit ||
      info.config.filter_subject !== 'fusion.ready'
    )
      throw new Error('Topic consumer topology drift');
  } catch (error) {
    if (!missing(error)) throw error;
    try {
      await infra.jsm.consumers.add('FUSION_READY', {
        durable_name: durable,
        filter_subject: 'fusion.ready',
        ack_policy: AckPolicy.Explicit,
        deliver_policy: DeliverPolicy.All,
        max_ack_pending: 10,
        ack_wait: 60e9,
        max_deliver: 5,
      });
    } catch {
      const existing = await infra.jsm.consumers.info('FUSION_READY', durable);
      if (
        existing.config.ack_policy !== AckPolicy.Explicit ||
        existing.config.filter_subject !== 'fusion.ready'
      )
        throw new Error('Topic consumer topology drift');
    }
  }
  return infra.js.consumers.get('FUSION_READY', durable);
}
export interface TopicRunEvents {
  onSucceeded?: () => void;
  onFailed?: () => void;
}
export async function processNextTopicRun(
  infra: Infrastructure,
  definitionId?: TopicDefinitionId,
  instanceId?: string,
  events: TopicRunEvents = {},
  signal?: AbortSignal,
) {
  const lease = await claimTopicRun(infra, definitionId, instanceId);
  if (!lease) return false;
  let outcome: 'succeeded' | 'failed' | 'fenced' = 'fenced';
  let renewing = false;
  const abort = new AbortController();
  const deadline = Date.now() + 30000;
  let timedOut = false;
  const deadlineTimer = isPredictionDefinition(lease.instance.definitionId)
    ? setTimeout(() => {
        timedOut = true;
        abort.abort();
      }, 30000)
    : undefined;
  const cancel = () => abort.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setInterval(
    () => {
      if (renewing) return;
      renewing = true;
      void renewTopicLease(infra, lease)
        .then((valid) => {
          if (!valid && isPredictionDefinition(lease.instance.definitionId)) abort.abort();
        })
        .catch((error) => logger.error({ error: String(error) }, 'Topic lease renewal failed'))
        .finally(() => {
          renewing = false;
        });
    },
    isPredictionDefinition(lease.instance.definitionId) ? 1000 : 30_000,
  );
  try {
    if (isPredictionDefinition(lease.instance.definitionId)) {
      const output = await executePredictionTopic(infra, lease, abort.signal, deadline);
      if (
        !abort.signal.aborted &&
        (await completeTopicRun(infra, lease, output.results, output.artifacts, {
          signal: abort.signal,
          deadline,
        }))
      )
        outcome = 'succeeded';
    } else {
      const input = await queryFusionDataset(infra, {
        from: lease.run.from,
        to: lease.run.to,
        bbox: lease.instance.config.bbox,
      });
      const dataset: TopicDataset = {
        ...input,
        intelligence: input.intelligence.map((d) => ({ ...d, kind: d.category })),
      };
      await saveTopicInput(infra, lease, dataset);
      const results = process.env.TOPIC_EXECUTOR_COMMAND
        ? await executeExternalTopic(process.env.TOPIC_EXECUTOR_COMMAND, lease.instance, dataset)
        : evaluateTopic(lease.instance, dataset);
      if (await completeTopicRun(infra, lease, results)) outcome = 'succeeded';
    }
  } catch (error) {
    if (!abort.signal.aborted || timedOut) {
      const failure = timedOut
        ? new Error('Prediction task exceeded its 30-second end-to-end deadline')
        : error;
      await failTopicRun(infra, lease, failure);
      outcome = 'failed';
      logger.warn(
        {
          runId: lease.run.id,
          error: failure instanceof Error ? failure.message : String(failure),
        },
        'Topic run failed; durable retry policy applied',
      );
    }
  } finally {
    clearInterval(timer);
    clearTimeout(deadlineTimer);
    signal?.removeEventListener('abort', cancel);
  }
  if (outcome === 'succeeded') events.onSucceeded?.();
  if (outcome === 'failed') events.onFailed?.();
  return true;
}
export async function runPredictionTopics(
  infra: Infrastructure,
  signal: AbortSignal,
  events: TopicRunEvents = {},
) {
  await ensureAnalysisBus(infra);
  const work = async () => {
    if (await processNextTopicRun(infra, 'vessel-reachability', undefined, events, signal)) return;
    await processNextTopicRun(infra, 'navigation-warning-impact', undefined, events, signal);
  };
  while (!signal.aborted) {
    await expireExhaustedTopicRuns(infra);
    await schedulePredictionRuns(infra);
    await Promise.all([work(), work()]);
    await flushAnalysisOutbox(infra);
    try {
      await delay(1000, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
async function handleSubscription(
  infra: Infrastructure,
  instance: TopicInstance,
  messages: ConsumerMessages,
  signal: AbortSignal,
) {
  try {
    for await (const message of messages) {
      if (signal.aborted) break;
      try {
        const event = ReadyEvent.parse(message.json());
        // Coalesced durable time bounds absorb high-rate AIS, and preserve late-event replay ranges.
        await recordTopicReady(infra, instance.id, event);
        message.ack();
      } catch (error) {
        if (error instanceof Error && error.message === 'Topic instance is disabled') {
          message.ack();
          continue;
        }
        if (message.info.deliveryCount >= 5 || error instanceof z.ZodError) {
          await infra.pool.query(
            `INSERT INTO topic_delivery_failures(instance_id,event_id,error) VALUES($1,$2,$3) ON CONFLICT(instance_id,event_id) DO UPDATE SET error=excluded.error`,
            [
              instance.id,
              `stream:${message.info.streamSequence}`,
              (error instanceof Error ? error.message : String(error)).slice(0, 2000),
            ],
          );
          message.term('Topic delivery rejected; see topic_delivery_failures');
        } else message.nak(1000 * 2 ** message.info.deliveryCount);
      }
    }
  } finally {
    await messages.close();
  }
}
export async function runTopics(
  infra: Infrastructure,
  signal: AbortSignal,
  definitionId?: TopicDefinitionId,
  events: TopicRunEvents = {},
) {
  await ensureFusionBus(infra);
  await ensureAnalysisBus(infra);
  const subscriptions = new Map<
    string,
    { messages: ConsumerMessages; done: Promise<void>; generation: number }
  >();
  const stop = () => {
    for (const sub of subscriptions.values()) void sub.messages.close();
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    while (!signal.aborted) {
      const instances = (await listTopicInstances(infra)).filter(
        (i) => i.enabled && (!definitionId || i.definitionId === definitionId),
      );
      for (const [id, sub] of subscriptions) {
        if (!instances.some((i) => i.id === id && i.generation === sub.generation)) {
          await sub.messages.close();
          await sub.done;
          subscriptions.delete(id);
        }
      }
      for (const instance of instances) {
        if (subscriptions.has(instance.id)) continue;
        const consumer = await ensureTopicConsumer(infra, instance.id);
        const messages = await consumer.consume({ max_messages: 10 });
        const done = handleSubscription(infra, instance, messages, signal).catch((error) => {
          logger.error(
            { instanceId: instance.id, error: String(error) },
            'Topic subscription stopped',
          );
          subscriptions.delete(instance.id);
        });
        subscriptions.set(instance.id, { messages, done, generation: instance.generation });
      }
      await expireExhaustedTopicRuns(infra);
      await scheduleTopicRuns(infra, definitionId);
      await processNextTopicRun(infra, definitionId, undefined, events);
      await flushAnalysisOutbox(infra);
      try {
        await delay(1000, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  } finally {
    stop();
    await Promise.all([...subscriptions.values()].map((s) => s.done));
    signal.removeEventListener('abort', stop);
  }
}
