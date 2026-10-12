import { expect, it, vi } from 'vitest';
import { buildMarineTrafficUrl, readBoundedResponse, collectPages, FatalSourceError } from './http';
import { fetchMarineTraffic, metadataWindow } from './http';
it('preserves supplier UTC window metadata rather than inferring a relative window', () => {
  expect(metadataWindow({ METADATA: { DATE_FROM: '2026-10-01 01:00:00', DATE_TO: '2026-10-01 01:05:00' } })).toEqual({ windowFrom: '2026-10-01T01:00:00.000Z', windowTo: '2026-10-01T01:05:00.000Z' });
  expect(metadataWindow({ METADATA: { DATE_FROM: 'bad', DATE_TO: 'bad' } })).toBeNull();
});
it('counts and paces every retry as an HTTP attempt', async () => {
  const fetcher = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue(new Response('{"DATA":[]}'));
  const before = vi.fn();
  await fetchMarineTraffic('https://services.marinetraffic.com/api/exportvessels/test?v=9', undefined, { beforeAttempt: before, fetch: fetcher, sleep: async () => {} });
  expect(before).toHaveBeenCalledTimes(2);
});
it('uses official v9 key URL without accepting arbitrary endpoints', () => {
  const url = buildMarineTrafficUrl('secret/key', 2000, 5, 'cursor-a');
  expect(url).toBe(
    'https://services.marinetraffic.com/api/exportvessels/secret%2Fkey?v=9&protocol=jsono&limit=2000&timespan=5&cursor=cursor-a',
  );
});
it('streams response bounds rather than trusting missing content length', async () => {
  await expect(readBoundedResponse(new Response('12345'), 4)).rejects.toThrow(
    'Response exceeds byte limit',
  );
});
it('persists each page cursor only after raw publish confirmation', async () => {
  const order: string[] = [];
  let page = 0;
  await collectPages({
    fetchPage: async () => ({ DATA: [], METADATA: { CURSOR: ++page === 1 ? 'next' : null } }),
    publish: async () => {
      order.push('publish');
    },
    checkpoint: async (cursor) => {
      order.push(`checkpoint:${cursor}`);
    },
  });
  expect(order).toEqual(['publish', 'checkpoint:next', 'publish', 'checkpoint:null']);
});
it('does not checkpoint a page that failed publication', async () => {
  let checkpointed = false;
  await expect(
    collectPages({
      fetchPage: async () => ({ DATA: [], METADATA: { CURSOR: 'next' } }),
      publish: async () => {
        throw new Error('nats down');
      },
      checkpoint: async () => {
        checkpointed = true;
      },
    }),
  ).rejects.toThrow('nats down');
  expect(checkpointed).toBe(false);
  expect(new FatalSourceError('Authentication failed').message).toBe('Authentication failed');
});
