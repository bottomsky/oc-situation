import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeMaritimeHtml,
  decodeGdacs,
  decodeGdelt,
  extractCoordinates,
  nextRevision,
  parseSourceTime,
  maritimeLinks,
  collectProvider,
} from './providers';
import { publicIntelligenceSources } from './source-presets';
import * as policy from '../crawler/src/policy';

const notice = readFileSync(new URL('./fixtures/zhejiang-real-notice.html', import.meta.url));
const weather = readFileSync(new URL('./fixtures/gdacs-yagi-real.json', import.meta.url));
const url = 'https://www.zj.msa.gov.cn/ZJ/wszw/bmcx/hsskcx/hxjg/202610/t20261008_21435.html';
describe('public maritime providers', () => {
  it('extracts actual source DMS coordinates and flags missing effective time', () => {
    const event = decodeMaritimeHtml(notice, 'zhejiang-maritime', url);
    if ('reason' in event) throw new Error(event.reason);
    expect(event.reviewStatus).toBe('candidate');
    expect(event.relations?.[0]?.geometry).toEqual({
      type: 'Point',
      coordinates: [121 + 27.1 / 60, 30 + 30.9 / 60],
    });
    expect(event.publishedAt).toBe('2026-10-08T13:13:00.000Z');
    expect(event.raw).toMatchObject({ requiresEffectiveTimeReview: true });
  });
  it('parses decimal, Chinese prefixes and negative hemisphere; rejects invalid minutes', () => {
    expect(extractCoordinates('31.5N 122.3E')).toEqual([[122.3, 31.5]]);
    expect(extractCoordinates('北纬31°30′ 东经122°18′')).toEqual([[122.3, 31.5]]);
    expect(extractCoordinates('31-30S 122-18W')).toEqual([[-122.3, -31.5]]);
    expect(extractCoordinates('31-60N 122-18E')).toEqual([]);
    expect(extractCoordinates('length 31.5 width 122.3')).toEqual([]);
  });
  it('rejects malformed calendar dates and does not adopt background dates as effectiveness', () => {
    expect(parseSourceTime('2026-02-30')).toBeNull();
    expect(parseSourceTime('2026-01-01 25:00')).toBeNull();
    const event = decodeMaritimeHtml(
      Buffer.from(
        '<meta name="ArticleTitle" content="公告"><meta name="PubDate" content="2026-10-08"><div class="article">依据2020年1月1日颁布法规，2021年2月1日进行了调查。</div>',
      ),
      's',
      url,
    );
    expect(event).toMatchObject({ raw: { requiresEffectiveTimeReview: true } });
  });
  it('retains missing publication as archive pending instead of inventing a date', () => {
    expect(
      decodeMaritimeHtml(Buffer.from('<h1>公告</h1><div class="article">港口施工</div>'), 's', url),
    ).toMatchObject({ reason: expect.stringContaining('发布时间') });
  });
  it('uses real historical GDACS location and event dates rather than collection date', () => {
    const [event] = decodeGdacs(weather, 'gdacs-near-china');
    expect(event?.externalId).toBe('TC:1001090');
    expect(event?.effectiveFrom.startsWith('2024-09')).toBe(true);
    expect(event?.relations?.[0]).toMatchObject({
      kind: 'occurs-at',
      geometry: { type: 'Point', coordinates: [106.9, 21] },
    });
    const f = JSON.parse(weather.toString());
    f.geometry.coordinates = [-120, 20];
    expect(decodeGdacs(Buffer.from(JSON.stringify(f)), 's')).toEqual([]);
  });
  it('preserves news as candidates without generated occurrence/impact geometry', () => {
    const [event] = decodeGdelt(
      Buffer.from(
        JSON.stringify({
          articles: [
            {
              title: 'Shipping near Shanghai',
              url: 'https://example.org/news',
              seendate: '20261010T120000Z',
            },
          ],
        }),
      ),
      's',
      'https://api.gdeltproject.org/api/v2/doc/doc',
    );
    expect(event?.reviewStatus).toBe('candidate');
    expect(event?.relations).toEqual([]);
    expect(event?.raw).toMatchObject({ requiresOccurrenceTimeReview: true });
    expect(() => decodeGdelt(Buffer.from('{}'), 's', 'https://api.gdeltproject.org')).toThrow();
  });
  it('is idempotent and supersedes revisions including changed source geometry', () => {
    const event = decodeGdacs(weather, 's')[0]!;
    const latest = {
      ...event,
      id: 'latest',
      archiveKey: 'local',
      checksum: 'abc',
      recordedAt: '2026-01-01',
    };
    expect(nextRevision(event, latest)).toBeNull();
    const changed = { ...event, title: event.title + ' revised' };
    expect(nextRevision(changed, latest)).toMatchObject({
      version: 2,
      supersedesId: 'latest',
      status: 'revised',
    });
    const moved = structuredClone(event);
    moved.relations![0]!.geometry = { type: 'Point', coordinates: [107, 21] };
    expect(nextRevision(moved, latest)?.version).toBe(2);
    const saved = { ...nextRevision(event)!, id: 'reviewed' };
    saved.raw = { ...(saved.raw as Record<string, unknown>), manualTimeConfirmed: true };
    saved.effectiveFrom = '2024-09-01T00:00:00.000Z';
    saved.reviewStatus = 'confirmed';
    expect(nextRevision(event, saved)).toBeNull();
  });
  it('follows only registered listing documents and isolates a failed document', async () => {
    const source = { ...publicIntelligenceSources[0]!, maxDocuments: 2 };
    const list = Buffer.from(
      '<a href="./202610/t20261008_21435.html">航警</a><a href="./202610/t20261008_21436.html">航警</a><a href="https://evil.example/202610/t20261008_21436.html">航警</a>',
    );
    expect(maritimeLinks(list, source.endpoint!, 5)).toHaveLength(2);
    const spy = vi
      .spyOn(policy, 'safeRequest')
      .mockResolvedValueOnce({ body: list, url: source.endpoint!, status: 200, headers: {} })
      .mockRejectedValueOnce(new Error('Provider HTTP 503'))
      .mockResolvedValueOnce({ body: notice, url: source.endpoint!, status: 200, headers: {} });
    const archive = vi.fn().mockResolvedValue(undefined);
    const result = await collectProvider(source, archive);
    expect(result.events).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(archive).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });
});
