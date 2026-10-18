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
