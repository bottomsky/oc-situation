import { setTimeout as delay } from 'node:timers/promises';
export class FatalSourceError extends Error {}
export class CursorExpiredError extends Error {}
export function metadataWindow(page: unknown): { windowFrom: string; windowTo: string } | null {
  const metadata = (page as { METADATA?: Record<string, unknown> })?.METADATA;
  const utc = (value: unknown) => {
    if (typeof value !== 'string') return NaN;
    const complete = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
    return /(?:Z|[+-]\d\d:\d\d)$/.test(complete) ? Date.parse(complete) : NaN;
  };
  const from = utc(metadata?.DATE_FROM);
  const to = utc(metadata?.DATE_TO);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { windowFrom: new Date(from).toISOString(), windowTo: new Date(to).toISOString() } : null;
}
export function buildMarineTrafficUrl(
  key: string,
  limit: number,
  timespan: number,
  cursor?: string,
): string {
  const url = new URL(
    `https://services.marinetraffic.com/api/exportvessels/${encodeURIComponent(key)}`,
  );
  url.search = new URLSearchParams({
    v: '9',
    protocol: 'jsono',
    limit: String(limit),
    timespan: String(timespan),
    ...(cursor ? { cursor } : {}),
  }).toString();
  return url.href;
}
export async function readBoundedResponse(
  response: Response,
  maxBytes = 10_485_760,
): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel();
    throw new Error('Response exceeds byte limit');
  }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error('Response exceeds byte limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}
export function retryAfterMs(value: string | null): number {
  if (!value) return 1000;
  const seconds = Number(value);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Math.max(1000, Number.isFinite(wait) ? wait : 1000);
}
export async function fetchMarineTraffic(url: string, signal?: AbortSignal, options: {
  beforeAttempt?: () => Promise<void> | void;
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
} = {}): Promise<unknown> {
  const sleep = options.sleep ?? ((ms: number, stop?: AbortSignal) => delay(ms, undefined, { signal: stop }));
  for (let attempt = 0; attempt <= 3; attempt++) {
    await options.beforeAttempt?.();
    let response: Response;
    try {
      response = await (options.fetch ?? fetch)(url, {
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch {
      if (signal?.aborted) throw new Error('Collection interrupted');
      if (attempt === 3) throw new Error('MarineTraffic connection failed');
      await sleep(1000 * 2 ** attempt, signal);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new FatalSourceError('Provider authorization rejected');
    }
    if (
      (response.status === 400 || response.status === 410) &&
      new URL(url).searchParams.has('cursor')
    ) {
      await response.body?.cancel();
      throw new CursorExpiredError('Provider cursor expired');
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      if (attempt === 3) throw new Error(`Provider HTTP ${response.status}`);
      await sleep(
        response.status === 429
          ? retryAfterMs(response.headers.get('retry-after'))
          : 1000 * 2 ** attempt,
        signal,
      );
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Provider HTTP ${response.status}`);
    }
    const text = await readBoundedResponse(response);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Provider returned malformed JSON');
    }
  }
  throw new Error('Provider retry budget exhausted');
}
export async function collectPages(options: {
  fetchPage: (cursor?: string) => Promise<unknown>;
  publish: (page: unknown) => Promise<void>;
  checkpoint: (cursor: string | null, page: unknown) => Promise<void>;
  cursor?: string;
  maxPages?: number;
}): Promise<void> {
  let cursor = options.cursor;
  const seen = new Set<string>();
  for (let page = 0; page < (options.maxPages ?? 100); page++) {
    const result = await options.fetchPage(cursor);
    const envelope = result as { METADATA?: { CURSOR?: unknown }; CURSOR?: unknown };
    const nextValue = envelope.METADATA?.CURSOR ?? envelope.CURSOR;
    const next = typeof nextValue === 'string' && nextValue.length ? nextValue : null;
    await options.publish(result);
    await options.checkpoint(next, result);
    if (!next) return;
    if (seen.has(next)) throw new Error('Provider pagination cursor repeated');
    seen.add(next);
    cursor = next;
  }
  throw new Error('Provider page limit exceeded');
}
