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
  decodeRss,
  decodeUsgs,
  decodeMarineForecasts,
} from './providers';
import { publicIntelligenceSources } from './source-presets';
import * as policy from '../crawler/src/policy';
import { MARINE_SAMPLE_POINTS } from '../../packages/contracts/intelligence-search';

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
    expect(event?.raw).toMatchObject({
      timeBasis: 'effective',
      publishedTimeBasis: 'provider-updated',
    });
    expect(event?.externalId).toBe('TC:1001090');
    expect(event?.effectiveFrom.startsWith('2024-09')).toBe(true);
    expect(event?.relations?.[0]).toMatchObject({
      kind: 'occurs-at',
      geometry: { type: 'Point', coordinates: [106.9, 21] },
    });
    const f = JSON.parse(weather.toString());
    f.geometry.coordinates = [-120, 20];
    expect(decodeGdacs(Buffer.from(JSON.stringify(f)), 's')).toHaveLength(1);
    expect(decodeGdacs(Buffer.from(JSON.stringify(f)), 's', { bbox: [105, 3, 135, 45] })).toEqual(
      [],
    );
    f.properties.eventtype = 'FL';
    expect(decodeGdacs(Buffer.from(JSON.stringify(f)), 's')[0]?.category).toBe('environment');
    expect(decodeGdacs(Buffer.from(JSON.stringify(f)), 's', { eventTypes: ['TC'] })).toEqual([]);
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
  it('has seven public presets with distinct ids and fixed six-point 72 hour marine coverage', () => {
    expect(publicIntelligenceSources).toHaveLength(7);
    expect(new Set(publicIntelligenceSources.map((s) => s.sourceId)).size).toBe(7);
    expect(publicIntelligenceSources.every((s) => s.visibility === 'public')).toBe(true);
    const marine = new URL(
      publicIntelligenceSources.find((s) => s.adapter === 'marine')!.endpoint!,
    );
    expect(marine.searchParams.get('forecast_hours')).toBe('72');
    expect(marine.searchParams.get('latitude')?.split(',')).toHaveLength(6);
  });
  it('turns RSS and Atom articles into non-geographic candidates without fabricating publication time', () => {
    const bytes = Buffer.from(
      '<rss><channel><item><guid>x</guid><title>Shipping &amp; Ports</title><link>https://gcaptain.com/a/</link><description><![CDATA[<p>News only</p>]]></description><pubDate>Tue, 13 Oct 2026 02:00:00 GMT</pubDate></item><item><guid>unknown</guid><title>Unknown date</title><link>https://gcaptain.com/b/</link></item></channel></rss>',
    );
    const first = decodeRss(bytes, 'rss', 'https://gcaptain.com/feed/', '2026-10-13T03:00:00.000Z');
    expect(first.events).toHaveLength(2);
    expect(first.events[0]).toMatchObject({
      reviewStatus: 'candidate',
      relations: [],
      publishedAt: '2026-10-13T02:00:00.000Z',
      raw: { timeBasis: 'publication' },
    });
    expect(first.events[1]!.raw).toMatchObject({
      timeBasis: 'unknown',
      publicationTimeKnown: false,
      observedAt: '2026-10-13T03:00:00.000Z',
    });
    const next = decodeRss(bytes, 'rss', 'https://gcaptain.com/feed/', '2026-10-13T04:00:00.000Z');
    for (let index = 0; index < 2; index++)
      expect(
        nextRevision(next.events[index]!, { ...first.events[index]!, id: `old-${index}` }),
      ).toBeNull();
    const atom = decodeRss(
      Buffer.from(
        '<feed><entry><id>a</id><title>Atom</title><link href="https://gcaptain.com/atom"/><published>2026-10-13T01:00:00Z</published><summary>Summary</summary></entry></feed>',
      ),
      'rss',
      'https://gcaptain.com/feed/',
    );
    expect(atom.events[0]?.originalUrl).toBe('https://gcaptain.com/atom');
    const incident = decodeRss(
      Buffer.from(
        '<rss><channel><item><title>Ship collision reported</title><link>https://gcaptain.com/collision/</link></item></channel></rss>',
      ),
      'rss',
      'https://gcaptain.com/feed/',
    );
    expect(incident.events[0]).toMatchObject({
      category: 'incident',
      reviewStatus: 'candidate',
      relations: [],
      raw: { publicationTimeKnown: false, requiresEffectiveTimeReview: true },
    });
    expect(() =>
      decodeRss(Buffer.from('<html>blocked</html>'), 'rss', 'https://gcaptain.com/feed/'),
    ).toThrow('RSS');
  });
  it('retains USGS earthquake occurrence separately from update time and never interprets tsunami flag as a warning', () => {
    const bytes = Buffer.from(
      JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            id: 'us-test',
            geometry: { type: 'Point', coordinates: [-123, 40, 12] },
            properties: {
              title: 'M 4.8 test',
              url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us-test',
              time: Date.parse('2026-10-12T00:00:00Z'),
              updated: Date.parse('2026-10-13T00:00:00Z'),
              tsunami: 1,
            },
          },
        ],
      }),
    );
    const event = decodeUsgs(bytes, 'usgs')[0]!;
    expect(event.effectiveFrom).toBe('2026-10-12T00:00:00.000Z');
    expect(event.publishedAt).toBe('2026-10-13T00:00:00.000Z');
    expect(event.category).toBe('environment');
    expect(event.summary).toContain('地震');
    expect(event.raw).toMatchObject({ depthKm: 12, tsunamiFlagIsNotWarning: true });
    expect(event.relations?.[0]?.geometry).toEqual({ type: 'Point', coordinates: [-123, 40] });
  });
  it('stores requested marine points separately from provider grid and does not invent model publication time', () => {
    const source = publicIntelligenceSources.find((s) => s.adapter === 'marine')!;
    const values = MARINE_SAMPLE_POINTS.map((p) => ({
      latitude: p.lat + 0.05,
      longitude: p.lon + 0.05,
      hourly_units: { wave_height: 'm', wave_direction: '°', wave_period: 's' },
      hourly: {
        time: [1791849600, 1791853200],
        wave_height: [1.2, null],
        wave_direction: [180, null],
        wave_period: [5, null],
      },
    }));
    const result = decodeMarineForecasts(
      Buffer.from(JSON.stringify(values)),
      source,
      'a'.repeat(64),
      '2026-10-13T00:00:00.000Z',
    );
    expect(result).toHaveLength(6);
    expect(result[0]).toMatchObject({
      samplePointId: 'bohai',
      point: { lon: 120, lat: 39 },
      grid: { lon: 120.05, lat: 39.05 },
      modelPublishedAt: null,
    });
    expect(result[0]!.series[1]!.waveHeight).toBeNull();
    values[1]!.hourly.wave_height = [2];
    expect(() =>
      decodeMarineForecasts(
        Buffer.from(JSON.stringify(values)),
        source,
        'a'.repeat(64),
        '2026-10-13T00:00:00.000Z',
      ),
    ).toThrow('hourly');
  });
});
