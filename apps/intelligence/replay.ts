import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import type { IntelligenceInput } from '../../packages/contracts/intelligence';
import { publicIntelligenceSources } from './source-presets';
import { decodeGdacs, decodeMaritimeHtml } from './providers';

const Capture = z.object({
  file: z.string().max(200),
  url: z.string().url().max(2000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.string().max(200).optional(),
});
const Records = z
  .array(
    z.object({
      sourceId: z.string().max(200),
      capturedAt: z.string().datetime().optional(),
      captures: z.array(Capture).max(101).optional(),
      url: z.string().url().optional(),
      events: z.array(z.unknown()).max(1000).optional(),
    }),
  )
  .max(10);
export interface ReplayCapture {
  sourceId: string;
  url: string;
  body: Buffer;
  contentType: string;
  sha256: string;
  capturedAt: string;
  hashBasis: 'capture-manifest' | 'local-computed';
  events: IntelligenceInput[];
  pending?: string;
}
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
export function assertReplayCapture(
  sourceId: string,
  capture: { file: string; url: string; sha256: string },
  body: Buffer,
) {
  const source = publicIntelligenceSources.find((s) => s.sourceId === sourceId);
  if (!source || !['zhejiang-maritime', 'shanghai-maritime'].includes(sourceId))
    throw new Error('Replay source is not a registered maritime preset');
  if (
    !/^[a-f0-9]{64}$/.test(capture.sha256) ||
    capture.file !== `${sourceId}-${capture.sha256}.raw`
  )
    throw new Error('Replay filename must match declared source and SHA-256');
  const url = new URL(capture.url);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !source.allowedHosts.includes(url.hostname)
  )
    throw new Error('Replay URL is outside preset public hosts');
  if (digest(body) !== capture.sha256) throw new Error('Replay original byte checksum mismatch');
}
async function boundedFile(root: string, name: string) {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\'))
    throw new Error('Replay filename must be a basename');
  const path = await realpath(resolve(root, name));
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel))
    throw new Error('Replay file is outside validation directory');
  const details = await stat(path);
  if (!details.isFile() || details.size > 10_485_760)
    throw new Error('Replay file is invalid or exceeds byte limit');
  const bytes = await readFile(path);
  if (bytes.length > 10_485_760) throw new Error('Replay byte limit exceeded');
  return { bytes, details };
}
/** Read only bounded capture files, never execute captured HTML or accept paths from it. */
export async function loadReplayValidation(): Promise<ReplayCapture[]> {
  const root = await realpath(resolve('.data/intelligence-live-validation'));
  const manifest = await boundedFile(root, 'validation.json');
  const records = Records.parse(JSON.parse(manifest.bytes.toString('utf8')));
  const result: ReplayCapture[] = [];
  const seen = new Set<string>();
  for (const record of records.filter((r) =>
    ['zhejiang-maritime', 'shanghai-maritime'].includes(r.sourceId),
  ))
    for (const capture of record.captures ?? []) {
      // Check the filename before touching the filesystem, then recheck canonical confinement.
      if (capture.file !== `${record.sourceId}-${capture.sha256}.raw`)
        throw new Error('Replay capture filename mismatch');
      const { bytes, details } = await boundedFile(root, capture.file);
      assertReplayCapture(record.sourceId, capture, bytes);
      const url = new URL(capture.url);
      const detail =
        record.sourceId === 'zhejiang-maritime'
          ? /\/hxjg\/\d{6}\/t\d+_\d+\.html$/.test(url.pathname)
          : /\/html\/cnmsa\/hxaq\/article\/\d{4}\/[a-f0-9]+\.html$/.test(url.pathname);
      if (!detail) continue;
      const key = `${record.sourceId}:${capture.url}:${capture.sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const decoded = decodeMaritimeHtml(bytes, record.sourceId, capture.url);
      result.push({
        sourceId: record.sourceId,
        url: capture.url,
        body: bytes,
        contentType: capture.contentType ?? 'text/html',
        sha256: capture.sha256,
        capturedAt: record.capturedAt ?? details.mtime.toISOString(),
        hashBasis: 'capture-manifest',
        events: 'reason' in decoded ? [] : [decoded],
        ...('reason' in decoded ? { pending: decoded.reason } : {}),
      });
    }
  const history = records.find((r) => r.sourceId === 'gdacs-historical-validation');
  const historicalUrl =
    'https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=TC&eventid=1001090';
  if (history?.url === historicalUrl) {
    const { bytes, details } = await boundedFile(root, 'gdacs-yagi.raw');
    const events = decodeGdacs(bytes, 'gdacs-near-china');
    if (
      events.length !== 1 ||
      events[0]!.externalId !== 'TC:1001090' ||
      !events[0]!.effectiveFrom.startsWith('2024-09-')
    )
      throw new Error('Historical capture does not match recorded YAGI event');
    const prior = history.events?.[0] as IntelligenceInput | undefined;
    if (
      !prior ||
      prior.externalId !== events[0]!.externalId ||
      prior.effectiveFrom !== events[0]!.effectiveFrom ||
      JSON.stringify(prior.relations?.[0]?.geometry) !==
        JSON.stringify(events[0]!.relations?.[0]?.geometry)
    )
      throw new Error('Historical bytes disagree with validation metadata');
    result.push({
      sourceId: 'gdacs-near-china',
      url: historicalUrl,
      body: bytes,
      contentType: 'application/geo+json',
      sha256: digest(bytes),
      capturedAt: details.mtime.toISOString(),
      hashBasis: 'local-computed',
      events,
    });
  }
  if (!result.length) throw new Error('No verified original captures available');
  return result;
}
