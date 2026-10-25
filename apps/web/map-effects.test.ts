import { describe, expect, it, vi } from 'vitest';
import type { MapAttentionRequest, MapEffectFrame, MapEffectTarget } from './app/types/mapEffects';
import * as effects from './app/utils/mapEffects';
import * as clockModule from './app/utils/mapEffectsClock';

const viewport = { left: 0, top: 0, right: 300, bottom: 200 };
const project = ([x, y]: [number, number]) => ({ x, y });
const point: MapEffectTarget = {
  key: 'ship',
  geometries: [{ type: 'Point', coordinates: [100, 80] }],
};
const request = (id: string, count = 1): MapAttentionRequest => ({
  id,
  icon: 'alert',
  targets: Array.from({ length: count }, (_, i) => ({ ...point, key: `${id}-${i}` })),
});

describe('共享图形、选中框与可见几何', () => {
  it('点框固定44px且四角长度10px', () => {
    expect(effects.MAP_EFFECT_COLOR).toBe('#FFD84D');
    const result = effects.projectMapEffect(point, { viewport, project });
    expect(result?.bounds).toEqual({ left: 78, top: 58, right: 122, bottom: 102 });
    const path = effects.mapEffectCornerPath(result!.bounds);
    expect(path.match(/M/g)).toHaveLength(4);
    expect(path).toContain('M88 58H78V68');
  });
  it('裁剪真实线段，离屏包围盒与视口重叠不产生假框', () => {
    const missed: MapEffectTarget = {
      key: 'miss',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [-100, 20],
            [20, -100],
          ],
        },
      ],
    };
    expect(effects.projectMapEffect(missed, { viewport, project })).toBeNull();
    const crossing: MapEffectTarget = {
      key: 'cross',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [-20, 100],
            [100, 40],
          ],
        },
      ],
    };
    expect(effects.projectMapEffect(crossing, { viewport, project })?.bounds).toEqual({
      left: -8,
      top: 32,
      right: 108,
      bottom: 98,
    });
  });
  it('填充面覆盖视口仍有框，视口全处孔洞中没有框', () => {
    const outer: [number, number][] = [
      [-10, -10],
      [40, -10],
      [40, 40],
      [-10, 40],
      [-10, -10],
    ];
    const polygon: MapEffectTarget = {
      key: 'area',
      geometries: [{ type: 'Polygon', coordinates: [outer] }],
    };
    const scaled = ([x, y]: [number, number]) => ({ x: x * 10, y: y * 10 });
    expect(effects.projectMapEffect(polygon, { viewport, project: scaled })?.bounds).toEqual({
      left: -8,
      top: -8,
      right: 308,
      bottom: 208,
    });
    polygon.geometries = [
      {
        type: 'Polygon',
        coordinates: [
          outer,
          [
            [-5, -5],
            [35, -5],
            [35, 25],
            [-5, 25],
            [-5, -5],
          ],
        ],
      },
    ];
    expect(effects.projectMapEffect(polygon, { viewport, project: scaled })).toBeNull();
  });
  it('日期变更线使用连续世界副本', () => {
    const seen: number[] = [];
    const wrappedProject = ([lon, lat]: [number, number]) => {
      seen.push(lon);
      return { x: (lon - 178) * 50, y: 100 - lat };
    };
    const target: MapEffectTarget = {
      key: 'date',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [179, 0],
            [-179, 0],
          ],
        },
      ],
    };
    expect(
      effects.projectMapEffect(target, { viewport, project: wrappedProject, anchorLongitude: 180 })
        ?.bounds,
    ).toEqual({ left: 42, top: 92, right: 158, bottom: 108 });
    expect(seen).toEqual([179, 181]);
  });
  it('一次投影同时提供完整bbox与真实可见描边，孔洞裁掉视口边缘', () => {
    const target: MapEffectTarget = {
      key: 'outline',
      geometries: [
        {
          type: 'LineString',
          coordinates: [
            [-20, 100],
            [100, 40],
          ],
        },
      ],
    };
    const line = effects.projectMapEffectGeometry(target, { viewport, project });
    expect(line?.fullBounds).toEqual({ left: -20, top: 40, right: 100, bottom: 100 });
    expect(line?.outlinePath).toBe('M0 90L100 40');
    const scaled = ([x, y]: [number, number]) => ({ x: x * 10, y: y * 10 });
    const area: MapEffectTarget = {
      key: 'hole',
      geometries: [
        {
          type: 'Polygon',
          coordinates: [
            [
              [-10, -10],
              [40, -10],
              [40, 40],
              [-10, 40],
              [-10, -10],
            ],
            [
              [10, -5],
              [20, -5],
              [20, 25],
              [10, 25],
              [10, -5],
            ],
          ],
        },
      ],
    };
    const polygon = effects.projectMapEffectGeometry(area, { viewport, project: scaled });
    expect(polygon?.outlinePath).toContain('M0 0L100 0');
    expect(polygon?.outlinePath).toContain('M200 0L300 0');
    expect(polygon?.outlinePath).not.toContain('M100 0L200 0');
    const offscreen = effects.projectMapEffectGeometry(
      { ...point, geometries: [{ type: 'Point', coordinates: [-10, -10] }] },
      { viewport, project },
    );
    expect(offscreen?.bounds).toBeNull();
    expect(offscreen?.fullBounds).toEqual({ left: -10, top: -10, right: -10, bottom: -10 });
  });
  it('本地图形RGBA按图形与颜色缓存，辉光沿glyph而非圆圈', () => {
    for (const icon of ['vessel', 'unknown', 'alert', 'danger', 'opportunity'] as const) {
      expect(effects.mapEffectGlyphPath(icon)).toMatch(/^M/);
      const image = effects.mapEffectGlyphImage(icon);
      expect(effects.mapEffectGlyphImage(icon)).toBe(image);
      expect(image.data.some((channel, i) => i % 4 === 3 && channel > 0)).toBe(true);
      expect(image.data[(image.width + 1) * 4 + 3]).toBe(0);
      expect(effects.mapEffectGlyphImage(icon, '#00FF00')).not.toBe(image);
    }
    expect(effects.mapEffectGlyphPath('alert')).not.toContain('A');
    expect(effects.mapEffectGlyphPath('unknown')).not.toBe(effects.mapEffectGlyphPath('vessel'));
  });
  it('SVG与RGBA共用绘制语义，船形与感叹号主体实心黄色、未知方向保持中空', () => {
    expect(effects).toHaveProperty('mapEffectGlyphPaint');
    expect(effects.mapEffectGlyphPaint('vessel').fill).toBe('currentColor');
    expect(effects.mapEffectGlyphPaint('alert').fill).toBe('currentColor');
    expect(effects.mapEffectGlyphPaint('unknown').fill).toBe('none');
    expect(effects.mapEffectGlyphPaint('vessel')).toMatchObject({
      'stroke-width': 1.5,
      'fill-rule': 'evenodd',
    });
    for (const icon of ['vessel', 'alert'] as const) {
      const image = effects.mapEffectGlyphImage(icon);
      const offset = (44 * image.width + 44) * 4;
      expect([...image.data.slice(offset, offset + 4)]).toEqual([255, 216, 77, 255]);
    }
    const unknown = effects.mapEffectGlyphImage('unknown');
    expect(unknown.data[(44 * unknown.width + 44) * 4 + 3]).toBe(0);
  });
  it('只有船形跟随目标方向，感叹号及其余预设保持屏幕正向', () => {
    expect(effects).toHaveProperty('mapEffectGlyphBearing');
    expect(effects.mapEffectGlyphBearing('vessel', 90)).toBe(90);
    expect(effects.mapEffectGlyphBearing('vessel')).toBe(0);
    for (const icon of ['unknown', 'alert', 'danger', 'opportunity'] as const)
      expect(effects.mapEffectGlyphBearing(icon, 90)).toBe(0);
  });
  it('共享目标图标缺省规则供GL和静态去重复用', () => {
    expect(effects).toHaveProperty('mapEffectTargetIcon');
    expect(effects.mapEffectTargetIcon(point)).toBe('unknown');
    expect(effects.mapEffectTargetIcon({ ...point, bearing: 0 })).toBe('vessel');
    expect(effects.mapEffectTargetIcon({ ...point, bearing: 90, icon: 'alert' })).toBe('alert');
  });
});

describe('三拍时间采样与单时钟队列', () => {
  it('600ms收至24px，120灭、200亮120灭两次，总计1360ms', () => {
    expect(effects.sampleMapAttention(0, 900)).toEqual({
      phase: 'contract',
      visible: true,
      size: 300,
    });
    expect(effects.sampleMapAttention(300, 900).size).toBeGreaterThan(24);
    for (const [time, visible] of [
      [600, false],
      [720, true],
      [920, false],
      [1040, true],
      [1240, false],
    ] as const)
      expect(effects.sampleMapAttention(time, 900)).toMatchObject({
        phase: 'blink',
        visible,
        size: 24,
      });
    expect(effects.sampleMapAttention(1360, 900)).toEqual({
      phase: 'done',
      visible: false,
      size: 24,
    });
  });
  function harness() {
    let next = 0;
    let wallNow = 0;
    const pending = new Map<number, FrameRequestCallback>();
    const deadlines = new Map<number, { at: number; callback: () => void }>();
    const output: MapEffectFrame[] = [];
    const frames = {
      request: vi.fn((callback: FrameRequestCallback) => {
        pending.set(++next, callback);
        return next;
      }),
      cancel: vi.fn((id: number) => {
        pending.delete(id);
      }),
    };
    const clock = clockModule.createMapEffectClock({
      frames,
      onFrame: (frame) => output.push(frame),
      shortSide: () => 600,
      timers: {
        now: () => wallNow,
        set: (callback, delay) => {
          deadlines.set(++next, { at: wallNow + delay, callback });
          return next;
        },
        clear: (id) => {
          deadlines.delete(id as number);
        },
      },
    });
    const tick = (time: number) => {
      wallNow = time;
      const callbacks = [...pending.values()];
      pending.clear();
      callbacks.forEach((callback) => callback(time));
    };
    const advance = (duration: number) => {
      wallNow += duration;
      const due = [...deadlines].filter(([, timer]) => timer.at <= wallNow);
      for (const [id, timer] of due) {
        deadlines.delete(id);
        timer.callback();
      }
    };
    return { clock, output, pending, frames, tick, advance, deadlines };
  }
  it('100对象共享一次RAF，30fps取样、结束停表，重复请求不重播', () => {
    const h = harness();
    expect(h.clock.enqueue(request('batch', 100))).toBe(true);
    expect(h.clock.enqueue(request('batch', 100))).toBe(false);
    h.clock.update({ active: true, hidden: false, reduced: false });
    expect(h.pending.size).toBe(1);
    h.tick(0);
    const initial = h.output.length;
    h.tick(16);
    expect(h.output).toHaveLength(initial);
    h.tick(34);
    expect(h.output).toHaveLength(initial + 1);
    h.tick(1360);
    expect(h.output.at(-1)?.phase).toBe('done');
    expect(h.pending.size).toBe(0);
    expect(h.clock.enqueue(request('batch', 100))).toBe(false);
  });
  it('排队顺序播放，后台暂停不消费隐藏时长，取消恢复结束帧', () => {
    const h = harness();
    h.clock.enqueue(request('first'));
    h.clock.enqueue(request('second'));
    h.clock.update({ active: true, hidden: false, reduced: false });
    h.tick(0);
    h.tick(200);
    expect(h.output.at(-1)?.request?.id).toBe('first');
    h.clock.update({ active: true, hidden: true, reduced: false });
    expect(h.pending.size).toBe(0);
    h.clock.update({ active: true, hidden: false, reduced: false });
    h.tick(10000);
    expect(h.clock.now()).toBe(200);
    h.tick(11160);
    expect(h.output.at(-1)?.request?.id).toBe('second');
    expect(h.output.at(-1)?.elapsed).toBe(0);
    h.clock.cancel();
    expect(h.output.at(-1)?.phase).toBe('done');
    expect(h.pending.size).toBe(0);
  });
  it('reduced模式静态可见且无RAF，退出恢复并清空队列', () => {
    const h = harness();
    h.clock.update({ active: true, hidden: false, reduced: true });
    h.clock.enqueue(request('static'));
    expect(h.pending.size).toBe(0);
    expect(h.output.at(-1)).toMatchObject({ phase: 'static', visible: true, size: 24 });
    h.clock.update({ active: true, hidden: false, reduced: false });
    h.clock.enqueue(request('dynamic'));
    h.tick(100);
    h.clock.update({ active: false, hidden: false, reduced: false });
    expect(h.output.at(-1)?.phase).toBe('done');
    expect(h.pending.size).toBe(0);
    h.clock.dispose();
  });
  it('只取消排队请求不隐藏活动目标，活动请求取消回调可安全重入', () => {
    const h = harness();
    h.clock.enqueue(request('first'));
    h.clock.enqueue(request('queued'));
    h.clock.update({ active: true, hidden: false, reduced: false });
    h.tick(0);
    h.clock.cancel('queued');
    expect(h.output.at(-1)?.request?.id).toBe('first');
    expect(h.output.at(-1)?.phase).toBe('contract');
    const output: MapEffectFrame[] = [];
    const clock = clockModule.createMapEffectClock({
      frames: h.frames,
      onFrame: (frame) => {
        output.push(frame);
        if (frame.phase === 'done') clock.cancel();
      },
    });
    clock.update({ active: true, hidden: false, reduced: false });
    clock.enqueue(request('reentrant'));
    clock.cancel();
    expect(output.filter((frame) => frame.phase === 'done')).toHaveLength(1);
    h.clock.dispose();
  });
  it.each(['complete', 'cancel', 'reduced', 'inactive', 'dispose'] as const)(
    '%s结束帧仅保留请求元数据，释放目标引用且保留输入快照',
    (exit) => {
      const h = harness();
      const input = { ...request('release', 100), color: '#FFD84D' };
      const targets = input.targets;
      h.clock.enqueue(input);
      h.clock.update({ active: true, hidden: false, reduced: false });
      h.tick(0);
      expect(h.clock.current().request).toBe(input);
      if (exit === 'complete') h.tick(1360);
      else if (exit === 'cancel') h.clock.cancel();
      else if (exit === 'reduced') {
        h.clock.update({ active: true, hidden: false, reduced: true });
        h.advance(1360);
      } else if (exit === 'inactive')
        h.clock.update({ active: false, hidden: false, reduced: false });
      else h.clock.dispose();
      const done = h.clock.current();
      expect(done).toBe(h.output.at(-1));
      expect(done.phase).toBe('done');
      expect(done.request).toEqual({ id: 'release', icon: 'alert', color: '#FFD84D', targets: [] });
      expect(done.request).not.toBe(input);
      expect(input.targets).toBe(targets);
      expect(input.targets).toHaveLength(100);
      expect(h.pending.size).toBe(0);
    },
  );
  it('独立reduced请求静态可见1360ms，100对象和顺序队列仅一个截止timer', () => {
    const h = harness();
    h.clock.update({ active: true, hidden: false, reduced: true });
    const input = request('static-only', 100);
    h.clock.enqueue(input);
    h.clock.enqueue(request('queued-static'));
    expect(h.clock.current()).toMatchObject({
      request: input,
      phase: 'static',
      elapsed: 0,
      size: 24,
      visible: true,
    });
    expect(h.pending.size).toBe(0);
    expect(h.deadlines.size).toBe(1);
    const emitted = h.output.length;
    h.advance(1359);
    expect(h.output).toHaveLength(emitted);
    h.advance(1);
    expect(h.output.at(-2)).toMatchObject({
      phase: 'done',
      request: { id: 'static-only', targets: [] },
    });
    expect(h.clock.current()).toMatchObject({ phase: 'static', request: { id: 'queued-static' } });
    expect(h.deadlines.size).toBe(1);
    h.advance(1360);
    expect(h.clock.current().phase).toBe('done');
    expect(h.deadlines.size).toBe(0);
    expect(h.clock.enqueue(input)).toBe(false);
    expect(h.pending.size).toBe(0);
  });
  it('reduced隐藏暂停剩余时间，中途切换动态与静态沿用已有elapsed', () => {
    const h = harness();
    h.clock.update({ active: true, hidden: false, reduced: true });
    h.clock.enqueue(request('pause'));
    h.advance(300);
    h.clock.update({ active: true, hidden: false, reduced: false });
    h.tick(300);
    expect(h.clock.current()).toMatchObject({ elapsed: 300, phase: 'contract' });
    h.tick(500);
    h.clock.update({ active: true, hidden: false, reduced: true });
    expect(h.clock.current()).toMatchObject({ elapsed: 500, phase: 'static' });
    h.advance(200);
    h.clock.update({ active: true, hidden: true, reduced: true });
    expect(h.clock.now()).toBe(700);
    expect(h.deadlines.size).toBe(0);
    h.advance(10000);
    h.clock.update({ active: true, hidden: false, reduced: true });
    expect(h.clock.current()).toMatchObject({ elapsed: 700, phase: 'static' });
    h.advance(659);
    expect(h.clock.current().phase).toBe('static');
    h.advance(1);
    expect(h.clock.current()).toMatchObject({ phase: 'done', request: { targets: [] } });
    expect(h.deadlines.size).toBe(0);
  });
  it.each(['cancel', 'inactive', 'dispose'] as const)(
    'reduced %s清除截止timer并释放目标',
    (exit) => {
      const h = harness();
      h.clock.update({ active: true, hidden: false, reduced: true });
      h.clock.enqueue(request('release-static', 100));
      h.clock.enqueue(request('queued-static'));
      expect(h.deadlines.size).toBe(1);
      if (exit === 'cancel') h.clock.cancel();
      else if (exit === 'inactive') h.clock.update({ active: false, hidden: false, reduced: true });
      else h.clock.dispose();
      expect(h.clock.current()).toMatchObject({
        phase: 'done',
        request: { id: 'release-static', targets: [] },
      });
      expect(h.deadlines.size).toBe(0);
      expect(h.pending.size).toBe(0);
      h.advance(5000);
      expect(h.clock.current().request?.id).toBe('release-static');
    },
  );
});
