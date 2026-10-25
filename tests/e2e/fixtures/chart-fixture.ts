import type { Page } from '@playwright/test';
import { chartPoint, chartResult, chartTopic, chartRun } from './chart-data';
import { configureOnlineChart } from './online-chart-fixture';
export async function chartFixture(
  page: Page,
  options: { role?: string; clusters?: boolean; onlineChart?: Record<string, unknown> } = {},
) {
  await configureOnlineChart(page, options.onlineChart);
  const calls = {
    liveConnections: 0,
    resultList: 0,
    resultDetail: 0,
    vesselDetail: 0,
    search: [] as URL[],
    runs: [] as string[],
    manual: 0,
    mapQueries: [] as URL[],
    viewportMessages: [] as { version: number; query: { hours: number; mode?: string } }[],
    sendLive: (message: unknown) => sendLive?.(JSON.stringify(message)),
  };
  let sendLive: ((message: string) => void) | undefined;
  await page.routeWebSocket('**/api/v1/live*', (ws) => {
    calls.liveConnections++;
    sendLive = (message) => ws.send(message);
    ws.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'viewport') calls.viewportMessages.push(message);
    });
  });
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json: unknown = {};
    if (path.endsWith('/auth/me'))
      json = {
        user: { id: 'fixture-user', username: '测试用户', role: options.role ?? 'admin' },
        csrfToken: 'fixture-csrf',
        expiresAt: '2099-01-01',
      };
    else if (path.endsWith('/agent/config'))
      json = {
        enabled: false,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/intelligence/events')) json = { items: [], nextCursor: null };
    else if (path.endsWith('/intelligence/objects')) json = { items: [] };
    else if (path.endsWith('/intelligence/plot-set')) json = { eventIds: [], hiddenEventIds: [] };
    else if (path.endsWith('/intelligence/plot'))
      json = { type: 'FeatureCollection', features: [], items: [] };
    else if (path.endsWith('/intelligence/sources')) json = [];
    else if (path.endsWith('/sources'))
      json = [
        {
          sourceId: 'fixture-ais',
          sourceKind: 'aisstream',
          name: 'AISStream',
          status: 'disabled',
          secretRef: null,
          priority: 1,
          lastReceivedAt: null,
          lastError: null,
        },
      ];
    else if (path.endsWith('/map') || path.endsWith('/map/points')) {
      calls.mapQueries.push(url);
      json = {
        items: options.clusters
          ? [
              {
                kind: 'cluster',
                clusterId: 'cluster-a',
                lat: 32,
                lon: 122,
                count: 20,
                bbox: [121, 31, 123, 33],
              },
            ]
          : [chartPoint],
        total: options.clusters ? 20 : 1,
        sampled: false,
        truncated: false,
        generatedAt: chartPoint.observedAt,
      };
      if (path.endsWith('/map/points') && !options.clusters)
        json = {
          ...(json as Record<string, unknown>),
          snapshotId: 'fixture-points',
          sequence: 1,
          nextCursor: null,
          complete: true,
          expiresAt: '2099-01-01T00:00:00Z',
        };
    } else if (path.endsWith('/analysis/feed')) json = { items: [], nextCursor: '0' };
    else if (path.endsWith('/analysis/results')) {
      calls.resultList++;
      json = { items: [chartResult] };
    } else if (path.endsWith('/revisions'))
      json = {
        items: [
          chartResult,
          { ...chartResult, revision: 1, status: 'active', title: '历史修订 1' },
        ],
      };
    else if (path.includes('/analysis/results/')) {
      calls.resultDetail++;
      json = chartResult;
    } else if (path.endsWith('/vessels')) {
      calls.search.push(url);
      json = {
        items: [
          {
            mmsi: chartPoint.mmsi,
            staticFields: { name: url.searchParams.get('query') || '夹具船舶' },
            latestPosition: chartPoint,
          },
        ],
        nextCursor: url.searchParams.has('cursor') ? null : 'page-2',
      };
    } else if (path.endsWith('/track'))
      json = {
        mmsi: chartPoint.mmsi,
        from: chartResult.from,
        to: chartResult.to,
        total: 2,
        returned: 2,
        sampled: false,
        truncated: false,
        segments: [
          {
            points: [
              { ...chartPoint, kind: 'position', receivedAt: chartPoint.observedAt },
              {
                ...chartPoint,
                kind: 'position',
                lon: 122.2,
                observedAt: '2026-10-01T00:31:00Z',
                receivedAt: chartPoint.observedAt,
              },
            ],
          },
        ],
      };
    else if (path.includes('/vessels/')) {
      calls.vesselDetail++;
      json = {
        mmsi: chartPoint.mmsi,
        staticFields: { name: '夹具船舶' },
        latestPosition: chartPoint,
        provenance: {},
      };
    } else if (path.endsWith('/topics/predictions')) json = { items: [], instances: [] };
    else if (path.endsWith('/topics')) json = { definitions: [], instances: [chartTopic] };
    else if (path.endsWith('/runs')) {
      calls.runs.push(path);
      json = { items: calls.manual ? [chartRun] : [] };
    } else if (path.endsWith('/run')) {
      calls.manual++;
      json = chartRun;
    }
    await route.fulfill({ json });
  });
  return calls;
}
