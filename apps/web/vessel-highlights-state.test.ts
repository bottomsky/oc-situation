import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, reactive, ref, shallowReadonly } from 'vue';
import type { AgentVesselHighlightsResult } from '@ais/contracts';
import { useVesselHighlights } from './app/composables/useVesselHighlights';
import { uiViewportProjection, chartViewportSnapshot } from './app/composables/useAgentUi';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('数据查询bbox迟到回填不改变镜头投影，真实镜头和绘图状态仍使版本比较失效', () => {
  const camera = {
    center: [122, 31] as [number, number],
    zoom: 10,
    bbox: [121, 30, 123, 32] as [number, number, number, number],
  };
  const dataQuery = { bbox: [-180, -85, 180, 85] };
  const read = () =>
    chartViewportSnapshot({
      map: { ready: true, moving: false, drawing: false },
      cameraState: camera,
      target: { lon: 122, lat: 31 },
      selecting: false,
      dirty: false,
      revision: 1,
    });
  const completed = JSON.stringify(read());
  dataQuery.bbox = [...camera.bbox];
  expect(dataQuery.bbox).toEqual(camera.bbox);
  expect(JSON.stringify(read())).toBe(completed);
  camera.center = [123, 32];
  camera.bbox = [122, 31, 124, 33];
  expect(JSON.stringify(read())).not.toBe(completed);
  const drawing = chartViewportSnapshot({
    map: { ready: true, moving: false, drawing: true },
    cameraState: camera,
    selecting: false,
    dirty: false,
    revision: 1,
  });
  expect(drawing.blocked).toBe('drawing');
  const dirty = chartViewportSnapshot({
    map: { ready: true, moving: false, drawing: false },
    cameraState: camera,
    selecting: false,
    dirty: true,
    revision: 1,
  });
  expect(dirty.blocked).toBe('editing');
});
it('未保存几何即使绘图已结束仍阻塞镜头，清理草稿后恢复可执行状态', () => {
  const saved = uiViewportProjection(['focus'], {
    mounted: true,
    dirty: false,
    interacting: false,
  });
  const draft = uiViewportProjection(['focus'], { mounted: true, dirty: true, interacting: false });
  const drawing = uiViewportProjection(['focus'], {
    mounted: true,
    dirty: false,
    interacting: true,
  });
  expect(saved.blocked).toBeUndefined();
  expect(draft.dirty).toBe(true);
  expect(draft.blocked).toBe('editing');
  expect(drawing.blocked).toBe('drawing');
  const cleared = uiViewportProjection(['focus'], {
    mounted: true,
    dirty: false,
    interacting: false,
  });
  expect(cleared.blocked).toBeUndefined();
  expect(cleared.actions).toEqual(['focus']);
});
const first = '00000000-0000-4000-8000-000000000001';
const second = '00000000-0000-4000-8000-000000000002';
function presentation(mmsis = ['123456789']): AgentVesselHighlightsResult {
  return {
    kind: 'vessel_highlights',
    version: 1,
    inputRevision: 1,
    operation: 'show',
    missingMmsis: [],
    vessels: mmsis.map((mmsi) => ({
      mmsi,
      name: null,
      lon: 122,
      lat: 30,
      observedAt: '2026-10-17T00:00:00Z',
    })),
  };
}
function setup(
  api: (path: string, options?: Record<string, unknown>) => Promise<unknown> = vi.fn(async () => ({
    items: [],
    missing: [],
  })),
) {
  const scope = effectScope();
  const identity = ref({ user: { id: 'a' } });
  vi.stubGlobal('usePlatform', () => ({ api, session: identity }));
  const paused = ref(false);
  return {
    state: scope.run(() => useVesselHighlights(paused))!,
    paused,
    api,
    identity,
    stop: () => scope.stop(),
  };
}
it('同船跨任务取并集、保持动画标识，清除一个组仍保留另一组引用', () => {
  const h = setup();
  h.state.apply(presentation(), first, first, first);
  const effect = h.state.targets.value[0]!.effectId;
  h.state.apply(presentation(), second, second, second);
  expect(h.state.targets.value).toHaveLength(1);
  expect(h.state.targets.value[0]!.effectId).toBe(effect);
  h.state.clearGroup(first);
  expect(h.state.groups.value.map((g) => g.groupId)).toEqual([second]);
  expect(h.state.targets.value).toHaveLength(1);
  h.stop();
});
it('共享MMSI的新任务携带旧ISO船位时保留已知更新位置', () => {
  const h = setup();
  const newer = presentation();
  newer.vessels[0] = {
    ...newer.vessels[0]!,
    lon: 123,
    lat: 31,
    observedAt: '2026-10-17T00:00:00.500Z',
  };
  h.state.apply(newer, first, first, first);
  // Lexically Z sorts after .500Z even though this observation is older.
  h.state.apply(presentation(), second, second, second);
  expect(h.state.groups.value).toHaveLength(2);
  expect(h.state.targets.value).toHaveLength(1);
  expect(h.state.targets.value[0]).toMatchObject({
    lon: 123,
    lat: 31,
    observedAt: '2026-10-17T00:00:00.500Z',
    effectId: first,
  });
  h.state.clearGroup(first);
  expect(h.state.targets.value[0]).toMatchObject({
    lon: 123,
    lat: 31,
    observedAt: '2026-10-17T00:00:00.500Z',
  });
  h.stop();
});
it('人工清除使旧artifact与命令无法重新展示，账号变化释放本页状态', () => {
  const h = setup();
  h.state.apply(presentation(), first, first, first);
  h.state.clearAll();
  expect(() => h.state.apply(presentation(), first, first, second)).toThrow();
  expect(h.state.targets.value).toEqual([]);
  h.state.apply(presentation(), second, second, second);
  h.identity.value = { user: { id: 'b' } };
  expect(h.state.groups.value).toEqual([]);
  h.stop();
});
it('并集超过100艘拒绝整个新组且保留已有目标', () => {
  const h = setup();
  h.state.apply(
    presentation(Array.from({ length: 100 }, (_, i) => String(100000000 + i))),
    first,
    first,
    first,
  );
  expect(() => h.state.apply(presentation(['223456789']), second, second, second)).toThrow();
  expect(h.state.targets.value).toHaveLength(100);
  h.stop();
});
it('回执只在对应地图快照已渲染后生效，AIS更新不改变语义revision', async () => {
  const h = setup(
    vi.fn(async () => ({
      items: [{ mmsi: '123456789', lon: 123, lat: 31, observedAt: '2026-10-17T01:00:00Z' }],
      missing: [],
    })),
  );
  h.state.apply(presentation(), first, first, first);
  expect(h.state.evidence.value).toBeUndefined();
  h.state.markDisplayed(h.state.targets.value);
  expect(h.state.evidence.value?.artifactRef).toBe(first);
  const revision = h.state.revision.value;
  await h.state.refresh();
  expect(h.state.targets.value[0]!.lon).toBe(123);
  expect(h.state.revision.value).toBe(revision);
  h.stop();
});
it('Vue页面reactive与子组件props传递保持快照身份，等值ISO时间不替换绘制快照', async () => {
  let observedAt = '2026-10-17T00:00:00.000Z';
  const h = setup(
    vi.fn(async () => ({
      items: [{ mmsi: '123456789', lon: 122, lat: 30, observedAt }],
      missing: [],
    })),
  );
  h.state.apply(presentation(), first, first, first);
  const snapshot = h.state.targets.value;
  const page = reactive(h.state);
  const props = shallowReadonly({ vesselHighlights: page.targets });
  page.markDisplayed(props.vesselHighlights);
  expect(h.state.evidence.value?.artifactRef).toBe(first);
  await h.state.refresh();
  expect(h.state.targets.value).toBe(snapshot);
  observedAt = '2026-10-17T00:00:00.500Z';
  await h.state.refresh();
  expect(h.state.targets.value[0]!.observedAt).toBe(observedAt);
  const newer = h.state.targets.value;
  observedAt = '2026-10-17T00:00:00.250Z';
  await h.state.refresh();
  expect(h.state.targets.value).toBe(newer);
  h.stop();
});
it('刷新失败保留最后船位，暂停和空集合不查询', async () => {
  const h = setup(
    vi.fn(async () => {
      throw new Error('offline');
    }),
  );
  await h.state.refresh();
  expect(h.api).not.toHaveBeenCalled();
  h.state.apply(presentation(), first, first, first);
  h.paused.value = true;
  await h.state.refresh();
  expect(h.api).not.toHaveBeenCalled();
  h.paused.value = false;
  await h.state.refresh();
  expect(h.state.targets.value[0]!.lon).toBe(122);
  expect(h.state.error.value).toContain('保留');
  h.stop();
});
it('每5秒批量刷新，隐藏页面与全局暂停停止，离开页面终止请求', async () => {
  vi.useFakeTimers();
  const listeners = new Map<string, () => void>();
  const page = {
    visibilityState: 'visible',
    addEventListener: (event: string, callback: () => void) => listeners.set(event, callback),
    removeEventListener: (event: string) => listeners.delete(event),
  };
  vi.stubGlobal('document', page);
  const api = vi.fn(async () => ({ items: [], missing: [] }));
  const h = setup(api);
  h.state.apply(presentation(), first, first, first);
  await vi.advanceTimersByTimeAsync(4999);
  expect(api).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(api).toHaveBeenCalledTimes(1);
  page.visibilityState = 'hidden';
  listeners.get('visibilitychange')!();
  await vi.advanceTimersByTimeAsync(10000);
  expect(api).toHaveBeenCalledTimes(1);
  page.visibilityState = 'visible';
  listeners.get('visibilitychange')!();
  h.paused.value = true;
  await vi.advanceTimersByTimeAsync(10000);
  expect(api).toHaveBeenCalledTimes(1);
  h.stop();
  expect(listeners.size).toBe(0);
});
it('清除后的迟到船位响应与旧地图快照无法恢复高亮或产生证据', async () => {
  let finish!: (value: unknown) => void;
  const h = setup(
    vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    ),
  );
  h.state.apply(presentation(), first, first, first);
  const old = h.state.targets.value;
  const pending = h.state.refresh();
  h.state.clearAll();
  finish({
    items: [{ mmsi: '123456789', lon: 124, lat: 32, observedAt: '2026-10-17T01:00:00Z' }],
    missing: [],
  });
  await pending;
  h.state.markDisplayed(old);
  expect(h.state.targets.value).toEqual([]);
  expect(h.state.evidence.value).toBeUndefined();
  h.stop();
});
