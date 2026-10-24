import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cpus, totalmem, platform, release } from 'node:os';
import { chartFixture } from './fixtures/chart-fixture';
import { selectLeftTab } from './chart-helpers';
import { predictVesselReachability } from '../../packages/domain/reachability';
import { evaluateNavigationWarningImpact } from '../../packages/domain/navigation-warning-impact';
const out = resolve(import.meta.dirname, '../../.data/maritime-validation');
test('合成压力数据：五万单船完整快照、GIS与预测双视图', async ({ page }) => {
  await mkdir(out, { recursive: true });
  await chartFixture(page, { role: 'operator' });
  const now = new Date().toISOString();
  const pageStartedAt = Date.now();
  const points = Array.from({ length: 50000 }, (_, i) => ({
    kind: 'point',
    mmsi: String(100000001 + i),
    lon: 118 + (i % 250) * 0.04,
    lat: 28 + Math.floor(i / 250) * 0.06,
    observedAt: now,
    sourceId: 'synthetic-browser-benchmark',
    sogKnots: i % 21,
    cogDegrees: i % 360,
    headingDegrees: i % 7 === 0 ? null : i % 360,
    quality: ['synthetic'],
  }));
  let requestedAt = 0,
    submittedAt = now;
  let presentationMode = false;
  const requests: { cursor: number; at: number; duration: number; initial: boolean }[] = [];
  const docId = 'd'.repeat(64);
  await page.route('**/api/v1/map/**', async (route) => {
    if (route.request().method() === 'DELETE') {
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      route.request().method() !== 'GET' ||
      new URL(route.request().url()).pathname !== '/api/v1/map/points'
    ) {
      await route.fallback();
      return;
    }
    requestedAt ||= Date.now();
    const url = new URL(route.request().url());
    const requestStarted = Date.now();
    const activePoints = presentationMode ? points.filter((_, i) => i % 137 === 0) : points;
    const offset = Number(url.searchParams.get('cursor') ?? 0),
      end = Math.min(offset + 1000, activePoints.length);
    await route.fulfill({
      json: {
        snapshotId: presentationMode ? 'synthetic-presentation' : 'synthetic-50k',
        sequence: 1,
        items: activePoints.slice(offset, end),
        total: activePoints.length,
        nextCursor: end < activePoints.length ? String(end) : null,
        complete: end === activePoints.length,
        generatedAt: now,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    });
    requests.push({
      cursor: offset,
      at: requestStarted - pageStartedAt,
      duration: Date.now() - requestStarted,
      initial: offset === 0,
    });
  });
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [123.2, 34.04],
        [123.45, 34.04],
        [123.45, 34.17],
        [123.2, 34.17],
        [123.2, 34.04],
      ],
    ],
  };
  // Synthetic observations exercise the real model. The injected circular island is a test constraint.
  const syntheticObservations = [0, 5, 10, 15, 20, 25, 30].map((minute) => ({
    observedAt: new Date(Date.parse(now) - (30 - minute) * 60000).toISOString(),
    longitude: 123 + minute * 0.003,
    latitude: 34 + minute * 0.001,
    speedOverGround: 10,
    courseOverGround: 68,
    heading: 68,
  }));
  const model = await predictVesselReachability(
    {
      mmsi: '100000001',
      asOf: now,
      seed: 20261024,
      observations: syntheticObservations,
      historicalResiduals: [
        { speedKnots: -1, turnDegreesPerMinute: -0.4 },
        { speedKnots: 1, turnDegreesPerMinute: 0.6 },
        { speedKnots: 0.4, turnDegreesPerMinute: 0.2 },
      ],
    },
    {
      checkPaths: async (paths) =>
        paths.map((path) =>
          path.points.every((point, index) => {
            if (!index) return true;
            const previous = path.points[index - 1]!.coordinate;
            const dx = point.coordinate[0] - previous[0],
              dy = point.coordinate[1] - previous[1],
              scale = dx * dx + dy * dy;
            const t = scale
              ? Math.max(
                  0,
                  Math.min(1, ((123.32 - previous[0]) * dx + (34.1 - previous[1]) * dy) / scale),
                )
              : 0;
            return Math.hypot(previous[0] + t * dx - 123.32, previous[1] + t * dy - 34.1) > 0.002;
          }),
        ),
    },
  );
  const prediction = model.summary;
  expect(prediction.status, prediction.reason ?? '').toBe('ready');
  const modelImpact = evaluateNavigationWarningImpact({
    prediction: model,
    vessel: { mmsi: '100000001' },
    warnings: [
      {
        id: `${docId}:relation-1:1`,
        reviewStatus: 'confirmed',
        effectiveFrom: now,
        effectiveTo: new Date(Date.parse(now) + 7200000).toISOString(),
        geometry,
        applicability: { kind: 'all' },
      },
    ],
  }).impacts[0]!;
  points[0] = {
    ...points[0]!,
    lon: 123.09,
    lat: 34.03,
    sogKnots: 10,
    cogDegrees: 68,
    headingDegrees: 68,
  };
  await page.route('**/api/v1/topics/predictions*', async (route) => {
    if (route.request().method() === 'POST') {
      submittedAt = new Date(Date.now() + 100).toISOString();
      await route.fulfill({
        status: 202,
        json: { instanceId: 'synthetic-prediction', runId: 'synthetic-run' },
      });
      return;
    }
    const url = new URL(route.request().url());
    await route.fulfill({
      json: {
        instances: [],
        items: url.searchParams.has('mmsi')
          ? [
              {
                id: 'synthetic-result',
                runId: 'synthetic-run',
                revision: 1,
                instanceId: 'synthetic-prediction',
                computedAt: submittedAt,
                prediction,
                impacts: [
                  {
                    warningId: `${docId}:relation-1:1`,
                    documentId: docId,
                    relationId: 'relation-1',
                    relationRevision: 1,
                    probability: modelImpact.probability,
                    hitPaths: modelImpact.hitPaths,
                    totalPaths: modelImpact.totalPaths,
                    confidenceInterval: modelImpact.confidenceInterval,
                    firstEntry: modelImpact.firstEntry,
                    calibration: 'uncalibrated',
                    geometry,
                  },
                ],
                stale: false,
                evidence: {
                  ais: syntheticObservations.map((point, index) => ({
                    ...point,
                    recordId: 'synthetic-ais-' + index,
                    mmsi: '100000001',
                    occurredAt: point.observedAt,
                    raw: { quality: ['synthetic'] },
                  })),
                  documents: [{ id: docId, title: '合成航警 · 通航限制验证区', occurredAt: now }],
                  steps: [{ rule: 'fixture', outcome: 'accepted', detail: '浏览器UI合成夹具' }],
                  limitations: ['仅供浏览器验收'],
                },
              },
            ]
          : [],
      },
    });
  });
  await page.route('**/api/v1/topics/runs/synthetic-run', (route) =>
    route.fulfill({ json: { id: 'synthetic-run', status: 'succeeded' } }),
  );
  const errors: string[] = [];
  await page.addInitScript(() => {
    const state = globalThis as typeof globalThis & { __maritimeLongTasks: number[] };
    state.__maritimeLongTasks = [];
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) state.__maritimeLongTasks.push(entry.duration);
    }).observe({ entryTypes: ['longtask'] });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/?mapDiagnostics=1');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute('data-loaded', '50000');
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute('data-complete', 'true');
  const firstCompleteMs = Date.now() - requestedAt;
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-vessel-source-loaded', 'true');
  await expect
    .poll(
      async () =>
        Number(await page.getByTestId('sea-map').getAttribute('data-rendered-vessel-sample')),
      { timeout: 60000 },
    )
    .toBeGreaterThan(0);
  await expect(page.getByTestId('sea-map')).toHaveAttribute(
    'data-source-vessel-identities',
    '50000',
  );
  const firstRenderedMs = Date.now() - requestedAt;
  await page.screenshot({ path: resolve(out, 'dark-50000-vessels.png'), fullPage: true });
  await page.getByRole('button', { name: '浅色海图', exact: true }).click();
  await page.screenshot({ path: resolve(out, 'light-50000-vessels.png'), fullPage: true });
  const rendererInfo = await page
    .locator('.maplibregl-canvas')
    .evaluate((canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { renderer: 'unavailable' };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: ext
          ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
          : String(gl.getParameter(gl.RENDERER)),
        vendor: ext
          ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL))
          : String(gl.getParameter(gl.VENDOR)),
      };
    });
  const frames = page.evaluate(
    () =>
      new Promise<{ fps: number; p95FrameMs: number; heapBytes: number | null }>((resolve) => {
        const deltas: number[] = [];
        const start = performance.now();
        let last = start;
        const sample = (now: number) => {
          deltas.push(now - last);
          last = now;
          if (now - start < 4000) requestAnimationFrame(sample);
          else {
            const sorted = [...deltas].sort((a, b) => a - b);
            resolve({
              fps: deltas.length / ((now - start) / 1000),
              p95FrameMs: sorted[Math.floor(sorted.length * 0.95)]!,
              heapBytes:
                (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
                  ?.usedJSHeapSize ?? null,
            });
          }
        };
        requestAnimationFrame(sample);
      }),
  );
  const canvas = page.locator('.maplibregl-canvas');
  const box = await canvas.boundingBox();
  await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.55, { steps: 40 });
  await page.mouse.up();
  const performanceResult = await frames;
  const longTasks = await page.evaluate(
    () => (globalThis as typeof globalThis & { __maritimeLongTasks: number[] }).__maritimeLongTasks,
  );
  await expect(page.getByTestId('map-snapshot-status')).not.toContainText('快照');
  presentationMode = true;
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByTestId('map-snapshot-status')).toHaveAttribute(
    'data-loaded',
    String(Math.ceil(points.length / 137)),
  );
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-vessel-source-loaded', 'true');
  await page.getByRole('button', { name: '测距', exact: true }).click();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.5);
  await page.mouse.click(box!.x + box!.width * 0.6, box!.y + box!.height * 0.6);
  await expect(page.getByRole('status').filter({ hasText: '点选连续测距' })).toContainText('海里');
  await page.getByRole('button', { name: '结束测距', exact: true }).click();
  await page.getByRole('button', { name: '深色海图', exact: true }).click();
  await selectLeftTab(page, '航行预测');
  const panel = page.getByTestId('prediction-panel');
  await panel.getByRole('textbox').fill('100000001');
  await panel.getByRole('button', { name: '立即预测', exact: true }).click();
  await expect(panel.getByText('计算结果已加载')).toBeVisible();
  await expect(page.getByRole('region', { name: '预测影响与证据' })).toBeVisible();
  await panel.getByRole('button', { name: '＋60分钟', exact: true }).click();
  await panel.getByRole('button', { name: '定位预测', exact: true }).click();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-moving', 'false');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-prediction-displayed', '60');
  await expect(page.getByTestId('sea-map')).toHaveAttribute(
    'data-prediction-origin',
    '123.09,34.03',
  );
  await expect(page.getByTestId('sea-map')).toHaveAttribute(
    'data-prediction-origin-basis',
    'fixed-input',
  );
  await expect(page.getByText(/固定预测输入 · 100000001/)).toBeVisible();
  await expect
    .poll(async () =>
      Number(await page.getByTestId('sea-map').getAttribute('data-rendered-prediction')),
    )
    .toBeGreaterThan(0);
  await page.screenshot({ path: resolve(out, 'prediction-position-sidebar.png'), fullPage: true });
  await panel.getByRole('button', { name: '沿途概率走廊', exact: true }).click();
  await panel.getByRole('button', { name: '＋120分钟', exact: true }).click();
  await panel.getByRole('button', { name: '定位预测', exact: true }).click();
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-moving', 'false');
  await expect(page.getByTestId('sea-map')).toHaveAttribute('data-prediction-displayed', '120');
  await expect(panel.getByRole('button', { name: '沿途概率走廊', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.screenshot({ path: resolve(out, 'prediction-passage-sidebar.png'), fullPage: true });
  await page.route(`**/api/v1/intelligence/events/${docId}`, (route) =>
    route.fulfill({
      json: {
        event: {
          id: docId,
          title: '合成航警证据',
          summary: '仅供浏览器验收',
          sourceId: 'fixture',
          externalId: 'fixture-warning',
          version: 1,
          status: 'active',
          reviewStatus: 'confirmed',
          publishedAt: now,
          effectiveFrom: now,
          effectiveTo: null,
          paragraphs: [],
          mmsis: [],
          vesselTypes: [],
          raw: { synthetic: true },
        },
        relations: [],
        history: [],
      },
    }),
  );
  const evidenceRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/v1/intelligence/events/${docId}`,
  );
  await page.getByRole('button', { name: '查看航警证据 ↗', exact: true }).click();
  await evidenceRequest;
  await writeFile(
    resolve(out, 'browser-performance.json'),
    JSON.stringify(
      {
        fixture: '50000 synthetic identities, page size 1000, local HTTP; not production data',
        device: {
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
          platform: platform(),
          release: release(),
        },
        renderer: rendererInfo,
        renderMode: process.env.MARITIME_RENDERER ?? 'software',
        launchArgs:
          process.env.MARITIME_RENDERER === 'hardware'
            ? ['--use-angle=d3d11']
            : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        viewport: { width: 1920, height: 1080 },
        firstCompleteMs,
        firstRenderedMs,
        pageToFirstCompleteMs: firstCompleteMs + requestedAt - pageStartedAt,
        requestPages: requests.length,
        initialSnapshotRequests: requests.filter((r) => r.initial).length,
        requests,
        longTasks,
        ...performanceResult,
        targetFps: 30,
        targetMet: performanceResult.fps >= 30,
        loadedIdentities: 50000,
        sourceIdentities: 50000,
        renderValidation:
          '9 bounded screen probes; actual source unique MMSIs counted once per data revision',
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  await writeFile(
    resolve(out, 'browser-performance-' + (process.env.MARITIME_RENDERER ?? 'software') + '.json'),
    await import('node:fs/promises').then((fs) =>
      fs.readFile(resolve(out, 'browser-performance.json')),
    ),
  );
  expect(errors).toEqual([]);
});
