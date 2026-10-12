import { AckPolicy, DeliverPolicy, DiscardPolicy, StorageType } from '@nats-io/jetstream';
import { CONSUMERS, STREAMS } from '@ais/infrastructure';

/** Valid topology with optional age pressure; exercises the real collection gate. */
export function testBusHealth(pressureStream?: string) {
  return {
    streams: {
      info: async (name: string) => {
        const stream = Object.values(STREAMS).find((stream) => stream.name === name)!;
        const pressured = name === pressureStream;
        return {
          config: {
            ...stream,
            subjects: [...stream.subjects],
            storage: StorageType.File,
            discard: DiscardPolicy.New,
            max_age: 0,
            max_bytes: stream.maxBytes,
            num_replicas: 1,
          },
          state: {
            bytes: 100,
            messages: pressured ? 1 : 0,
            first_ts: new Date(Date.now() - 2 * 86_400_000).toISOString(),
          },
        };
      },
    },
    consumers: {
      info: async (_stream: string, durable: string) => {
        const consumer = CONSUMERS.find((consumer) => consumer.durable === durable)!;
        return {
          config: {
            filter_subject: consumer.filter,
            ack_policy: AckPolicy.Explicit,
            max_ack_pending: consumer.maxPending,
            durable_name: consumer.durable,
            deliver_policy: DeliverPolicy.All,
            ack_wait: 120_000_000_000,
            max_deliver: -1,
            max_waiting: consumer.maxPending === 1 || durable === 'collector' ? 1 : 512,
          },
        };
      },
    },
  };
}
