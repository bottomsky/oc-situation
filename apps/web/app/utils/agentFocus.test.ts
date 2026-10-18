import { expect, it } from 'vitest';
import { focusFromTask } from './agentFocus';
import type { AgentVesselTracksResult } from '@ais/contracts';
it('普通问候的显式空关注快照保持无对象空态，真正未定位快照保留', () => {
  const task = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionId: '00000000-0000-4000-8000-000000000002',
    resultVersion: 0,
    inputRevision: 0,
  };
  const focus = {
    kind: 'map_focus',
    sessionId: task.sessionId,
    taskId: task.id,
    version: 0,
    inputRevision: 0,
    targets: [],
    missing: [],
    omittedCount: 0,
    bbox: null,
    displayStatus: 'unlocated',
    cameraPolicy: 'if-needed-once',
  };
  expect(focusFromTask({ task, focusResult: focus })).toBeNull();
  expect(
    focusFromTask({
      task,
      focusResult: { ...focus, missing: [{ kind: 'vessel', id: '413123456' }] },
    })?.displayStatus,
  ).toBe('unlocated');
});
it('历史轨迹引用同时固定来源任务与结果修订', () => {
  const taskId = '00000000-0000-4000-8000-000000000001';
  const result = focusFromTask({
    task: { id: taskId, sessionId: 's', resultVersion: 3, inputRevision: 0 },
    tracksResult: {
      kind: 'vessel_tracks',
      version: 3,
      inputRevision: 0,
      asOf: '2026-10-18T00:00:00.000Z',
      tracks: [
        {
          mmsi: '413123456',
          name: null,
          segments: [
            {
              points: [
                { lon: 122, lat: 31 },
                { lon: 123, lat: 32 },
              ],
            },
          ],
        },
      ],
    } as AgentVesselTracksResult,
  });
  expect(result?.targets[0]?.ref).toEqual({
    kind: 'track',
    id: '413123456',
    revision: 3,
    sourceTaskId: taskId,
  });
});
it('does not invent attention from the captured viewport', () =>
  expect(
    focusFromTask({
      task: {
        id: 't',
        sessionId: 's',
        resultVersion: 1,
        inputRevision: 0,
        selection: { bbox: [1, 2, 3, 4] },
      },
    }),
  ).toBeNull());
it('uses only current input revision results', () =>
  expect(
    focusFromTask({
      task: { id: 't', sessionId: 's', resultVersion: 1, inputRevision: 1 },
      queryResult: {
        kind: 'vessel_list',
        version: 1,
        inputRevision: 0,
        items: [
          {
            mmsi: '123456789',
            name: 'A',
            imo: null,
            shipType: null,
            latestPosition: {
              lon: 1,
              lat: 2,
              observedAt: '2026-01-01T00:00:00.000Z',
              sogKnots: null,
              sourceId: 'ais',
            },
          },
        ],
      },
    }),
  ).toBeNull());
it('reports circle plus 100 vessels exceeding the display cap as omitted, not unlocated', () => {
  const result = focusFromTask({
    task: { id: 't', sessionId: 's', resultVersion: 1, inputRevision: 0 },
    queryResult: {
      kind: 'vessel_list',
      version: 1,
      inputRevision: 0,
      total: 150,
      truncated: true,
      selection: { region: { kind: 'circle', center: [122, 31], radiusMeters: 1000 } },
      regionGeometry: {
        type: 'Polygon',
        coordinates: [
          [
            [122, 31],
            [123, 31],
            [122, 32],
            [122, 31],
          ],
        ],
      },
      items: Array.from({ length: 100 }, (_, i) => ({
        mmsi: String(413000000 + i),
        name: '船' + i,
        imo: null,
        shipType: null,
        latestPosition: {
          lon: 122,
          lat: 31,
          observedAt: '2026-01-01T00:00:00.000Z',
          sogKnots: null,
          sourceId: 'ais',
        },
      })),
    },
  });
  expect(result?.targets).toHaveLength(100);
  expect(result?.targets[0]?.ref.kind).toBe('region');
  expect(result?.missing).toHaveLength(0);
  expect(result?.omittedCount).toBe(51);
  expect(result?.displayStatus).toBe('partial');
});
