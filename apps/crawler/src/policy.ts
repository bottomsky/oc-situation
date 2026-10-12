import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import type { RequestBudget } from './budget';
export interface UrlPolicy {
  allowedHosts: string[];
  developmentFixture?: boolean;
  resolve?: (host: string) => Promise<string[]>;
  onRequest?: () => void;
  budget?: RequestBudget;
  timeoutSeconds?: number;
}
export function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    // Only global unicast IPv6 is accepted; mapped IPv4 is checked separately.
    if (lower.startsWith('::ffff:')) return privateAddress(lower.slice(7));
    return !/^[23][0-9a-f]{3}:/.test(lower);
  }
  return true;
}
const resolveHost = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
const fixtureAllowed = (url: URL, options: UrlPolicy) =>
  options.developmentFixture &&
  url.hostname === '127.0.0.1' &&
  url.port === '13002' &&
  url.protocol === 'http:';
export async function assertAllowedUrl(input: string, options: UrlPolicy): Promise<URL> {
  const url = new URL(input);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Unsupported URL');
  if (!options.allowedHosts.includes(url.hostname)) throw new Error('Host is not registered');
  if (fixtureAllowed(url, options)) return url;
  if (url.protocol !== 'https:' || (url.port && url.port !== '443'))
    throw new Error('Private network target or unsupported port');
  const addresses = isIP(url.hostname)
    ? [url.hostname]
    : await (options.resolve ?? resolveHost)(url.hostname);
  if (!addresses.length || addresses.some(privateAddress))
    throw new Error('Private network target');
  return url;
}
/** Resolve and pin each outgoing connection. Redirect targets repeat the same policy. */
export async function safeRequest(
  input: string,
  options: UrlPolicy,
  signal?: AbortSignal,
  redirects = 0,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; url: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await requestOnce(input, options, signal, redirects);
      if (result.status !== 429 && result.status < 500) return result;
      if (attempt >= 3) throw new Error(`Source HTTP ${result.status}; retry budget exhausted`);
      const header = result.headers['retry-after'];
      const seconds = header === undefined ? NaN : Number(header);
      const retry = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header ?? '') - Date.now();
      await delay(result.status === 429 ? Math.max(0, Number.isFinite(retry) ? retry : 1000) : 1000 * 2 ** attempt, undefined, { signal });
    } catch (error) {
      if (signal?.aborted || attempt >= 3 || (error instanceof Error && /Private|Unsupported|registered|Redirect|byte limit|retry budget/.test(error.message))) throw error;
      await delay(1000 * 2 ** attempt, undefined, { signal });
    }
  }
}
async function requestOnce(
  input: string,
  options: UrlPolicy,
  signal?: AbortSignal,
  redirects = 0,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer; url: string }> {
  const url = await assertAllowedUrl(input, options);
  const addresses = fixtureAllowed(url, options)
    ? ['127.0.0.1']
    : isIP(url.hostname)
      ? [url.hostname]
      : await (options.resolve ?? resolveHost)(url.hostname);
  if (!fixtureAllowed(url, options) && addresses.some(privateAddress))
    throw new Error('Private network target');
  const pinned = addresses[0];
  if (!pinned) throw new Error('DNS target missing');
  const requestCall = () => new Promise<{
    status: number;
    headers: Record<string, string>;
    body: Buffer;
    url: string;
  }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      {
        signal,
        timeout: (options.timeoutSeconds ?? 30) * 1000,
        headers: { 'user-agent': 'AIS-Authorized-Collector/1.0', 'accept-encoding': 'identity' },
        lookup: (_host, opts, callback) => {
          if (opts.all) callback(null, [{ address: pinned, family: isIP(pinned) }]);
          else callback(null, pinned, isIP(pinned));
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 10_485_760) request.destroy(new Error('Response exceeds byte limit'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 500,
            headers: Object.fromEntries(
              Object.entries(response.headers).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string',
              ),
            ),
            body: Buffer.concat(chunks),
            url: url.href,
          }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('Request timeout')));
    request.on('error', reject);
    options.onRequest?.();
    request.end();
  });
  const result = options.budget ? await options.budget.run(requestCall, signal) : await requestCall();
  if (result.status >= 300 && result.status < 400 && result.headers.location) {
    if (redirects >= 5) throw new Error('Redirect limit exceeded');
    return safeRequest(new URL(result.headers.location, url).href, options, signal, redirects + 1);
  }
  return result;
}
