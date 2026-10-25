import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import type { AgentVesselHighlightsResult } from '@ais/contracts';
import { useVesselHighlights } from './app/composables/useVesselHighlights';

afterEach(() => vi.unstubAllGlobals());
const artifact = '00000000-0000-4000-8000-000000000001';
const point = {
  mmsi: '123456789',
  name: null,
  lon: 122,
  lat: 30,
  observedAt: '2026-10-25T00:00:00Z',
};
function presentation(ids = [point.mmsi]): AgentVesselHighlightsResult {
  return {
    kind: 'vessel_highlights',
    version: 1,
    inputRevision: 1,
    operation: 'show',
    missingMmsis: [],
    vessels: ids.map((mmsi) => ({ ...point, mmsi })),
  };
}
function setup() {
  const scope = effectScope();
  const session = ref({ user: { id: 'a' } });
  const api = vi.fn(async (_path: string) => ({ items: [{ ...point, lon: 123 }], missing: [] }));
  vi.stubGlobal('usePlatform', () => ({ session, api }));
  return {
    state: scope.run(() => useVesselHighlights(ref(false)))!,
    session,
    api,
    stop: () => scope.stop(),
  };
}
it('人工引用与任务组去重共用动画，取消人工仍保留任务引用', () => {
  const h = setup();
  try {
    h.state.addManual(point);
    const effectId = h.state.targets.value[0]!.effectId;
    h.state.apply(presentation(), artifact, artifact, artifact);
    expect(h.state.targets.value).toHaveLength(1);
    expect(h.state.targets.value[0]!.effectId).toBe(effectId);
    h.state.clearManual(point.mmsi);
    expect(h.state.manualMmsis.value).toEqual([]);
    expect(h.state.groups.value).toHaveLength(1);
    expect(h.state.targets.value).toHaveLength(1);
  } finally {
    h.stop();
  }
});
it('任务clear-all只清任务组，管理清除全部清人工和任务', () => {
  const h = setup();
  try {
    h.state.addManual(point);
    h.state.apply(presentation(), artifact, artifact, artifact);
    h.state.apply(
      { ...presentation(), operation: 'clear', vessels: [], clear: { mode: 'all' } },
      artifact,
      artifact,
      'clear',
    );
    expect(h.state.groups.value).toEqual([]);
    expect(h.state.manualMmsis.value).toEqual([point.mmsi]);
    expect(h.state.targets.value).toHaveLength(1);
    h.state.clearAll();
    expect(h.state.targets.value).toEqual([]);
    expect(h.state.manualMmsis.value).toEqual([]);
  } finally {
    h.stop();
  }
});
it('人工变更使旧绘制确认失效，evidence仅保留任务组', () => {
  const h = setup();
  try {
    h.state.apply(presentation(), artifact, artifact, artifact);
    const oldTargets = h.state.targets.value;
    h.state.markDisplayed(oldTargets);
    const version = h.state.revision.value;
    h.state.addManual({ ...point, mmsi: '987654321' });
    expect(h.state.revision.value).toBe(version + 1);
    expect(h.state.evidence.value).toBeUndefined();
    h.state.markDisplayed(oldTargets);
    expect(h.state.displayed.value).toBe(false);
    h.state.markDisplayed(h.state.targets.value);
    expect(h.state.evidence.value?.groups).toEqual(h.state.groups.value);
    expect(h.state.evidence.value?.groups[0]?.mmsis).toEqual([point.mmsi]);
  } finally {
    h.stop();
  }
});
it('人工与任务共用100艘限额，重复人工引用不消耗额外名额', () => {
  const h = setup();
  try {
    h.state.apply(
      presentation(Array.from({ length: 100 }, (_, i) => String(100000000 + i))),
      artifact,
      artifact,
      artifact,
    );
    h.state.addManual({ ...point, mmsi: '100000000' });
    expect(() => h.state.addManual(point)).toThrow('100');
    expect(h.state.targets.value).toHaveLength(100);
  } finally {
    h.stop();
  }
});
it('人工高亮复用船位刷新并在账号切换时清空', async () => {
  const h = setup();
  try {
    h.state.addManual(point);
    const effectId = h.state.targets.value[0]!.effectId;
    await h.state.refresh();
    expect(h.api.mock.calls[0]?.[0]).toContain(point.mmsi);
    expect(h.state.targets.value[0]).toMatchObject({ lon: 123, effectId });
    h.session.value = { user: { id: 'b' } };
    expect(h.state.manualMmsis.value).toEqual([]);
    expect(h.state.targets.value).toEqual([]);
  } finally {
    h.stop();
  }
});
it('人工引用已满100时拒绝增加任务目标，已有同船任务仍可引用', () => {
  const h = setup();
  try {
    for (let i = 0; i < 100; i++) h.state.addManual({ ...point, mmsi: String(100000000 + i) });
    expect(() => h.state.apply(presentation(), artifact, artifact, artifact)).toThrow('100');
    expect(h.state.groups.value).toEqual([]);
    h.state.apply(presentation(['100000000']), artifact, artifact, artifact);
    expect(h.state.targets.value).toHaveLength(100);
  } finally {
    h.stop();
  }
});
it('人工高亮拒绝无效船位和观测时间，失败保持引用与版本', () => {
  const h = setup();
  try {
    const revision = h.state.revision.value;
    for (const invalid of [{ lon: 181 }, { lat: NaN }, { observedAt: 'invalid' }, { mmsi: 'bad' }])
      expect(() => h.state.addManual({ ...point, ...invalid })).toThrow('有效船位');
    expect(h.state.manualMmsis.value).toEqual([]);
    expect(h.state.revision.value).toBe(revision);
  } finally {
    h.stop();
  }
});
it('清除人工引用后迟到的刷新不恢复船位', async () => {
  const scope = effectScope();
  let resolve!: (value: unknown) => void;
  vi.stubGlobal('usePlatform', () => ({
    session: ref({ user: { id: 'a' } }),
    api: () =>
      new Promise((done) => {
        resolve = done;
      }),
  }));
  const state = scope.run(() => useVesselHighlights(ref(false)))!;
  try {
    state.addManual(point);
    const request = state.refresh();
    state.clearManual(point.mmsi);
    resolve({ items: [{ ...point, lon: 123 }], missing: [] });
    await request;
    expect(state.targets.value).toEqual([]);
    expect(state.updatedAt.value).toBeUndefined();
  } finally {
    scope.stop();
  }
});
