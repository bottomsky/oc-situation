import { openConsolePage } from './chart-helpers';
import { test, expect, type Page } from '@playwright/test';

const result = {
  id: 'fixture-result',
  instanceId: 'fixture-topic',
  definitionId: 'port-restriction',
  definitionVersion: '1.0.0',
  revision: 2,
  status: 'revised',
  title: '测试夹具：港区限制关联',
  summary: '测试夹具结论',
  mmsi: '413000001',
  documentId: 'fixture-doc',
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-01T01:00:00Z',
  bbox: [121, 29, 123, 31],
  confidence: 'rule-match',
  evidence: {
    ais: [
      {
        recordId: 'fixture-position',
        mmsi: '413000001',
        occurredAt: '2026-10-01T00:30:00Z',
        longitude: 122,
        latitude: 30,
        speedOverGround: 2,
        shipType: 70,
        raw: { fixture: true },
      },
    ],
    documents: [
      {
        id: 'fixture-doc',
        sourceId: 'fixture-notice',
        externalId: 'notice-1',
        version: 2,
        status: 'revised',
        title: '测试夹具公告',
        kind: 'port-restriction',
        effectiveFrom: '2026-10-01T00:00:00Z',
        effectiveTo: null,
        bbox: [121, 29, 123, 31],
        vesselTypes: [],
        mmsis: [],
        paragraphs: [{ id: 'paragraph-1', text: '测试夹具原文：港区临时限制通行。' }],
        raw: { fixture: true },
      },
    ],
    steps: [
      {
        id: 'rule-1',
        rule: '时间与空间交集',
        outcome: '观测点命中公告范围',
        references: ['fixture-position', 'paragraph-1'],
      },
    ],
    limitations: ['规则关联需人工复核'],
    parameters: {
      bbox: [121, 29, 123, 31],
      historyHours: 24,
      windowMinutes: 60,
      lowSpeedKnots: 3,
      minPositions: 3,
      scheduleSeconds: 60,
    },
    queriedAt: '2026-10-01T01:00:00Z',
  },
  createdAt: '2026-10-01T01:00:00Z',
  updatedAt: '2026-10-01T02:00:00Z',
};
async function fixture(page: Page, role = 'admin') {
  await page.routeWebSocket('**/api/v1/live*', (ws) => {
    ws.onMessage(() => {});
  });
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = {};
    if (path.endsWith('/auth/me'))
      json = {
        user: { id: 'fixture', username: '测试夹具', role },
        csrfToken: 'fixture-csrf',
        expiresAt: '2099-01-01',
      };
    else if (path.endsWith('/intelligence/sources'))
      json = [{ sourceId: 'fixture-notice', name: '测试夹具来源', kind: 'fixture', enabled: true }];
    else if (path.endsWith('/sources')) json = [];
    else if (path.endsWith('/map'))
      json = {
        items: [],
        total: 0,
        sampled: false,
        truncated: false,
        generatedAt: '2026-10-01T00:00:00Z',
      };
    else if (path.endsWith('/analysis/feed')) json = { items: [], nextCursor: '0' };
    else if (path.endsWith('/analysis/results')) json = { items: [result] };
    else if (path.endsWith('/revisions')) json = { items: [result] };
    else if (path.includes('/analysis/results/')) json = result;
    else if (path.endsWith('/topics'))
      json = {
        definitions: [
          {
            id: 'port-restriction',
            name: '港区限制影响',
            available: true,
            version: '1.0.0',
            description: '测试定义',
            requiredCapabilities: [],
          },
        ],
        instances: [],
      };
    else if (path.endsWith('/intelligence/plot'))
      json = { type: 'FeatureCollection', features: [], items: [] };
    else if (path.endsWith('/intelligence/plot-set')) json = { eventIds: [], hiddenEventIds: [] };
    else if (path.endsWith('/intelligence/objects')) json = { items: [] };
    else if (path.endsWith('/intelligence/events')) json = { items: [], nextCursor: null };
    else if (path.endsWith('/intelligence/archives')) json = { items: [], nextCursor: null };
    await route.fulfill({ json });
  });
}
test('专题结论打开可追溯证据并在海图标出关联位置', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await page
    .getByTestId('fusion-events')
    .getByRole('button', { name: '测试夹具：港区限制关联', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: '结论证据' })).toBeVisible();
  await expect(page.getByText('测试夹具原文：港区临时限制通行。')).toBeVisible();
  await expect(page.getByText('观测点命中公告范围')).toBeVisible();
  await expect(page.getByTestId('evidence-map-legend')).toContainText('证据点');
  await expect(page.getByText('fixture-position', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/fusion-evidence.png', fullPage: true });
});

test('公告导入拒绝无效JSON，合法公告按原文提交并保留来源', async ({ page }) => {
  await fixture(page);
  let payload: Record<string, unknown> | null = null;
  await page.route('**/api/v1/intelligence/events', async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({ json: { id: 'imported' } });
  });
  await page.goto('/intelligence');
  await page.getByRole('button', { name: 'JSON 导入', exact: true }).click();
  await page.getByLabel('公告 JSON').fill('{bad');
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('JSON 格式有误');
  expect(payload).toBeNull();
  const document = {
    sourceId: 'fixture-notice',
    externalId: 'fixture-1',
    version: 1,
    status: 'active',
    category: 'port-restriction',
    title: '测试夹具公告',
    summary: '测试摘要',
    publishedAt: '2026-10-01T00:00:00Z',
    effectiveFrom: '2026-10-01T00:00:00Z',
    effectiveTo: null,
    bbox: [121, 29, 123, 31],
    vesselTypes: [],
    mmsis: [],
    paragraphs: [{ id: 'p1', text: '测试夹具原文' }],
    raw: { fixture: true },
  };
  await page.getByLabel('公告 JSON').fill(JSON.stringify(document));
  await page.getByRole('button', { name: '校验并导入', exact: true }).click();
  await expect.poll(() => payload).toMatchObject(document);
  expect((payload as Record<string, unknown> | null)?.raw).toEqual(document.raw);
  expect((payload as Record<string, unknown> | null)?.paragraphs).toEqual(document.paragraphs);
  expect(payload).toMatchObject({ reviewStatus: 'confirmed', relations: [] });
  await expect(page.getByLabel('公告 JSON')).toHaveValue('');
});

test('同一实时连接接收AIS增量，旧视野事件不覆盖当前海图', async ({ page }) => {
  await fixture(page);
  let publish: ((message: unknown) => void) | undefined;
  let version = 0;
  let connections = 0;
  await page.routeWebSocket('**/api/v1/live*', (ws) => {
    connections++;
    publish = (message) => ws.send(JSON.stringify(message));
    ws.onMessage((message) => {
      const payload = JSON.parse(String(message));
      if (payload.type === 'viewport') version = payload.version;
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => version).toBeGreaterThan(0);
  const points = [1, 2].map((i) => ({
    kind: 'point',
    mmsi: '41300000' + i,
    lat: 30,
    lon: 122 + i,
    observedAt: '2026-10-01T00:00:00Z',
    sourceId: 'fixture',
    sogKnots: 2,
    cogDegrees: 0,
    headingDegrees: 0,
    quality: ['synthetic'],
  }));
  publish!({
    type: 'ais.snapshot',
    version,
    data: {
      items: points,
      total: 2,
      sampled: false,
      truncated: false,
      generatedAt: '2026-10-01T00:00:00Z',
    },
  });
  await expect(page.locator('.map-status')).toContainText('2 艘船');
  publish!({
    type: 'ais.delta',
    version: version - 1,
    upsert: [],
    remove: ['point:413000001'],
    total: 99,
  });
  await expect(page.locator('.map-status')).toContainText('2 艘船');
  publish!({
    type: 'ais.delta',
    version,
    upsert: [],
    remove: ['point:413000001'],
    total: 1,
    sampled: false,
    truncated: false,
    generatedAt: '2026-10-01T00:01:00Z',
  });
  await expect(page.locator('.map-status')).toContainText('1 艘船');
  await openConsolePage(page, '分析专题');
  await expect(page.getByRole('heading', { name: '分析专题', exact: true })).toBeVisible();
  expect(connections).toBe(1);
});

test('实时服务错误触发HTTP地图回退，重连携带已补取游标', async ({ page }) => {
  await fixture(page);
  const cursors: string[] = [];
  let publish: ((message: unknown) => void) | undefined;
  let mapRequests = 0;
  let caughtUp = false;
  await page.route('**/api/v1/map?*', async (route) => {
    mapRequests++;
    await route.fulfill({
      json: {
        items: [],
        total: 0,
        sampled: false,
        truncated: false,
        generatedAt: new Date().toISOString(),
      },
    });
  });
  await page.route('**/api/v1/analysis/feed?*', async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (cursor === '7') caughtUp = true;
    await route.fulfill({
      json: {
        items:
          cursor === '0'
            ? [{ cursor: '7', type: 'analysis.updated', resultId: 'fixture-result', revision: 2 }]
            : [],
        nextCursor: '7',
      },
    });
  });
  await page.routeWebSocket('**/api/v1/live*', (ws) => {
    cursors.push(new URL(ws.url()).searchParams.get('cursor') ?? '');
    publish = (message) => ws.send(JSON.stringify(message));
    ws.onMessage(() => {});
  });
  await page.goto('/');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => caughtUp).toBe(true);
  const before = mapRequests;
  publish!({ type: 'error', code: 'LIVE_TEMPORARILY_UNAVAILABLE' });
  await expect.poll(() => cursors.length).toBe(2);
  await expect.poll(() => mapRequests, { timeout: 3000 }).toBeGreaterThan(before);
  expect(cursors[1]).toBe('7');
});
test('创建专题提交所选范围与规则参数，并携带CSRF', async ({ page }) => {
  await fixture(page);
  let body: Record<string, unknown> = {};
  let csrf = '';
  await page.route('**/api/v1/topics/instances', async (route) => {
    body = route.request().postDataJSON();
    csrf = route.request().headers()['x-csrf-token'] ?? '';
    await route.fulfill({ json: { id: 'created' } });
  });
  await page.goto('/topics');
  await page.getByLabel('专题名称', { exact: true }).fill('测试专题');
  await page.getByLabel('关注范围（西,南,东,北）').fill('121,29,123,31');
  await page.getByRole('button', { name: '创建专题' }).click();
  await expect.poll(() => body.name).toBe('测试专题');
  expect((body.config as { bbox: number[] }).bbox).toEqual([121, 29, 123, 31]);
  expect(csrf).toBe('fixture-csrf');
});
test('只读用户可看专题且隐藏写操作，接口错误显示重试状态', async ({ page }) => {
  await fixture(page, 'viewer');
  await page.goto('/topics');
  await expect(page.getByRole('heading', { name: '分析专题', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '创建专题' })).toHaveCount(0);
  await page.route('**/api/v1/analysis/results?*', (route) =>
    route.fulfill({ status: 503, json: { message: 'test outage' } }),
  );
  await page.goto('/');
  await page.getByRole('tab', { name: /^主动推送/ }).click();
  await expect(page.getByTestId('fusion-events').getByRole('alert')).toBeVisible();
  await expect(
    page
      .getByTestId('fusion-events')
      .getByRole('button', { name: '测试夹具：港区限制关联', exact: true }),
  ).toHaveCount(0);
});
