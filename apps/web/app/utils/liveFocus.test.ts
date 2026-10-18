import { expect, it } from 'vitest';
import type { AgentFocusResult, MapPoint } from '@ais/contracts';
import { createLiveFocusPresentation, createFocusCameraBudget } from './liveFocus';

const snapshot = (): AgentFocusResult => ({
  kind: 'map_focus',
  sessionId: 's',
  taskId: 't',
  version: 1,
  inputRevision: 0,
  cameraPolicy: 'if-needed-once',
  displayStatus: 'complete',
  omittedCount: 0,
  missing: [],
  bbox: [120, 30, 120, 30],
  targets: [
    {
      ref: { kind: 'vessel', id: '413123456' },
      label: '船甲',
      observedAt: '2026-10-18T00:00:00Z',
      geometry: { type: 'Point', coordinates: [120, 30] },
    },
  ],
});
const point = (lon: number, observedAt: string): MapPoint => ({
  kind: 'point',
  mmsi: '413123456',
  lon,
  lat: 31,
  observedAt,
  sourceId: 'live',
  sogKnots: null,
  cogDegrees: null,
  headingDegrees: null,
  quality: [],
});
it('实时位置推进环与整体框和观测时间，保留证据且整轮镜头只消费一次', () => {
  const focus = snapshot(),
    render = createLiveFocusPresentation(),
    camera = createFocusCameraBudget();
  let cameraCount = 0;
  const draw = (items: MapPoint[]) => {
    const value = render(focus, items)!;
    if (camera.take()) cameraCount++;
    return value;
  };
  draw([]);
  const moved = draw([point(122, '2026-10-18T00:01:00Z')]);
  expect(moved.targets[0]?.geometry).toEqual({ type: 'Point', coordinates: [122, 31] });
  expect(moved.bbox).toEqual([122, 31, 122, 31]);
  expect(moved.targets[0]?.observedAt).toBe('2026-10-18T00:01:00Z');
  expect(focus.targets[0]?.geometry).toEqual({ type: 'Point', coordinates: [120, 30] });
  expect(cameraCount).toBe(1);
  expect(draw([point(121, '2026-10-18T00:00:30Z')]).targets[0]?.geometry).toEqual(
    moved.targets[0]?.geometry,
  );
});
it('轨迹事件航线保持快照，关闭或失权后实时更新不能复活关注', () => {
  const focus = snapshot(),
    render = createLiveFocusPresentation();
  focus.targets.push(
    ...(['track', 'event', 'route'] as const).map((kind) => ({
      ...focus.targets[0]!,
      ref: { kind, id: '413123456' },
    })),
  );
  const moved = render(focus, [point(122, '2026-10-18T00:01:00Z')])!;
  for (let i = 1; i < moved.targets.length; i++) expect(moved.targets[i]).toBe(focus.targets[i]);
  expect(render(null, [point(123, '2026-10-18T00:02:00Z')])).toBeNull();
  expect(render(focus, [])?.targets[0]).toBe(focus.targets[0]);
});
