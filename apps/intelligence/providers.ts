import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import {
  IntelligenceInputSchema,
  type IntelligenceInput,
  type IntelligenceSource,
} from '../../packages/contracts/intelligence';
import {
  GeometrySchema,
  type IntelligenceGeometry,
} from '../../packages/contracts/intelligence-spatial';
import { safeRequest } from '../crawler/src/policy';
import { RequestBudget } from '../crawler/src/budget';
import {
  MARINE_SAMPLE_POINTS,
  MarineForecastSnapshotSchema,
  type MarineForecastSnapshot,
} from '../../packages/contracts/intelligence-search';

export interface CapturedDocument {
  url: string;
  requestedUrl?: string;
  body: Buffer;
  contentType: string;
}
export interface ProviderResult {
  events: IntelligenceInput[];
  pending: { url: string; reason: string; title: string }[];
  failures: { url: string; reason: string }[];
}
type Archive = (document: CapturedDocument) => Promise<void>;
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Source-local calendar dates are China standard time; GDACS timestamps are UTC. */
export function parseSourceTime(value: unknown, utc = false): string | null {
  if (typeof value !== 'string') return null;
  const match = value
    .trim()
    .match(
      /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日)?(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?(Z|[+-]\d{2}:\d{2})?$/,
    );
  if (!match) return null;
  const [, y, m, d, h = '00', min = '00', sec = '00', zone] = match;
  const iso = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}T${h.padStart(2, '0')}:${min}:${sec}${zone ?? (utc ? 'Z' : '+08:00')}`;
  const date = new Date(iso);
  if (
    !Number.isFinite(date.getTime()) ||
    Number(m) < 1 ||
    Number(m) > 12 ||
    Number(d) < 1 ||
    Number(d) > new Date(Date.UTC(Number(y), Number(m), 0)).getUTCDate() ||
    Number(h) > 23 ||
    Number(min) > 59 ||
    Number(sec) > 59
  )
    return null;
  return date.toISOString();
}

/** Parse explicit N/E or Chinese hemisphere coordinates. Bare number pairs never become locations. */
export function extractCoordinates(text: string): [number, number][] {
  text = text.replace(
    /(北纬|南纬|东经|西经)\s*(\d{1,3}(?:\.\d+)?(?:\s*[°度-]\s*\d{1,2}(?:\.\d+)?(?:\s*['′分]\s*\d{1,2}(?:\.\d+)?\s*["″秒]?)?\s*['′分]?)?)/g,
    '$2$1',
  );
  const values: { value: number; axis: 'lat' | 'lon'; index: number }[] = [];
  const pattern =
    /(?<![\d.])(\d{1,3}(?:\.\d+)?)(?:\s*[°度-]\s*(\d{1,2}(?:\.\d+)?)(?:\s*['′分]\s*(\d{1,2}(?:\.\d+)?)\s*["″秒]?)?\s*['′分]?)?\s*(N|S|E|W|北纬|南纬|东经|西经)(?![a-z])/gi;
  for (const m of text.matchAll(pattern)) {
    const degrees = Number(m[1]),
      minutes = Number(m[2] ?? 0),
      seconds = Number(m[3] ?? 0);
    const hemi = m[4]!.toUpperCase();
    const axis = /N|S|纬/.test(hemi) ? 'lat' : 'lon';
    const value = (degrees + minutes / 60 + seconds / 3600) * (/S|W|南|西/.test(hemi) ? -1 : 1);
    if (minutes >= 60 || seconds >= 60 || Math.abs(value) > (axis === 'lat' ? 90 : 180)) continue;
    values.push({ value, axis, index: m.index! });
  }
  values.sort((a, b) => a.index - b.index);
  const points: [number, number][] = [];
  for (let i = 0; i < values.length - 1; i++) {
    const a = values[i]!,
      b = values[i + 1]!;
    if (a.axis === b.axis || b.index - a.index > 100) continue;
    points.push(a.axis === 'lat' ? [b.value, a.value] : [a.value, b.value]);
    i++;
  }
  return points;
}

function base(
  sourceId: string,
  url: string,
  title: string,
  text: string,
  publishedAt: string,
  effectiveFrom: string,
): IntelligenceInput {
  return IntelligenceInputSchema.parse({
    sourceId,
    externalId: hash(url),
    version: 1,
    status: 'active',
    category: 'navigation-warning',
    title: title.slice(0, 500),
    summary: text.slice(0, 10000),
    publishedAt,
    effectiveFrom,
    effectiveTo: null,
    originalUrl: url,
    reviewStatus: 'candidate',
    paragraphs: [{ id: 'p1', text: text.slice(0, 20000) }],
    raw: { publisherUrl: url, extractor: 'maritime-rules-v1' },
    relations: [],
  });
}

export function decodeMaritimeHtml(
  bytes: Buffer,
  sourceId: string,
  url: string,
): IntelligenceInput | { title: string; reason: string } {
  const $ = load(bytes.toString('utf8'));
  $('script,style').remove();
  const title = clean(
    $('meta[name="ArticleTitle"]').attr('content') ??
      ($('#title').text() || $('h1').first().text()),
  );
  const content =
    $('.article').last().text() ||
    $('#ch_p').text() ||
    $('.article-content,.content,.TRS_Editor,#content').last().text();
  const text = clean(content);
  const published = parseSourceTime(
    $('meta[name="PubDate"]').attr('content') ??
      $('body')
        .text()
        .match(/发布时间[：:\s]+(\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?)/)?.[1],
  );
  if (!title || !text)
    return { title: title || '未识别正文', reason: '正文或标题缺失，保留原文供人工结构化' };
  if (!published) return { title, reason: '缺少可验证发布时间，保留原文候选，等待人工补充' };
  // Only explicit full calendar effective time is adopted. Publication is retained separately.
  const interval = text.match(
    /(?:自|从|时间[：:]?|于)\s*(\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)\s*(?:至|到|—|–|-)\s*(\d{4}年\d{1,2}月\d{1,2}日(?:\s+\d{1,2}:\d{2})?)/,
  );
  const effective = parseSourceTime(interval?.[1]);
  const event = base(sourceId, url, title, text, published, effective ?? published);
  event.raw = {
    ...(event.raw as Record<string, unknown>),
    effectiveTimeBasis: effective ? 'explicit-operation-interval' : 'publication-observation-only',
    requiresEffectiveTimeReview: !effective,
  };
  const end = parseSourceTime(interval?.[2]);
  if (end && effective && end >= effective) event.effectiveTo = end;
  const points = extractCoordinates(text);
  if (points.length)
    event.relations = [
      {
        kind: 'applies-to',
        geometry:
          points.length === 1
            ? { type: 'Point', coordinates: points[0]! }
            : { type: 'MultiPoint', coordinates: points },
        basis: '原文公告坐标；适用位置、作业边界和时间等待人工确认',
        paragraphIds: ['p1'],
        reviewStatus: 'candidate',
        origin: 'source',
      },
    ];
  return event;
}

export function maritimeLinks(bytes: Buffer, endpoint: string, max: number): string[] {
  const $ = load(bytes.toString('utf8'));
  const links: string[] = [];
  $('a[href]').each((_, e) => {
    const href = $(e).attr('href')!;
    const label = $(e).text();
    const url = new URL(href, endpoint);
    if (url.hostname !== new URL(endpoint).hostname || url.protocol !== 'https:') return;
    if (
      /zj\.msa/.test(url.hostname)
        ? /\/hxjg\/\d{6}\/t\d+_\d+\.html$/.test(url.pathname)
        : /沪航警/.test(label) && /\/article\/.*\.html$/.test(url.pathname)
    )
      links.push(url.href);
  });
  return [...new Set(links)].slice(0, max);
}

export function decodeGdacs(
  bytes: Buffer,
  sourceId: string,
  options: Pick<IntelligenceSource, 'bbox' | 'eventTypes'> = {},
): IntelligenceInput[] {
  const parsed = JSON.parse(bytes.toString('utf8')) as { type?: string; features?: unknown[] };
  const features = parsed.type === 'FeatureCollection' ? parsed.features : [parsed];
  if (!Array.isArray(features) || features.length > 1000)
    throw new Error('Invalid GDACS feature collection');
  const events: IntelligenceInput[] = [];
  for (const unknownFeature of features) {
    const f = unknownFeature as { geometry?: unknown; properties?: Record<string, unknown> };
    const p = f.properties;
    if (
      !p ||
      !(options.eventTypes ?? ['TC', 'TS', 'FL']).includes(
        String(p.eventtype) as 'TC' | 'TS' | 'FL',
      )
    )
      continue;
    const result = GeometrySchema.safeParse(f.geometry);
    if (!result.success) continue;
    const geometry = result.data;
    if (geometry.type !== 'Point') continue;
    const [lon, lat] = geometry.coordinates;
    if (options.bbox) {
      const [west, south, east, north] = options.bbox;
      if (
        lat < south ||
        lat > north ||
        (west <= east ? lon < west || lon > east : lon < west && lon > east)
      )
        continue;
    }
    const start = parseSourceTime(p.fromdate, true),
      end = parseSourceTime(p.todate, true),
      published = parseSourceTime(p.datemodified, true);
    if (!start || !published) continue;
    const url = `https://www.gdacs.org/report.aspx?eventtype=${p.eventtype}&eventid=${p.eventid}`;
    const event = base(
      sourceId,
      url,
      String(p.name ?? p.eventname),
      clean(String(p.description ?? p.name)),
      published,
      start,
    );
    event.category = p.eventtype === 'FL' ? 'environment' : 'weather';
    event.effectiveTo = end && end >= start ? end : null;
    event.externalId = `${p.eventtype}:${p.eventid}`;
    event.raw = {
      provider: 'GDACS',
      properties: p,
      geometry,
      timeBasis: 'effective',
      publishedTimeBasis: 'provider-updated',
    };
    event.relations = [
      {
        kind: 'occurs-at',
        geometry,
        basis: 'GDACS事件中心点；该点不等同于风暴覆盖面、航行限制或船舶实际影响',
        paragraphIds: ['p1'],
        reviewStatus: 'confirmed',
        origin: 'source',
      },
    ];
    events.push(event);
  }
  return events;
}

export function decodeRss(
  bytes: Buffer,
  sourceId: string,
  endpoint: string,
  observedAt = new Date().toISOString(),
): ProviderResult {
  const $ = load(bytes.toString('utf8'), { xmlMode: true });
  if (!$('rss,feed').length) throw new Error('Expected RSS or Atom feed');
  const entries = $('item,entry');
  if (entries.length > 1000) throw new Error('RSS feed exceeds 1000 entries');
  const result: ProviderResult = { events: [], pending: [], failures: [] };
  entries.each((_, item) => {
    const entry = $(item);
    const title = clean(entry.children('title').first().text());
    const rawLink =
      entry.children('link[rel="alternate"]').attr('href') ??
      entry.children('link').attr('href') ??
      entry.children('link').first().text();
    let url: string;
    try {
      const parsed = new URL(rawLink, endpoint);
      if (
        !rawLink ||
        !['http:', 'https:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        throw new Error();
      url = parsed.href;
    } catch {
      result.pending.push({
        url: endpoint,
        title: title || '未识别标题',
        reason: '条目缺少有效原文链接',
      });
      return;
    }
    if (!title) {
      result.pending.push({ url, title: '未识别标题', reason: '条目缺少标题' });
      return;
    }
    const description = entry.children('description,summary,content').first().text();
    const text = clean(load(description).text()) || title;
    const publication = entry.children('pubDate,published,issued').first().text().trim();
    const timestamp = publication ? Date.parse(publication) : NaN;
    const published = Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
    const event = base(
      sourceId,
      url,
      title,
      text,
      published ?? observedAt,
      published ?? observedAt,
    );
    event.externalId = hash(entry.children('guid,id').first().text().trim() || url);
    event.category = /\b(?:collision|accident|grounding)\b|船舶碰撞|船舶事故|海难/i.test(
      `${title} ${text}`,
    )
      ? 'incident'
      : 'other';
    event.raw = {
      provider: 'RSS',
      feedUrl: endpoint,
      observedAt,
      timeBasis: published ? 'publication' : 'unknown',
      publicationTimeKnown: !!published,
      requiresEffectiveTimeReview: true,
      effectiveTimeBasis: 'publication-observation-only',
    };
    result.events.push(event);
  });
  return result;
}

export function decodeUsgs(bytes: Buffer, sourceId: string): IntelligenceInput[] {
  const data = JSON.parse(bytes.toString('utf8')) as { type?: string; features?: unknown[] };
  if (
    data.type !== 'FeatureCollection' ||
    !Array.isArray(data.features) ||
    data.features.length > 1000
  )
    throw new Error('Invalid USGS GeoJSON feed');
  const events: IntelligenceInput[] = [];
  for (const item of data.features) {
    const feature = item as {
      id?: unknown;
      geometry?: { type?: unknown; coordinates?: unknown[] };
      properties?: Record<string, unknown>;
    };
    const p = feature.properties,
      coordinates = feature.geometry?.coordinates;
    if (
      !p ||
      typeof feature.id !== 'string' ||
      feature.geometry?.type !== 'Point' ||
      !Array.isArray(coordinates) ||
      coordinates.length < 2
    )
      continue;
    const geo = GeometrySchema.safeParse({ type: 'Point', coordinates: coordinates.slice(0, 2) });
    if (
      !geo.success ||
      typeof p.time !== 'number' ||
      !Number.isFinite(p.time) ||
      typeof p.updated !== 'number' ||
      !Number.isFinite(p.updated)
    )
      continue;
    if (Math.abs(p.time) > 8.64e15 || Math.abs(p.updated) > 8.64e15) continue;
    let url: string;
    try {
      const candidate = new URL(String(p.url));
      if (candidate.protocol !== 'https:' || candidate.hostname !== 'earthquake.usgs.gov') continue;
      url = candidate.href;
    } catch {
      continue;
    }
    const title = String(p.title ?? p.place ?? 'USGS 地震事件');
    const event = base(
      sourceId,
      url,
      title,
      `USGS 地震事件：${title}。该位置为震中，不能据此推定海啸或船舶受影响。`,
      new Date(p.updated).toISOString(),
      new Date(p.time).toISOString(),
    );
    event.externalId = feature.id;
    event.category = 'environment';
    event.reviewStatus = 'confirmed';
    event.raw = {
      provider: 'USGS',
      properties: p,
      depthKm: coordinates[2] ?? null,
      timeBasis: 'effective',
      publishedTimeBasis: 'provider-updated',
      tsunamiFlagIsNotWarning: true,
    };
    event.relations = [
      {
        kind: 'occurs-at',
        geometry: geo.data,
        basis: 'USGS震中坐标；不代表海啸覆盖范围或航行限制',
        paragraphIds: ['p1'],
        reviewStatus: 'confirmed',
        origin: 'source',
      },
    ];
    events.push(event);
  }
  return events;
}

export function decodeMarineForecasts(
  bytes: Buffer,
  source: IntelligenceSource,
  archiveId: string,
  fetchedAt: string,
  originalUrl = source.endpoint!,
): MarineForecastSnapshot[] {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(parsed) || parsed.length !== MARINE_SAMPLE_POINTS.length)
    throw new Error('Marine response must contain six sample points');
  const endpoint = new URL(source.endpoint!);
  const latitudes = endpoint.searchParams.get('latitude')?.split(',').map(Number);
  const longitudes = endpoint.searchParams.get('longitude')?.split(',').map(Number);
  if (
    !MARINE_SAMPLE_POINTS.every(
      (point, index) => latitudes?.[index] === point.lat && longitudes?.[index] === point.lon,
    )
  )
    throw new Error('Marine endpoint sample coordinates do not match registered points');
  return parsed.map((raw, index) => {
    const item = raw as {
      latitude?: number;
      longitude?: number;
      hourly?: Record<string, unknown>;
      hourly_units?: Record<string, unknown>;
    };
    const point = MARINE_SAMPLE_POINTS[index]!;
    if (
      typeof item.latitude !== 'number' ||
      typeof item.longitude !== 'number' ||
      Math.abs(item.latitude - point.lat) > 2 ||
      Math.abs(item.longitude - point.lon) > 2
    )
      throw new Error('Marine grid coordinates differ from sample point');
    const hourly = item.hourly;
    const times = hourly?.time;
    if (!Array.isArray(times) || !times.length || times.length > 384)
      throw new Error('Invalid marine hourly series');
    if (
      item.hourly_units?.wave_height !== 'm' ||
      item.hourly_units?.wave_direction !== '°' ||
      item.hourly_units?.wave_period !== 's'
    )
      throw new Error('Unsupported marine forecast units');
    const values = (field: string, min: number, max: number) => {
      const values = hourly?.[field];
      if (
        !Array.isArray(values) ||
        values.length !== times.length ||
        values.some(
          (value) =>
            value !== null &&
            (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max),
        )
      )
        throw new Error('Invalid marine hourly values');
      return values as (number | null)[];
    };
    const height = values('wave_height', 0, 100),
      direction = values('wave_direction', 0, 360),
      period = values('wave_period', 0, 200);
    const series = times.map((time, i) => {
      if (typeof time !== 'number' || !Number.isFinite(time) || Math.abs(time) > 8.64e12)
        throw new Error('Expected UTC unix marine forecast times');
      return {
        validAt: new Date(time * 1000).toISOString(),
        waveHeight: height[i]!,
        waveDirection: direction[i]!,
        wavePeriod: period[i]!,
      };
    });
    if (series.some((hour, i) => i > 0 && hour.validAt <= series[i - 1]!.validAt))
      throw new Error('Marine forecast times must increase');
    return MarineForecastSnapshotSchema.parse({
      id: hash(`${source.sourceId}:${point.id}:${archiveId}:${fetchedAt}`),
      sourceId: source.sourceId,
      samplePointId: point.id,
      pointName: point.name,
      point: { lon: point.lon, lat: point.lat },
      grid: { lon: item.longitude, lat: item.latitude },
      fetchedAt,
      modelPublishedAt: null,
      validFrom: series[0]!.validAt,
      validTo: series.at(-1)!.validAt,
      series,
      originalArchiveId: archiveId,
      originalUrl,
      visibility: source.visibility,
    });
  });
}

export function decodeGdelt(
  bytes: Buffer,
  sourceId: string,
  endpoint: string,
): IntelligenceInput[] {
  const data = JSON.parse(bytes.toString('utf8')) as {
    articles?: Record<string, unknown>[];
    features?: { geometry: unknown; properties: Record<string, unknown> }[];
  };
  if (data && typeof data === 'object' && Object.keys(data).length === 0)
    throw new Error(
      'GDELT HTTP 200 empty object: no parseable articles obtained; empty-result meaning unverified',
    );
  if (!Array.isArray(data.articles))
    throw new Error(
      'Expected GDELT DOC ArtList JSON; GEO place mentions require separate evidence review',
    );
  if (data.articles.length > 1000) throw new Error('GDELT feed exceeds limit');
  return data.articles.flatMap((a) => {
    if (typeof a.url !== 'string' || !/^https:\/\//.test(a.url) || typeof a.title !== 'string')
      return [];
    const seen = String(a.seendate ?? '').replace(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
      '$1-$2-$3T$4:$5:$6Z',
    );
    const time = parseSourceTime(seen, true);
    if (!time) return [];
    const event = base(sourceId, a.url, a.title, a.title, time, time);
    event.category = 'other';
    // seendate is index observation time, never asserted as occurrence/effective time.
    event.raw = {
      provider: 'GDELT',
      feedUrl: endpoint,
      articleUrl: a.url,
      seendate: a.seendate,
      timeBasis: 'provider-index-observation-only',
      requiresOccurrenceTimeReview: true,
    };
    return [event];
  });
}

export async function collectProvider(
  source: IntelligenceSource,
  archive: Archive,
  signal?: AbortSignal,
): Promise<ProviderResult> {
  if (!source.endpoint || !source.authorizationConfirmed)
    throw new Error('Authorized network endpoint required');
  const budget = new RequestBudget(source.requestsPerMinute ?? 6, 1);
  const capture = async (url: string) => {
    const r = await safeRequest(
      url,
      { allowedHosts: source.allowedHosts, timeoutSeconds: source.timeoutSeconds, budget },
      signal,
    );
    await archive({
      url: r.url,
      requestedUrl: url,
      body: r.body,
      contentType: r.headers['content-type'] ?? 'application/octet-stream',
    });
    if (r.status !== 200) throw new Error(`Provider HTTP ${r.status}`);
    return r;
  };
  const first = await capture(source.endpoint);
  const result: ProviderResult = { events: [], pending: [], failures: [] };
  if (source.adapter === 'gdacs') {
    result.events = decodeGdacs(first.body, source.sourceId, source);
    return result;
  }
  if (source.adapter === 'gdelt') {
    result.events = decodeGdelt(first.body, source.sourceId, source.endpoint);
    return result;
  }
  if (source.adapter === 'rss' || source.kind === 'rss')
    return decodeRss(first.body, source.sourceId, source.endpoint);
  if (source.adapter === 'usgs') {
    result.events = decodeUsgs(first.body, source.sourceId);
    return result;
  }
  for (const url of maritimeLinks(first.body, source.endpoint, source.maxDocuments ?? 5)) {
    try {
      const r = await capture(url);
      const decoded = decodeMaritimeHtml(r.body, source.sourceId, url);
      if ('reason' in decoded) result.pending.push({ url, ...decoded });
      else result.events.push(decoded);
    } catch (error) {
      result.failures.push({
        url,
        reason: error instanceof Error ? error.message : 'Document failed',
      });
    }
  }
  return result;
}

/** Ignore local version/archive/review metadata when comparing source semantic content. */
export function semanticChecksum(event: IntelligenceInput): string {
  const raw =
    event.raw && typeof event.raw === 'object'
      ? { ...(event.raw as Record<string, unknown>) }
      : event.raw;
  if (raw && typeof raw === 'object')
    delete (raw as Record<string, unknown>).sourceSemanticChecksum;
  if (raw && typeof raw === 'object' && (raw as Record<string, unknown>).provider === 'RSS')
    delete (raw as Record<string, unknown>).observedAt;
  const fields = [
    'sourceId',
    'externalId',
    'category',
    'title',
    'summary',
    'publishedAt',
    'effectiveFrom',
    'effectiveTo',
    'bbox',
    'vesselTypes',
    'mmsis',
    'paragraphs',
    'commonSourceId',
    'originalUrl',
    'raw',
  ] as const;
  return hash(
    JSON.stringify([
      fields.map((key) => [
        key,
        key === 'raw'
          ? raw
          : raw &&
              typeof raw === 'object' &&
              (raw as Record<string, unknown>).provider === 'RSS' &&
              (raw as Record<string, unknown>).publicationTimeKnown === false &&
              ['publishedAt', 'effectiveFrom'].includes(key)
            ? null
            : event[key],
      ]),
      (event.relations ?? [])
        .filter((r) => r.origin === 'source')
        .map(({ reviewStatus: _review, ...r }) => r),
    ]),
  );
}
export function nextRevision(
  incoming: IntelligenceInput,
  latest?: IntelligenceInput & { id: string },
): IntelligenceInput | null {
  const sourceChecksum = semanticChecksum(incoming);
  const stored =
    latest?.raw && typeof latest.raw === 'object'
      ? (latest.raw as Record<string, unknown>).sourceSemanticChecksum
      : undefined;
  if (latest && sourceChecksum === (typeof stored === 'string' ? stored : semanticChecksum(latest)))
    return null;
  incoming = {
    ...incoming,
    raw: { ...(incoming.raw as Record<string, unknown>), sourceSemanticChecksum: sourceChecksum },
  };
  return latest
    ? { ...incoming, version: latest.version + 1, status: 'revised', supersedesId: latest.id }
    : incoming;
}
export function geometryPoints(geometry: IntelligenceGeometry): [number, number][] {
  if (geometry.type === 'Point') return [geometry.coordinates];
  if (geometry.type === 'MultiPoint' || geometry.type === 'LineString') return geometry.coordinates;
  if (geometry.type === 'Polygon' || geometry.type === 'MultiLineString')
    return geometry.coordinates.flat();
  return geometry.coordinates.flat(2);
}
