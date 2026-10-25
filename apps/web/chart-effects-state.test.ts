import { expect, it } from 'vitest';
import { watch } from 'vue';
import { useChartEffects } from './app/composables/useChartEffects';

it('所有入口共享单选，关闭详情不改变选择，改选和清除使迟到详情失效', () => {
  const effects = useChartEffects();
  const first = effects.select({ kind: 'vessel', id: '413000001', geometries: [] });
  expect(effects.selected.value?.key).toBe('vessel:413000001');
  const second = effects.select({ kind: 'route', id: 'r', revision: 3, geometries: [] });
  expect(first()).toBe(false);
  expect(second()).toBe(true);
  expect(effects.selected.value?.key).toBe('route:r:3');
  effects.clearSelection();
  expect(second()).toBe(false);
  expect(effects.selected.value).toBeNull();
});
it('逻辑无坐标对象保持选择，船舶仅跟随最新合法位置，版本化线面保持原几何', () => {
  const effects = useChartEffects();
  effects.select({ kind: 'vessel', id: '413000001', geometries: [] });
  effects.updateVessels([
    { mmsi: '413000001', lon: 121, lat: 31, observedAt: '2026-10-25T01:00:00Z' },
  ]);
  effects.updateVessels([
    { mmsi: '413000001', lon: 122, lat: 32, observedAt: '2026-10-25T00:00:00Z' },
    { mmsi: '413000001', lon: 500, lat: 32, observedAt: '2026-10-25T02:00:00Z' },
  ]);
  expect(effects.selected.value?.geometries).toEqual([{ type: 'Point', coordinates: [121, 31] }]);
  const geometry = {
    type: 'LineString' as const,
    coordinates: [
      [120, 30],
      [121, 31],
    ] as [number, number][],
  };
  effects.select({ kind: 'route', id: 'r', revision: 1, geometries: [geometry] });
  effects.updateVessels([
    { mmsi: '413000001', lon: 123, lat: 33, observedAt: '2026-10-25T03:00:00Z' },
  ]);
  expect(effects.selected.value?.geometries).toEqual([geometry]);
});
import {
  createChartEffectProjection,
  mergeChartEffectTargets,
} from './app/composables/useChartEffects';

it('一次地图帧共用一次视口读取和每顶点投影，布局读取不触发布局扫描', () => {
  let rendered = () => {};
  let reads = 0,
    projections = 0;
  const map = createChartEffectProjection({
    cameraState: () => ({ zoom: 4 }),
    focusViewport: () => {
      reads++;
      return { left: 0, top: 0, right: 600, bottom: 400 };
    },
    projectFocus: (point: [number, number]) => {
      projections++;
      return { x: point[0], y: point[1] };
    },
    onFocusRender: (listener: () => void) => {
      rendered = listener;
      return () => {};
    },
  });
  for (let i = 0; i < 100; i++) {
    map.projectFocus([120, 30], 120);
    map.focusViewport();
  }
  expect(reads).toBe(1);
  expect(projections).toBe(1);
  rendered();
  map.projectFocus([120, 30], 120);
  expect(reads).toBe(2);
  expect(projections).toBe(2);
  map.disposeEffectProjection();
});
it('同船AI关注与显式高亮合为一个实体，保留更新船位和原高亮事件身份', () => {
  const before = {
    key: 'vessel:413000001',
    effectId: 'manual:1',
    geometries: [{ type: 'Point' as const, coordinates: [120, 30] as [number, number] }],
    observedAt: '2026-10-25T00:00:00Z',
  };
  const fresh = {
    ...before,
    effectId: undefined,
    observedAt: '2026-10-25T01:00:00Z',
    geometries: [{ type: 'Point' as const, coordinates: [121, 31] as [number, number] }],
  };
  expect(mergeChartEffectTargets([before, fresh])).toEqual([{ ...fresh, effectId: 'manual:1' }]);
});
import { chartAttentionIcon, chartAttentionVisibility } from './app/composables/useChartEffects';

it('调用者的危险/机会图形贯穿强调，船舶未知方向保持对称图形', () => {
  expect(chartAttentionIcon('danger', 'vessel')).toBe('danger');
  expect(chartAttentionIcon('opportunity', 'vessel')).toBe('opportunity');
  expect(chartAttentionIcon('vessel', 'unknown')).toBe('unknown');
});
it('收缩阶段保留常驻glyph，只有实际可见播放点在闪烁阶段交接，后台与结束恢复', () => {
  const target = { key: 'vessel:413000001', geometries: [] };
  const request = {
    id: 'attention:1',
    icon: 'vessel' as const,
    targets: [target, { key: 'offscreen', geometries: [] }],
  };
  const frame = { request, elapsed: 300, size: 24, phase: 'contract' as const, visible: true };
  const visible = [
    { key: target.key, isPoint: true },
    { key: 'queued', isPoint: true },
  ];
  expect(chartAttentionVisibility(frame, visible, false)).toEqual({ hidden: [], muted: [] });
  const blink = { ...frame, phase: 'blink' as const, elapsed: 600, visible: false };
  expect(chartAttentionVisibility(blink, visible, false)).toEqual({
    hidden: [target.key],
    muted: [target.key],
  });
  expect(chartAttentionVisibility({ ...blink, visible: true }, visible, false)).toEqual({
    hidden: [target.key],
    muted: [],
  });
  expect(chartAttentionVisibility(blink, visible, true)).toEqual({ hidden: [], muted: [] });
  expect(chartAttentionVisibility({ ...blink, phase: 'done' }, visible, false)).toEqual({
    hidden: [],
    muted: [],
  });
});
it('强调结束释放目标坐标，去重身份保留到账号作用域重置', () => {
  const effects = useChartEffects();
  const request = {
    id: 'attention:1',
    icon: 'alert' as const,
    targets: [{ key: 'event:e:1', geometries: [] }],
  };
  effects.select({ kind: 'event', id: 'e', geometries: [] });
  expect(effects.playAttention(request)).toBe(true);
  effects.cancelAttention(request.id);
  expect(effects.attentionRequests.value).toEqual([]);
  expect(effects.playAttention(request)).toBe(false);
  effects.reset();
  expect(effects.selected.value).toBeNull();
  expect(effects.playAttention(request)).toBe(true);
});
import { chartAttentionRequest } from './app/composables/useChartEffects';
it('排队保留完整对象范围，由实际播放帧决定当前可见目标；全离屏事件跳过', () => {
  const first = { key: 'first', geometries: [] },
    later = { key: 'later', geometries: [] };
  const request = { id: 'queued', icon: 'alert' as const, targets: [first, later] };
  const queued = chartAttentionRequest(request, new Set(['first']));
  expect(queued).toBe(request);
  const frame = { request: queued, phase: 'blink' as const, visible: true, elapsed: 800, size: 24 };
  expect(chartAttentionVisibility(frame, [{ key: 'later', isPoint: true }], false)).toEqual({
    hidden: ['later'],
    muted: [],
  });
  expect(chartAttentionRequest(request, new Set())).toBeNull();
});
it('AI船舶快照选中后，旧fleet与详情刷新保持快照的较新合法位置', () => {
  const effects = useChartEffects();
  const stop = watch(
    () => effects.selected.value?.key,
    () =>
      effects.updateVessels([
        { mmsi: '413000001', lon: 121, lat: 31, observedAt: '2026-10-25T01:00:00Z' },
      ]),
    { flush: 'sync' },
  );
  effects.select({
    kind: 'vessel',
    id: '413000001',
    observedAt: '2026-10-25T03:00:00Z',
    geometries: [{ type: 'Point', coordinates: [123, 33] }],
  });
  effects.updateVessels([
    { mmsi: '413000001', lon: 121, lat: 31, observedAt: '2026-10-25T01:00:00Z' },
  ]);
  expect(effects.selected.value?.geometries).toEqual([{ type: 'Point', coordinates: [123, 33] }]);
  expect(effects.selected.value?.observedAt).toBe('2026-10-25T03:00:00Z');
  stop();
});
it('同船重新选择更晚快照更新防回退基线，合法新AIS仍可继续前进', () => {
  const effects = useChartEffects();
  effects.select({ kind: 'vessel', id: '413000001', geometries: [] });
  effects.updateVessels([
    { mmsi: '413000001', lon: 121, lat: 31, observedAt: '2026-10-25T01:00:00Z' },
  ]);
  effects.select({
    kind: 'vessel',
    id: '413000001',
    observedAt: '2026-10-25T03:00:00Z',
    geometries: [{ type: 'Point', coordinates: [123, 33] }],
  });
  expect(effects.selected.value?.geometries).toEqual([{ type: 'Point', coordinates: [123, 33] }]);
  effects.updateVessels([
    { mmsi: '413000001', lon: 122, lat: 32, observedAt: '2026-10-25T02:00:00Z' },
  ]);
  expect(effects.selected.value?.observedAt).toBe('2026-10-25T03:00:00Z');
  effects.updateVessels([
    { mmsi: '413000001', lon: 124, lat: 34, observedAt: '2026-10-25T04:00:00Z' },
  ]);
  expect(effects.selected.value?.geometries).toEqual([{ type: 'Point', coordinates: [124, 34] }]);
});
import { releaseChartAttentionRequests } from './app/composables/useChartEffects';
import { createMapEffectClock } from './app/utils/mapEffectsClock';
it('取消排队强调即刻释放目标并通知所属id，无需等待clock尚未开始的done回调', () => {
  const first = {
    id: 'active',
    icon: 'alert' as const,
    targets: [{ key: 'first', geometries: [] }],
  };
  const queued = {
    id: 'pending',
    icon: 'danger' as const,
    targets: [{ key: 'queued', geometries: [] }],
  };
  const completed: string[] = [];
  const clock = createMapEffectClock({
    frames: { request: () => 1, cancel: () => {} },
    onFrame: (frame) => {
      if (frame.phase === 'done' && frame.request) completed.push(frame.request.id);
    },
  });
  clock.update({ active: true, hidden: false, reduced: false });
  clock.enqueue(first);
  clock.enqueue(queued);
  clock.cancel('pending');
  expect(completed).toEqual([]);
  const released = releaseChartAttentionRequests([first, queued], 'pending');
  expect(released).toEqual({ retained: [first], released: ['pending'] });
  expect(releaseChartAttentionRequests(released.retained)).toEqual({
    retained: [],
    released: ['active'],
  });
  clock.dispose();
});
it.each([
  {
    observedAt: 'not-a-date',
    geometries: [{ type: 'Point' as const, coordinates: [123, 33] as [number, number] }],
  },
  {
    observedAt: '2026-10-25T03:00:00Z',
    geometries: [{ type: 'Point' as const, coordinates: [500, 33] as [number, number] }],
  },
])('非法选中快照不建立船位防回退基线：$observedAt', (snapshot) => {
  const effects = useChartEffects();
  effects.select({ kind: 'vessel', id: '413000001', ...snapshot });
  effects.updateVessels([
    { mmsi: '413000001', lon: 121, lat: 31, observedAt: '2026-10-25T01:00:00Z' },
  ]);
  expect(effects.selected.value?.geometries).toEqual([{ type: 'Point', coordinates: [121, 31] }]);
});
import { resultSelectionGeometries } from './app/composables/useChartEffects';
it('仅有文档范围的结果选择使用真实文档Polygon，跨日期线与海图相同拆分，空证据不伪造总bbox', () => {
  const result = {
    bbox: [-180, -80, 180, 80],
    evidence: {
      ais: [],
      documents: [
        { bbox: [120, 30, 121, 31] as [number, number, number, number] },
        { bbox: [179, -2, -179, 2] as [number, number, number, number] },
        { bbox: null },
      ],
    },
  };
  expect(resultSelectionGeometries(result)).toEqual([
    {
      type: 'Polygon',
      coordinates: [
        [
          [120, 30],
          [121, 30],
          [121, 31],
          [120, 31],
          [120, 30],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [179, -2],
          [180, -2],
          [180, 2],
          [179, 2],
          [179, -2],
        ],
      ],
    },
    {
      type: 'Polygon',
      coordinates: [
        [
          [-180, -2],
          [-179, -2],
          [-179, 2],
          [-180, 2],
          [-180, -2],
        ],
      ],
    },
  ]);
  expect(resultSelectionGeometries({ ...result, evidence: { ais: [], documents: [] } })).toEqual(
    [],
  );
});
it('多船结果按MMSI形成独立几何并按观测时间排序，单点船舶保留Point', () => {
  const result = {
    evidence: {
      ais: [
        { mmsi: '413000001', longitude: 122, latitude: 32, occurredAt: '2026-10-25T02:00:00Z' },
        { mmsi: '413000002', longitude: -120, latitude: -30, occurredAt: '2026-10-25T01:00:00Z' },
        { mmsi: '413000001', longitude: 121, latitude: 31, occurredAt: '2026-10-25T01:00:00Z' },
      ],
      documents: [],
    },
  };
  expect(resultSelectionGeometries(result)).toEqual([
    {
      type: 'LineString',
      coordinates: [
        [121, 31],
        [122, 32],
      ],
    },
    { type: 'Point', coordinates: [-120, -30] },
  ]);
  expect(result.evidence.ais[0]?.longitude).toBe(122);
});
import {
  chartEffectVisualViewport,
  intersectChartEffectViewports,
} from './app/composables/useChartEffects';
import { cameraOverlayRects } from './app/utils/mapCamera';
it('详情视觉预算与导航视口独立，每真实地图帧更新一次并在详情关闭后恢复', () => {
  let rendered = () => {};
  let visualReads = 0;
  const camera = { zoom: 4 };
  const viewport = { left: 24, top: 24, right: 976, bottom: 500 };
  const canvas = { left: 100, top: 200, right: 1100, bottom: 800 };
  const detail = {
    visible: true,
    inert: false,
    getClientRects: () => ({ length: 1 }),
    getBoundingClientRect: () => ({ left: 100, top: 200, right: 520, bottom: 800 }),
    closest: (selector: string) =>
      selector === '[inert]' && detail.inert
        ? { getAttribute: () => null }
        : selector === '[data-side]'
          ? { getAttribute: () => 'left' }
          : null,
    classList: { contains: () => false },
  };
  const map = createChartEffectProjection(
    {
      cameraState: () => camera,
      focusViewport: () => viewport,
      projectFocus: (_point: [number, number]) => null,
      onFocusRender: (listener: () => void) => {
        rendered = listener;
        return () => {};
      },
    },
    (view) => {
      visualReads++;
      return chartEffectVisualViewport(
        view,
        canvas,
        cameraOverlayRects([detail], { visible: (node) => node.visible }),
      );
    },
  );
  expect(map.cameraState()).toBe(camera);
  expect(map.focusViewport()).toBe(viewport);
  expect(map.effectViewport()).toEqual({ left: 444, top: 24, right: 976, bottom: 500 });
  for (let i = 0; i < 100; i++) {
    map.effectViewport();
    map.projectFocus([120, 30]);
  }
  expect(visualReads).toBe(1);
  detail.visible = false;
  rendered();
  expect(map.effectViewport()).toEqual(viewport);
  detail.visible = true;
  detail.inert = true;
  rendered();
  expect(map.effectViewport()).toEqual(viewport);
  expect(visualReads).toBe(3);
  expect(map.focusViewport()).toBe(viewport);
  map.disposeEffectProjection();
});
it('详情视觉预算与回复卡最终预算只求交，多次合成不重复扣空间', () => {
  const visual = { left: 444, top: 24, right: 976, bottom: 500 };
  const reply = { left: 24, top: 24, right: 600, bottom: 500 };
  const final = intersectChartEffectViewports(visual, reply);
  expect(final).toEqual({ left: 444, top: 24, right: 600, bottom: 500 });
  expect(intersectChartEffectViewports(final, reply)).toEqual(final);
  expect(
    intersectChartEffectViewports(visual, { left: 24, top: 24, right: 300, bottom: 500 }).right,
  ).toBe(444);
});
import { chartAttentionFeedbackVisible } from './app/composables/useChartEffects';
it('减少动态模式的独立强调仍展示24px静态反馈，后台暂停与结束隐藏且不放行动态阶段', () => {
  const request = {
    id: 'standalone',
    icon: 'alert' as const,
    targets: [
      {
        key: 'event:standalone:1',
        geometries: [{ type: 'Point' as const, coordinates: [120, 30] as [number, number] }],
      },
    ],
  };
  const frame = { request, phase: 'static' as const, visible: true, elapsed: 0, size: 24 };
  expect(chartAttentionFeedbackVisible(frame, false, true)).toBe(true);
  expect(chartAttentionFeedbackVisible(frame, true, true)).toBe(false);
  expect(
    chartAttentionFeedbackVisible({ ...frame, phase: 'done', visible: false }, false, true),
  ).toBe(false);
  expect(chartAttentionFeedbackVisible({ ...frame, phase: 'blink' }, false, true)).toBe(false);
  expect(chartAttentionFeedbackVisible({ ...frame, phase: 'contract' }, false, true)).toBe(false);
});
import { chartAttentionHasPermanentGlyph } from './app/composables/useChartEffects';
it('静态强调仅复用同实体同图同色的常驻点glyph，独立请求和不同样式仍输出SVG', () => {
  const target = {
    key: 'vessel:413000001',
    icon: 'vessel' as const,
    bearing: 90,
    geometries: [{ type: 'Point' as const, coordinates: [120, 30] as [number, number] }],
  };
  const request = { id: 'static', icon: 'vessel' as const, targets: [target] };
  expect(chartAttentionHasPermanentGlyph(request, target, [target])).toBe(true);
  expect(chartAttentionHasPermanentGlyph({ ...request, color: '#ffd84d' }, target, [target])).toBe(
    true,
  );
  expect(chartAttentionHasPermanentGlyph({ ...request, icon: 'danger' }, target, [target])).toBe(
    false,
  );
  expect(chartAttentionHasPermanentGlyph({ ...request, color: '#FF0000' }, target, [target])).toBe(
    false,
  );
  expect(chartAttentionHasPermanentGlyph(request, target, [])).toBe(false);
  expect(chartAttentionHasPermanentGlyph(request, target, [{ ...target, key: 'other' }])).toBe(
    false,
  );
  expect(
    chartAttentionHasPermanentGlyph(request, target, [
      {
        ...target,
        geometries: [
          {
            type: 'LineString',
            coordinates: [
              [120, 30],
              [121, 31],
            ],
          },
        ],
      },
    ]),
  ).toBe(false);
  const unknown = { ...target, icon: undefined, bearing: undefined };
  expect(
    chartAttentionHasPermanentGlyph({ ...request, targets: [unknown] }, unknown, [unknown]),
  ).toBe(true);
});
import { chartEffectReplyViewport } from './app/composables/useChartEffects';
import { focusObjectViewport } from './app/utils/focusLayout';
it('回复实际高度222与构图上限360分别形成视觉和构图预算，可见y403点保持可选', () => {
  const view = { left: 24, top: 24, right: 1500, bottom: 900 };
  const layout = { side: 'top' as const, width: 420, maxHeight: 360, objectMinHeight: 200 };
  const composition = focusObjectViewport(
    view,
    layout.side,
    layout.width,
    layout.maxHeight,
    layout.objectMinHeight,
  );
  const visual = chartEffectReplyViewport(view, layout, 222);
  expect(composition.top).toBe(432);
  expect(visual.top).toBe(294);
  expect(403 >= visual.top && 403 <= visual.bottom).toBe(true);
  expect(403 >= composition.top && 403 <= composition.bottom).toBe(false);
});
import { chartFocusEffectsReady } from './app/composables/useChartEffects';
it('AI点关注等待当前GL原快照真实回执，pending与旧代次不确认，纯SVG线面保留原帧语义', () => {
  const point = {
    key: 'vessel:413000001',
    geometries: [{ type: 'Point' as const, coordinates: [120, 30] as [number, number] }],
  };
  const oldSnapshot = [point];
  const current = [{ ...point, observedAt: '2026-10-25T03:00:00Z' }];
  expect(chartFocusEffectsReady([point], current, null)).toBe(false);
  expect(chartFocusEffectsReady([point], current, oldSnapshot)).toBe(false);
  expect(chartFocusEffectsReady([point], current, current)).toBe(true);
  const nextGeneration = [...current];
  expect(chartFocusEffectsReady([point], nextGeneration, current)).toBe(false);
  const line = {
    key: 'track:t:1',
    geometries: [
      {
        type: 'LineString' as const,
        coordinates: [
          [120, 30],
          [121, 31],
        ] as [number, number][],
      },
    ],
  };
  expect(chartFocusEffectsReady([line], [line], null)).toBe(true);
  expect(chartFocusEffectsReady([], current, null)).toBe(true);
  expect(
    chartFocusEffectsReady(
      [{ ...point, geometries: [{ type: 'MultiPoint', coordinates: [[120, 30]] }] }],
      current,
      null,
    ),
  ).toBe(false);
});
it('公开select(null)等价取消并立即使旧选择代次失效', () => {
  const effects = useChartEffects();
  const current = effects.select({ kind: 'vessel', id: '413000001', geometries: [] });
  effects.select(null);
  expect(effects.selected.value).toBeNull();
  expect(current()).toBe(false);
});
it('直接MapEffectTarget保留含冒号opaque key及显式元数据，补几何保持原key', () => {
  const effects = useChartEffects();
  const key = 'source:route:a:b:revision:7';
  const current = effects.select({ key, geometries: [], icon: 'alert' });
  expect(effects.selected.value).toMatchObject({ key, kind: 'opaque', id: key });
  effects.updateSelected(current, [{ type: 'Point', coordinates: [120, 30] }], 8);
  expect(effects.selected.value?.key).toBe(key);
  effects.select({
    key: 'canonical:key:unchanged',
    kind: 'event',
    id: 'event:a',
    revision: 3,
    geometries: [],
  });
  expect(effects.selected.value).toMatchObject({
    key: 'canonical:key:unchanged',
    kind: 'event',
    id: 'event:a',
    revision: 3,
  });
});
it('便利业务选择保留版本拼接，标准船舶Target继续跟随最新合法船位', () => {
  const effects = useChartEffects();
  const current = effects.select({ kind: 'event', id: 'event:a', revision: 3, geometries: [] });
  expect(effects.selected.value?.key).toBe('event:event:a:3');
  effects.updateSelected(current, [], 4);
  expect(effects.selected.value?.key).toBe('event:event:a:4');
  effects.select({ key: 'vessel:413000001', geometries: [] });
  effects.updateVessels([
    { mmsi: '413000001', lon: 123, lat: 33, observedAt: '2026-10-25T03:00:00Z' },
  ]);
  expect(effects.selected.value).toMatchObject({
    key: 'vessel:413000001',
    kind: 'vessel',
    id: '413000001',
    geometries: [{ type: 'Point', coordinates: [123, 33] }],
  });
});
