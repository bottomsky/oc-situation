import { expect, it, vi } from 'vitest';
import { MercatorCoordinate } from 'maplibre-gl';
import * as focusCamera from './app/utils/focusCamera';
import type { CameraPadding } from './app/utils/mapCamera';
import { placeFocusReply } from './app/utils/focusLayout';

const zero = { left: 0, right: 0, top: 0, bottom: 0 };
const base = { left: 24, right: 24, top: 24, bottom: 24 };
function fixture(retained: CameraPadding = zero, width = 1200, height = 800) {
  const map = {
    getPadding: () => ({ ...retained }),
    cameraForBounds: vi.fn(
      (bounds: [[number, number], [number, number]], options: { padding: CameraPadding }) => {
        const a = MercatorCoordinate.fromLngLat(bounds[0]),
          b = MercatorCoordinate.fromLngLat(bounds[1]);
        const w =
          width - retained.left - retained.right - options.padding.left - options.padding.right;
        const h =
          height - retained.top - retained.bottom - options.padding.top - options.padding.bottom;
        return {
          zoom: Math.min(
            10,
            Math.log2(Math.min(w / Math.abs(b.x - a.x), h / Math.abs(b.y - a.y)) / 512),
          ),
        };
      },
    ),
  };
  const plan = (bbox: [number, number, number, number] = [120, 30, 121, 31]) => {
    expect(typeof focusCamera.estimateFocusCamera).toBe('function');
    return focusCamera.estimateFocusCamera(map, bbox, { width, height }, base, {
      cardWidth: 420,
      cardHeight: 300,
    });
  };
  return { map, plan };
}

it('只读预估选择组右侧并返回一次bounds动作，预留卡片后仍有240px对象空间', () => {
  const { map, plan } = fixture();
  const value = plan()!;
  expect(value.placement).toBe('right');
  expect(value.zoom).toBeGreaterThanOrEqual(4);
  expect(value.request).toEqual({ mode: 'bounds', bbox: [120, 30, 121, 31], maxZoom: 10 });
  expect(map.cameraForBounds).toHaveBeenCalledTimes(1);
  expect(map.getPadding()).toEqual(zero);
});

it('相同bbox的零与非零旧padding预估一致，不累加前一次卡片占位', () => {
  const a = fixture(),
    b = fixture({ left: 180, right: 240, top: 10, bottom: 40 });
  expect(b.plan()?.zoom).toBeCloseTo(a.plan()!.zoom, 9);
  expect(b.plan()).toEqual(b.plan());
  expect(b.map.getPadding()).toEqual({ left: 180, right: 240, top: 10, bottom: 40 });
});

it('分散组及窄视窗采用顶部布局而非再次移动相机试探', () => {
  expect(fixture().plan([-170, -50, 170, 70])?.placement).toBe('top');
  expect(fixture(zero, 650).plan()?.placement).toBe('top');
});

it('日期线短弧、极纬和单点均返回有限预估且上限10', () => {
  const { plan } = fixture();
  const crossing = plan([179, 10, -179, 12])!;
  expect(crossing.placement).toBe('right');
  expect(crossing.zoom).toBeGreaterThan(7);
  for (const bbox of [
    [120, 90, 121, 90],
    [120, -90, 121, -90],
    [120, 30, 120, 30],
  ] as [number, number, number, number][]) {
    const value = plan(bbox)!;
    expect(Number.isFinite(value.zoom)).toBe(true);
    expect(value.zoom).toBeLessThanOrEqual(10);
  }
});

it('卡片占位计算不修改传入边距，顶部留出最小对象区域', () => {
  expect(typeof focusCamera.focusReplyPadding).toBe('function');
  const padding = focusCamera.focusReplyPadding(
    base,
    { width: 1200, height: 800 },
    { replyPlacement: 'right', cardWidth: 420, cardHeight: 300 },
  );
  expect(padding).toEqual({ ...base, right: 492 });
  expect(base).toEqual({ left: 24, right: 24, top: 24, bottom: 24 });
  expect(
    focusCamera.focusReplyPadding(
      base,
      { width: 650, height: 240 },
      { replyPlacement: 'top', cardWidth: 420, cardHeight: 300 },
    ).top,
  ).toBe(136);
});

it('一次bounds适配即为光环、24px间距和卡片安全边界留下足够空间', () => {
  const padding = focusCamera.focusReplyPadding(
    base,
    { width: 1200, height: 800 },
    { replyPlacement: 'right', cardWidth: 420, cardHeight: 240 },
  );
  // A wide bounds fit puts its easternmost object exactly on the reserved edge.
  const edge = 1200 - padding.right;
  const layout = placeFocusReply(
    { left: 24, top: 24, right: 1176, bottom: 776 },
    { left: 200, right: edge, top: 180, bottom: 400 },
    420,
    240,
    'right',
    2,
  );
  expect(layout.side).toBe('right');
  expect(layout.left + layout.width).toBeLessThanOrEqual(1164);
});

it('右侧方案因分散降为顶部时重新使用同一顶部物理预算', () => {
  const { map } = fixture(zero, 1200, 547);
  const plan = focusCamera.estimateFocusCamera(
    map,
    [-170, -50, 170, 70],
    { width: 1200, height: 547 },
    { left: 24, right: 24, top: 24, bottom: 284 },
    { cardWidth: 420, cardHeight: 213 },
  )!;
  expect(plan.placement).toBe('top');
  expect(plan.cardHeight).toBe(111);
  expect(plan.objectMinHeight).toBe(80);
});
