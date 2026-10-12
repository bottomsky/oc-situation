import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import {
  CheerioCrawler,
  Configuration,
  Log,
  LogLevel,
  PlaywrightCrawler,
  RequestQueue,
  RobotsTxtFile,
} from 'crawlee';
import { load } from 'cheerio';
import { SourceSettingsSchema, type SourceConfig } from '@ais/contracts';
import { assertAllowedUrl, safeRequest, type UrlPolicy } from './policy';
import { RequestBudget } from './budget';
export interface CrawlOptions {
  source: SourceConfig;
  runId: string;
  production: boolean;
  signal: AbortSignal;
  publish: (payload: unknown, format: 'json' | 'html' | 'text', rendered: boolean) => Promise<void>;
  checkpoint: (url: string) => Promise<void>;
  onRequest?: () => void;
}
export class CrawlAuthorizationError extends Error {}

export async function crawlSource(options: CrawlOptions): Promise<void> {
  const { source, runId } = options;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(Number(process.env.CRAWL_RUN_TIMEOUT_SECONDS ?? 900) * 1000)]);
  if (source.status !== 'enabled') throw new Error('Source is not enabled');
  if (!source.sourceKind.startsWith('fixture-'))
    throw new Error('Crawler requires an authorized fixture source');
  if (options.production) throw new Error('Fixture sources are disabled in production');
  if (!source.endpoint) throw new Error('Source endpoint is missing');
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(runId)) throw new Error('Unsafe run id');
  const settings = SourceSettingsSchema.parse(source.settings ?? {});
  const policy: UrlPolicy = {
    allowedHosts: settings.allowedHosts,
    developmentFixture: !options.production,
    onRequest: options.onRequest,
    budget: new RequestBudget(settings.requestsPerMinute, settings.httpConcurrency),
    timeoutSeconds: settings.timeoutSeconds,
  };
  await assertAllowedUrl(source.endpoint, policy);
  const config = new Configuration({
    purgeOnStart: false,
    persistStorage: true,
    storageClientOptions: { localDataDirectory: resolve('.data', 'crawlee', runId) },
  });
  const queue = await RequestQueue.open('requests', { config });
  let enqueued = 1;
  let failure: Error | null = null;
  let stopped = false;
  const robots = new Map<string, RobotsTxtFile>();
  const navigationErrors = new Map<string, Error>();
  const allowedByRobots = async (url: string) => {
    const location = new URL('/robots.txt', url).href;
    if (!robots.has(location)) {
      const response = await safeRequest(location, policy, signal);
      if (response.status === 401 || response.status === 403)
        throw new CrawlAuthorizationError('Robots authorization rejected');
      if (response.status === 429 || response.status >= 500)
        throw new Error('Robots temporarily unavailable');
      robots.set(
        location,
        RobotsTxtFile.from(location, response.status === 404 ? '' : response.body.toString('utf8')),
      );
    }
    if (!robots.get(location)!.isAllowed(url, 'AIS-Authorized-Collector'))
      throw new Error('Robots policy disallows URL');
  };
  const enqueue = async (url: string) => {
    if (enqueued >= settings.maxPages) throw new Error('Crawl page limit exceeded');
    await assertAllowedUrl(url, policy);
    await allowedByRobots(url);
    const added = await queue.addRequest({
      url,
      uniqueKey: `${runId}:${url}`,
      skipNavigation: source.sourceKind === 'fixture-http',
    });
    if (!added.wasAlreadyPresent) enqueued++;
  };
  const checkStatus = async (status: number, headers: Record<string, string>) => {
    if (status === 401 || status === 403)
      throw new CrawlAuthorizationError('Source authorization rejected');
    if (status === 429) {
      const retry = Number(headers['retry-after']);
      const milliseconds = Math.min(
        60_000,
        Math.max(
          1000,
          Number.isFinite(retry)
            ? retry * 1000
            : Date.parse(headers['retry-after'] ?? '') - Date.now() || 1000,
        ),
      );
      await delay(milliseconds, undefined, { signal });
      throw new Error('Source rate limited');
    }
    if (status >= 400) throw new Error(`Source HTTP ${status}`);
  };
  const published = async (
    body: string,
    contentType: string,
    url: string,
    rendered: boolean,
    status = 200,
    headers: Record<string, string> = {},
  ) => {
    if (Buffer.byteLength(body) > 10_485_760) throw new Error('Response exceeds byte limit');
    let payload: unknown = body;
    let format: 'json' | 'html' | 'text' = contentType.includes('html') ? 'html' : 'text';
    if (contentType.includes('json')) {
      try {
        payload = JSON.parse(body);
        format = 'json';
      } catch {
        /* Preserve malformed JSON as a raw text artifact. */
      }
    }
    await options.publish(payload, format, rendered);
    await checkStatus(status, headers);
    await options.checkpoint(url);
    const next =
      format === 'json'
        ? (payload as { next?: unknown }).next
        : load(body)('a[rel="next"]').attr('href');
    if (typeof next === 'string' && next) await enqueue(new URL(next, url).href);
  };
  const common = {
    requestQueue: queue,
    maxRequestsPerCrawl: settings.maxPages,
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: settings.timeoutSeconds,
    useSessionPool: false,
    retryOnBlocked: false,
    log: new Log({ level: LogLevel.OFF }),
    failedRequestHandler: async (_context: unknown, error: Error) => {
      failure ??= new Error(
        error.message.replace(/https?:\/\/[^\s]+/g, '[source-url]').slice(0, 500),
      );
    },
  };
  const crawler =
    source.sourceKind === 'fixture-http'
      ? new CheerioCrawler(
          {
            ...common,
            maxConcurrency: settings.httpConcurrency,
            requestHandler: async ({ request }) => {
              if (signal.aborted || stopped) throw new Error('Crawl interrupted');
              try {
                await allowedByRobots(request.url);
                const response = await safeRequest(request.url, policy, signal);
                await published(
                  response.body.toString('utf8'),
                  response.headers['content-type'] ?? 'text/plain',
                  response.url,
                  false,
                  response.status,
                  response.headers,
                );
              } catch (error) {
                if (error instanceof CrawlAuthorizationError) {
                  request.noRetry = true;
                  stopped = true;
                  failure = error;
                }
                throw error;
              }
            },
          },
          config,
        )
      : new PlaywrightCrawler(
          {
            ...common,
            maxConcurrency: settings.browserConcurrency,
            navigationTimeoutSecs: settings.timeoutSeconds,
            launchContext: { launchOptions: { headless: true } },
            browserPoolOptions: { useFingerprints: false, prePageCreateHooks: [(_pageId, _browserController, pageOptions) => { if (pageOptions) pageOptions.serviceWorkers = 'block'; }] },
            preNavigationHooks: [
              async ({ page, request }) => {
                navigationErrors.delete(request.uniqueKey);
                await allowedByRobots(request.url);
                let requests = 0;
                let bytes = 0;
                await page.route('**/*', async (route) => {
                  try {
                    if (signal.aborted || stopped) throw new Error('Crawl interrupted');
                    if (++requests > 100) throw new Error('Browser resource count exceeded');
                    const url = route.request().url();
                    await assertAllowedUrl(url, policy);
                    const response = await safeRequest(url, policy, signal);
                    bytes += response.body.length;
                    if (bytes > 30_000_000) throw new Error('Browser page byte limit exceeded');
                    if (response.status === 401 || response.status === 403) {
                      await options.publish(response.body.toString('utf8'), 'text', false);
                      stopped = true;
                      failure = new CrawlAuthorizationError('Source authorization rejected');
                      request.noRetry = true;
                      throw failure;
                    }
                    await checkStatus(response.status, response.headers);
                    await route.fulfill({
                      status: response.status,
                      headers: response.headers,
                      body: response.body,
                    });
                  } catch (error) {
                    navigationErrors.set(
                      request.uniqueKey,
                      error instanceof Error ? error : new Error('Browser request blocked'),
                    );
                    await route.abort('blockedbyclient');
                  }
                });
              },
            ],
            requestHandler: async ({ page, request }) => {
              if (failure || stopped || signal.aborted || navigationErrors.has(request.uniqueKey))
                throw (
                  failure ??
                  navigationErrors.get(request.uniqueKey) ??
                  new Error('Crawl interrupted')
                );
              await page.waitForSelector('script#ais-data[type="application/json"]', {
                state: 'attached',
                timeout: settings.timeoutSeconds * 1000,
              });
              await published(await page.content(), 'text/html', request.url, true);
            },
          },
          config,
        );
  const abort = () => {
    stopped = true;
    void crawler.autoscaledPool?.abort();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await allowedByRobots(source.endpoint);
    await queue.addRequest({
      url: source.endpoint,
      uniqueKey: `${runId}:${source.endpoint}`,
      skipNavigation: source.sourceKind === 'fixture-http',
    });
    await crawler.run();
    if (failure) throw failure;
    if (signal.aborted) throw new Error('Crawl interrupted');
  } finally {
    signal.removeEventListener('abort', abort);
    await crawler.teardown();
  }
}
