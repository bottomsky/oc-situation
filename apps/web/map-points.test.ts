import { expect, it } from 'vitest';
import { createPointSnapshot } from './app/utils/mapPoints';
import { createVesselPointRenderer } from './app/utils/vesselPointRendering';
it('重复完整视窗保持五万身份且跳过无变化的GPU图源重建，单点变化只增量更新', () => {
  const renderer = createVesselPointRenderer();
  const values = Array.from({ length: 50000 }, (_, i) => ({
    ...point(String(100000000 + i)),
    observedAt: '2026-10-24T00:00:00Z',
    sourceId: 'fixture',
    sogKnots: 10,
    cogDegrees: 90,
    headingDegrees: 90,
    quality: [],
  }));
  const first = renderer.update(values, Date.parse('2026-10-24T00:01:00Z'));
  expect(first?.kind).toBe('replace');
  if (first?.kind === 'replace') expect(first.data.features).toHaveLength(50000);
  expect(
    renderer.update(
      values.map((p) => ({ ...p })),
      Date.parse('2026-10-24T00:01:00Z'),
    ),
  ).toBeNull();
  const second = renderer.update(
    values.map((p, i) => (i ? p : { ...p, lon: 121 })),
    Date.parse('2026-10-24T00:01:00Z'),
  );
  expect(second?.kind).toBe('delta');
  if (second?.kind === 'delta') {
    expect(second.diff.update).toHaveLength(1);
    expect(second.diff.remove).toHaveLength(0);
  }
});

const point = (mmsi: string) => ({ kind: 'point' as const, mmsi, lon: 120, lat: 30 });
const page = (items: ReturnType<typeof point>[], complete = true, snapshotId = 'a') => ({
  snapshotId,
  sequence: 1,
  items,
  total: snapshotId === 'b' ? 2 : items.length,
  nextCursor: complete ? null : 'next',
  complete,
  generatedAt: '2026-10-24T00:00:00Z',
  expiresAt: '2026-10-24T00:01:00Z',
});
it('末页先到时继续保留旧结果，补齐总数后才提交，迟到旧快照不覆盖', () => {
  const state = createPointSnapshot<ReturnType<typeof point>>();
  state.accept(page([point('old')]));
  expect(state.accept(page([point('two')], true, 'b'))).toBeNull();
  expect(state.items()[0]?.mmsi).toBe('old');
  expect(state.accept(page([point('one')], false, 'b'))).toHaveLength(2);
  expect(state.accept(page([point('old')]))).toBeNull();
  expect(state.items()).toHaveLength(2);
});
it('重复增量幂等，跨页总数和序列变化拒绝提交', () => {
  const state = createPointSnapshot<ReturnType<typeof point>>();
  state.accept(page([point('one')]));
  expect(state.delta({ snapshotId: 'a', sequence: 1, upsert: [], remove: ['one'] })).toBe(true);
  expect(state.items()).toHaveLength(1);
  state.accept(page([point('two')], false, 'b'));
  expect(() => state.accept({ ...page([point('three')], true, 'b'), sequence: 2 })).toThrow();
});
it('分页未完整前保留旧船集，完整后一次替换', () => {
  const state = createPointSnapshot<ReturnType<typeof point>>();
  state.accept(page([point('old')], true));
  state.begin();
  expect(state.accept(page([point('new1')], false, 'b'))).toBeNull();
  expect(state.items().map((p) => p.mmsi)).toEqual(['old']);
  expect(state.accept(page([point('new2')], true, 'b'))?.map((p) => p.mmsi)).toEqual([
    'new1',
    'new2',
  ]);
});
it('乱序增量和错快照不删除船，连续序列才生效', () => {
  const state = createPointSnapshot<ReturnType<typeof point>>();
  state.accept(page([point('one')]));
  expect(state.delta({ snapshotId: 'a', sequence: 3, upsert: [], remove: ['one'] })).toBe(false);
  expect(state.items()).toHaveLength(1);
  expect(
    state.delta({ snapshotId: 'a', sequence: 2, upsert: [point('two')], remove: ['one'] }),
  ).toBe(true);
  expect(state.items()[0]?.mmsi).toBe('two');
});
