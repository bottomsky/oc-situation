import { beforeEach, expect, it, vi } from 'vitest';
import type { Infrastructure } from '../../packages/infrastructure/clients';
const persistence = vi.hoisted(() => ({
  claimTopicRun: vi.fn(),
  saveTopicInput: vi.fn(),
  completeTopicRun: vi.fn(),
  failTopicRun: vi.fn(),
  renewTopicLease: vi.fn(),
}));
const dataset = vi.hoisted(() => ({ queryFusionDataset: vi.fn() }));
vi.mock('../../packages/infrastructure/topics', () => persistence);
vi.mock('../../packages/infrastructure/fusion-data', () => dataset);
vi.mock('../../packages/domain/topics', () => ({ evaluateTopic: () => [] }));
import { processNextTopicRun } from './index';

const infra = {} as Infrastructure;
const lease = {
  token: 'lease',
  instance: {
    id: 'instance',
    definitionId: 'port-restriction',
    config: { bbox: [120, 20, 123, 24] },
  },
  run: { id: 'run', from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
};
beforeEach(() => {
  vi.resetAllMocks();
  persistence.claimTopicRun.mockResolvedValue(lease);
  persistence.completeTopicRun.mockResolvedValue(true);
  dataset.queryFusionDataset.mockResolvedValue({ intelligence: [], ais: [] });
});
it('leaves execution counters unchanged when no runnable task exists', async () => {
  persistence.claimTopicRun.mockResolvedValue(null);
  const events = { onSucceeded: vi.fn(), onFailed: vi.fn() };
  expect(await processNextTopicRun(infra, undefined, undefined, events)).toBe(false);
  expect(events.onSucceeded).not.toHaveBeenCalled();
  expect(events.onFailed).not.toHaveBeenCalled();
});
it('counts one success only after a result commit accepts the lease', async () => {
  const events = { onSucceeded: vi.fn(), onFailed: vi.fn() };
  await processNextTopicRun(infra, undefined, undefined, events);
  expect(events.onSucceeded).toHaveBeenCalledTimes(1);
  expect(events.onFailed).not.toHaveBeenCalled();
  expect(persistence.completeTopicRun.mock.invocationCallOrder[0]).toBeLessThan(
    events.onSucceeded.mock.invocationCallOrder[0]!,
  );
});
it('does not count a generation-fenced result as successful execution', async () => {
  persistence.completeTopicRun.mockResolvedValue(false);
  const events = { onSucceeded: vi.fn(), onFailed: vi.fn() };
  await processNextTopicRun(infra, undefined, undefined, events);
  expect(events.onSucceeded).not.toHaveBeenCalled();
  expect(events.onFailed).not.toHaveBeenCalled();
});
it('counts a failed attempt after applying durable retry handling', async () => {
  dataset.queryFusionDataset.mockRejectedValue(new Error('Query unavailable'));
  const events = { onSucceeded: vi.fn(), onFailed: vi.fn() };
  await processNextTopicRun(infra, undefined, undefined, events);
  expect(events.onSucceeded).not.toHaveBeenCalled();
  expect(events.onFailed).toHaveBeenCalledTimes(1);
  expect(persistence.failTopicRun.mock.invocationCallOrder[0]).toBeLessThan(
    events.onFailed.mock.invocationCallOrder[0]!,
  );
});
