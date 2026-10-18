import { expect, it } from 'vitest';
import { focusFromContext, focusSummary, prepareTaskFocus } from './focus-runtime';

it('uses every persisted track segment and reports missing targets', async () => {
  const context = {
    task: {
      id: 'task',
      sessionId: 'session',
      inputRevision: 3,
      selection: {
        focusTargets: [
          { kind: 'track', id: '123456789' },
          { kind: 'vessel', id: '999999999' },
        ],
      },
    },
    tracksResult: {
      tracks: [
        {
          mmsi: '123456789',
          name: '船',
          segments: [
            {
              points: [
                { lon: 1, lat: 2 },
                { lon: 3, lat: 4 },
              ],
            },
            {
              points: [
                { lon: 5, lat: 6 },
                { lon: 7, lat: 8 },
              ],
            },
          ],
        },
      ],
    },
  };
  const result = await focusFromContext(
    context as never,
    { resolveFocus: async () => null } as never,
  );
  expect(result.targets[0]?.geometry).toEqual({
    type: 'MultiLineString',
    coordinates: [
      [
        [1, 2],
        [3, 4],
      ],
      [
        [5, 6],
        [7, 8],
      ],
    ],
  });
  expect(result.displayStatus).toBe('partial');
  expect(result.missing).toEqual([{ kind: 'vessel', id: '999999999' }]);
});

it('derives ordinary query focus from trusted current snapshots', async () => {
  const context = {
    task: { id: 'task', sessionId: 'session', inputRevision: 1, selection: {} },
    queryResult: {
      inputRevision: 1,
      items: [
        {
          mmsi: '123456789',
          name: '船',
          latestPosition: { lon: 121, lat: 30, observedAt: '2026-10-18T00:00:00.000Z' },
        },
      ],
    },
  };
  const result = await focusFromContext(context as never, {} as never);
  expect(result.targets[0]?.ref).toEqual({ kind: 'vessel', id: '123456789' });
  expect(result.targets[0]?.geometry).toEqual({ type: 'Point', coordinates: [121, 30] });
});
it('summarizes unique references and actual partial or unlocated rendering receipts', () => {
  const target = {
    ref: { kind: 'intelligence', id: 'evidence' },
    label: '情报',
    geometry: { type: 'Point', coordinates: [1, 2] },
  };
  const payload = { targets: [target, target], missing: [], displayStatus: 'complete' } as never;
  expect(focusSummary(payload)).toBe('已关注 1 个有位置对象。');
  expect(focusSummary(payload, 'partial')).toContain('1 个关注对象，当前呈现部分位置');
  expect(
    focusSummary({
      targets: [],
      missing: [{ kind: 'event', id: 'event' }],
      displayStatus: 'unlocated',
    } as never),
  ).toContain('1 个对象未能在海图呈现');
  expect(focusSummary(payload, 'unlocated')).toContain('1 个对象未能在海图呈现');
});

it('does not claim complete focus when the source query omitted matching vessels', async () => {
  const result = await focusFromContext(
    {
      task: { id: 'task', sessionId: 'session', inputRevision: 0, selection: {} },
      queryResult: {
        inputRevision: 0,
        total: 150,
        truncated: true,
        items: [{ mmsi: '123456789', latestPosition: { lon: 121, lat: 30 } }],
      },
    } as never,
    {} as never,
  );
  expect(result.targets).toHaveLength(1);
  expect(result.displayStatus).toBe('partial');
  expect(result.omittedCount).toBe(149);
});
it('keeps the resolved vessel circle first and reuses its immutable geometry and anchor observation time', async () => {
  const region = { kind: 'circle', center: [121, 30], radiusMeters: 100000 };
  const geometry = {
    type: 'Polygon',
    coordinates: [
      [
        [121, 30],
        [122, 30],
        [121, 31],
        [121, 30],
      ],
    ],
  };
  const result = await focusFromContext(
    {
      task: {
        id: 'task',
        sessionId: 'session',
        inputRevision: 0,
        selection: {
          vesselCircle: { mmsi: '257288000', radiusMeters: 100000 },
          bbox: [-10, -10, 10, 10],
        },
      },
      queryResult: {
        inputRevision: 0,
        total: 105,
        selection: { region },
        regionGeometry: geometry,
        regionAnchor: {
          mmsi: '257288000',
          observedAt: '2026-10-18T00:00:00.000Z',
          sourceId: 'anchor-source',
        },
        items: Array.from({ length: 100 }, (_, i) => ({
          mmsi: String(800000000 + i),
          latestPosition: { lon: 121, lat: 30 },
        })),
      },
    } as never,
    {
      resolveFocus: async () => {
        throw new Error('must reuse saved region, never resolve the anchor twice');
      },
    } as never,
  );
  expect(result.targets[0]).toMatchObject({
    ref: { kind: 'region' },
    geometry,
    region,
    observedAt: '2026-10-18T00:00:00.000Z',
  });
  expect(result.targets[0]?.label).toContain('257288000');
  expect(result.targets).toHaveLength(100);
  expect(result.omittedCount).toBe(6);
  expect(result.displayStatus).toBe('partial');
});

const highlight = {
  kind: 'vessel_highlights',
  version: 0,
  inputRevision: 2,
  operation: 'show',
  vessels: [
    {
      mmsi: '257288000',
      name: '中心船',
      lon: 121,
      lat: 30,
      observedAt: '2026-10-18T00:00:00.000Z',
    },
  ],
  missingMmsis: ['257288001'],
};
const emptyFocusContext = () => ({
  task: { id: 'task', sessionId: 'session', inputRevision: 2, selection: {} },
  steps: [],
  results: [],
});
it('restores focus from the exact highlighter snapshot after the display command resumes', async () => {
  const context = {
    ...emptyFocusContext(),
    steps: [{ key: 'map_vessel_highlights', output: { payload: highlight } }],
  };
  const result = await focusFromContext(
    context as never,
    {
      resolveFocus: async () => {
        throw new Error('must keep the displayed snapshot');
      },
    } as never,
  );
  expect(result.targets).toEqual([
    expect.objectContaining({
      ref: { kind: 'vessel', id: '257288000' },
      geometry: { type: 'Point', coordinates: [121, 30] },
      observedAt: '2026-10-18T00:00:00.000Z',
    }),
  ]);
  expect(result.missing).toEqual([{ kind: 'vessel', id: '257288001' }]);
});
it('recovers dynamic highlighter artifacts only for the current task and input revision', async () => {
  const context = {
    ...emptyFocusContext(),
    artifacts: [
      { taskId: 'other-task', inputRevision: 2, kind: 'vessel_highlights', payload: highlight },
      { taskId: 'task', inputRevision: 1, kind: 'vessel_highlights', payload: highlight },
      { taskId: 'task', inputRevision: 2, kind: 'vessel_highlights', payload: highlight },
    ],
  };
  const result = await focusFromContext(context as never, {} as never);
  expect(result.targets).toHaveLength(1);
  expect(result.missing).toHaveLength(1);
  context.artifacts.pop();
  expect((await focusFromContext(context as never, {} as never)).targets).toEqual([]);
});
it('keeps a saved business focus immutable when the completed hook has no business selection', async () => {
  const payload = {
    kind: 'map_focus',
    version: 0,
    inputRevision: 2,
    taskId: 'task',
    sessionId: 'session',
    targets: [
      {
        ref: { kind: 'event', id: 'event', revision: 1 },
        label: '事件',
        geometry: { type: 'Point', coordinates: [121, 30] },
      },
    ],
    missing: [],
    bbox: [121, 30, 121, 30],
    displayStatus: 'complete',
    cameraPolicy: 'if-needed-once',
  };
  const saved: unknown[] = [];
  const context = { ...emptyFocusContext(), focusResult: payload };
  const result = await prepareTaskFocus(
    context as never,
    {
      saveFocus: async (focus: unknown) => {
        saved.push(focus);
      },
      resolveFocus: async () => {
        throw new Error('must not re-resolve a completed snapshot');
      },
    } as never,
  );
  expect(result).toEqual(payload);
  expect(saved).toEqual([]);
  context.focusResult = { ...payload, taskId: 'other-task' };
  expect(
    (await prepareTaskFocus(context as never, { saveFocus: async () => {} } as never))?.targets,
  ).toEqual([]);
});
it('keeps clear-highlights and viewport-only requests free from inferred object focus', async () => {
  for (const selection of [
    { highlightClear: { mode: 'all' } },
    { mapCamera: { mode: 'current', zoom: 6 } },
  ]) {
    const result = await focusFromContext(
      {
        ...emptyFocusContext(),
        task: { ...emptyFocusContext().task, selection },
        steps: [
          {
            key: 'map_vessel_highlights',
            output: {
              payload: {
                ...highlight,
                operation: 'clear',
                vessels: [],
                missingMmsis: [],
                clear: { mode: 'all' },
              },
            },
          },
        ],
      } as never,
      {} as never,
    );
    expect(result.targets).toEqual([]);
  }
});
it('does not turn a clear operation lookup into a fresh object focus', async () => {
  const result = await focusFromContext(
    {
      ...emptyFocusContext(),
      task: { ...emptyFocusContext().task, selection: { highlightClearUnclear: true } },
      queryResult: {
        inputRevision: 2,
        items: [{ mmsi: '257288000', latestPosition: { lon: 121, lat: 30 } }],
      },
    } as never,
    {} as never,
  );
  expect(result.targets).toEqual([]);
});
it('restores a completed dynamic query snapshot without querying newer vessel positions', async () => {
  const result = await focusFromContext(
    {
      ...emptyFocusContext(),
      artifacts: [
        {
          taskId: 'task',
          inputRevision: 2,
          kind: 'vessel_detail',
          payload: {
            kind: 'vessel_detail',
            version: 0,
            inputRevision: 2,
            total: 1,
            truncated: false,
            selection: {},
            asOf: '2026-10-18T00:00:00.000Z',
            items: [
              {
                mmsi: '257288000',
                name: '船',
                imo: null,
                shipType: null,
                latestPosition: {
                  lon: 121,
                  lat: 30,
                  observedAt: '2026-10-18T00:00:00.000Z',
                  sogKnots: null,
                  sourceId: 'snapshot',
                },
              },
            ],
          },
        },
      ],
    } as never,
    {
      resolveFocus: async () => {
        throw new Error('must not query again');
      },
    } as never,
  );
  expect(result.targets[0]?.geometry).toEqual({ type: 'Point', coordinates: [121, 30] });
  expect(result.displayStatus).toBe('complete');
  expect(result.omittedCount).toBeUndefined();
});
it('uses the exact route revision returned by a restored dynamic business query', async () => {
  const geometry = {
    type: 'LineString',
    coordinates: [
      [121, 30],
      [122, 31],
    ],
  };
  const route = {
    id: '11111111-1111-4111-8111-111111111111',
    revision: 4,
    name: '已查询航线',
    status: 'draft',
    mmsis: [],
    waypoints: geometry.coordinates,
    geometry,
    lengthMeters: 1000,
    generatedBy: 'manual',
    planId: null,
    createdAt: '2026-10-18T00:00:00.000Z',
    updatedAt: '2026-10-18T00:00:00.000Z',
  };
  const result = await focusFromContext(
    {
      ...emptyFocusContext(),
      artifacts: [
        {
          taskId: 'task',
          inputRevision: 2,
          kind: 'route',
          payload: { kind: 'route', routes: [route], total: 2 },
        },
      ],
    } as never,
    {
      resolveFocus: async () => {
        throw new Error('must not read a mutable route');
      },
    } as never,
  );
  expect(result.targets).toEqual([
    expect.objectContaining({ ref: { kind: 'route', id: route.id, revision: 4 }, geometry }),
  ]);
  expect(result.omittedCount).toBe(1);
});
