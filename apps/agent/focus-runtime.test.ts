import { expect, it } from 'vitest';
import { focusFromContext, focusSummary } from './focus-runtime';

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
