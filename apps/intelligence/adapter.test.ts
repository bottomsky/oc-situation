import { expect, it, vi } from 'vitest';
import { decodeStructuredEvents, readLocalFeed, ingestSource } from './adapter';
import * as policy from '../crawler/src/policy';
import * as fusion from '../../packages/infrastructure/fusion-data';
import * as suggestions from './suggestions';
import { publicIntelligenceSources } from './source-presets';
import type { Infrastructure } from '../../packages/infrastructure/clients';
it('binds imported event source to the registered source and enforces maximum events', () => {
  expect(() =>
    decodeStructuredEvents(Buffer.from('[{"sourceId":"other"}]'), 'registered'),
  ).toThrow();
  expect(() =>
    decodeStructuredEvents(Buffer.from(JSON.stringify(Array(1001).fill({}))), 's'),
  ).toThrow('1000');
});
it('rejects path escape before accessing a local file', async () => {
  await expect(readLocalFeed('../outside.json', process.cwd())).rejects.toThrow('outside');
});
it('keeps redirected feed raw references and counts individual persistence failures separately', async () => {
  const source = publicIntelligenceSources.find((s) => s.adapter === 'rss')!;
  const archiveId = 'a'.repeat(64);
  const body = Buffer.from(
    '<rss><channel><item><title>Ship collision</title><link>https://gcaptain.com/a</link></item><item><title>Port news</title><link>https://gcaptain.com/b</link></item></channel></rss>',
  );
  vi.spyOn(policy, 'safeRequest').mockResolvedValue({
    status: 200,
    url: 'https://gcaptain.com/feed/redirected',
    body,
    headers: {},
  });
  vi.spyOn(fusion, 'archiveIntelligenceRaw').mockResolvedValue({
    archiveId,
    archiveKey: 'key',
    checksum: archiveId,
  });
  vi.spyOn(suggestions, 'suggestObjectRelations').mockResolvedValue([]);
  const save = vi
    .spyOn(fusion, 'saveIntelligenceEvent')
    .mockRejectedValueOnce(new Error('synthetic failure'))
    .mockResolvedValueOnce({} as Awaited<ReturnType<typeof fusion.saveIntelligenceEvent>>);
  try {
    const infra = {
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    } as unknown as Infrastructure;
    expect(await ingestSource(infra, source)).toMatchObject({
      imported: 1,
      unchanged: 0,
      failures: [{ reason: 'synthetic failure' }],
    });
    expect(save.mock.calls).toHaveLength(2);
    expect(save.mock.calls[1]?.[1].originalArchiveId).toBe(archiveId);
  } finally {
    vi.restoreAllMocks();
  }
});
