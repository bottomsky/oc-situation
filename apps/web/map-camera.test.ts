import { expect, it, vi } from 'vitest';
import { cameraBounds, cameraPadding, createMapCamera } from './app/utils/mapCamera';
import * as mapCamera from './app/utils/mapCamera';
import { placeFocusReply } from './app/utils/focusLayout';

function overlayNode(
  side: 'left' | 'right' | undefined,
  rect: { left: number; right: number; top: number; bottom: number },
  dock = false,
) {
  return {
    getClientRects: () => ({ length: 1 }),
    getBoundingClientRect: () => rect,
    closest: (selector: string) =>
      selector === '[data-side]' && side ? { getAttribute: () => side } : null,
    classList: { contains: (name: string) => dock && name === 'chart-agent-dock' },
  };
}

it('全屏外面板即使仍有可见布局rect也不压缩图区，全屏内输入条仍参与遮挡', () => {
  expect(typeof mapCamera.cameraOverlayRects).toBe('function');
  const view = { left: 0, right: 600, top: 0, bottom: 800 };
  const outside = overlayNode('right', view);
  const dock = overlayNode(undefined, { left: 40, right: 560, top: 700, bottom: 760 }, true);
  const nodes = [outside, dock];
  const visible = () => true;
  const normal = cameraPadding(view, mapCamera.cameraOverlayRects(nodes, { visible }));
  expect(view.right - normal.left - normal.right).toBeCloseTo(1);
  const fullscreen = { contains: (node: typeof outside) => node === dock };
  const overlays = mapCamera.cameraOverlayRects(nodes, { fullscreen, visible });
  expect(overlays).toEqual([{ ...dock.getBoundingClientRect(), side: 'bottom', gap: 8 }]);
  const padding = cameraPadding(view, overlays);
  expect(padding.left).toBe(24);
  expect(padding.right).toBe(24);
  expect(padding.bottom).toBe(108);
  const card = placeFocusReply(
    {
      left: padding.left,
      right: view.right - padding.right,
      top: padding.top,
      bottom: view.bottom - padding.bottom,
    },
    null,
    420,
    160,
  );
  expect(card.width).toBe(420);
});

it('正常模式保留左右面板，全屏内明确右抽屉与隐藏状态按原规则计算', () => {
  expect(typeof mapCamera.cameraOverlayRects).toBe('function');
  const left = overlayNode('left', { left: 0, right: 250, top: 0, bottom: 800 });
  const right = overlayNode('right', { left: 800, right: 1200, top: 0, bottom: 800 });
  expect(
    mapCamera.cameraOverlayRects([left, right], { visible: () => true }).map((rect) => rect.side),
  ).toEqual(['left', 'right']);
  expect(
    mapCamera
      .cameraOverlayRects([left, right], {
        fullscreen: { contains: () => true },
        visible: (node) => node !== right,
      })
      .map((rect) => rect.side),
  ).toEqual(['left']);
});
it('短图区为输入胶囊保留真实底部空间，减少上下装饰留白', () => {
  const padding = cameraPadding({ left: 0, right: 378, top: 280, bottom: 568 }, [
    { left: 20, right: 358, top: 444, bottom: 504, gap: 8 },
  ]);
  expect(padding.top).toBe(8);
  expect(padding.bottom).toBe(132);
  expect(288 - padding.top - padding.bottom).toBe(148);
});

it('抬升至地图中部的输入条仍是底部障碍，回复始终保留输入条上方空间', () => {
  const view = { left: 0, right: 1000, top: 0, bottom: 600 };
  const originalDock = overlayNode(
    undefined,
    { left: 300, right: 700, top: 440, bottom: 510 },
    true,
  );
  const originalPadding = cameraPadding(
    view,
    mapCamera.cameraOverlayRects([originalDock], { visible: () => true }),
  );
  expect(view.bottom - originalPadding.bottom).toBe(440 - 8);
  const dock = overlayNode(undefined, { left: 300, right: 700, top: 280, bottom: 350 }, true);
  const overlays = mapCamera.cameraOverlayRects([dock], { visible: () => true });
  const padding = cameraPadding(view, overlays);
  expect(padding.bottom).toBe(328);
  expect(view.bottom - padding.bottom).toBe(280 - 8);
  const reply = placeFocusReply(
    {
      left: padding.left,
      right: view.right - padding.right,
      top: padding.top,
      bottom: view.bottom - padding.bottom,
    },
    null,
    420,
    360,
  );
  expect(reply.top + reply.maxHeight).toBeLessThan(dock.getBoundingClientRect().top);
});
it('600px右侧drawer按身份保留真实左侧空间，高遮挡不虚增可用宽度', () => {
  const view = { left: 5, right: 595, top: 200, bottom: 800 };
  const padding = cameraPadding(view, [
    { side: 'right', left: 256, right: 596, top: 170, bottom: 800 },
  ]);
  expect(padding.left).toBe(24);
  expect(padding.right).toBe(363);
  expect(590 - padding.left - padding.right).toBe(203);
  const blocked = cameraPadding({ left: 0, right: 390, top: 0, bottom: 600 }, [
    { side: 'right', left: 24, right: 390, top: 0, bottom: 600 },
  ]);
  expect(390 - blocked.left - blocked.right).toBeCloseTo(1);
});

it('跨日期线范围使用短弧，并为实际覆盖区域保留可用空间', () => {
  expect(cameraBounds([179, 10, -179, 20])).toEqual([
    [179, 10],
    [181, 20],
  ]);
  expect(
    cameraPadding({ left: 0, top: 0, right: 1000, bottom: 600 }, [
      { left: 0, top: 0, right: 300, bottom: 600 },
      { left: 700, top: 0, right: 1000, bottom: 600 },
    ]),
  ).toEqual({ left: 324, right: 324, top: 24, bottom: 24 });
});

function fixture(sidePadding = 24) {
  const listeners = new Map<string, Set<(event: { chartCameraCommandId?: string }) => void>>();
  let retainedPadding = { top: 0, right: 0, bottom: 0, left: 0 };
  const map = {
    on: (name: string, cb: (event: { chartCameraCommandId?: string }) => void) => {
      const set = listeners.get(name) ?? new Set();
      set.add(cb);
      listeners.set(name, set);
    },
    off: (name: string, cb: (event: { chartCameraCommandId?: string }) => void) =>
      listeners.get(name)?.delete(cb),
    stop: vi.fn(),
    getCenter: () => ({ lng: 120, lat: 30 }),
    getZoom: () => 8,
    getBounds: () => ({
      getWest: () => 119,
      getSouth: () => 29,
      getEast: () => 121,
      getNorth: () => 31,
    }),
    setPadding: vi.fn((padding: typeof retainedPadding) => {
      retainedPadding = padding;
    }),
    easeTo: vi.fn((options: { padding?: typeof retainedPadding }) => {
      if (options.padding) retainedPadding = options.padding;
    }),
    fitBounds: vi.fn((_bounds: unknown, options: { padding: typeof retainedPadding }) => {
      // MapLibre 6.11 cameraForBounds subtracts both current transform padding
      // and the fitting padding, and returns no camera if the width is <= 0.
      if (
        600 -
          retainedPadding.left -
          retainedPadding.right -
          options.padding.left -
          options.padding.right <=
        0
      )
        throw new Error('No visible map width');
    }),
  };
  const camera = createMapCamera(
    map,
    () => ({ top: 24, right: sidePadding, bottom: 24, left: sidePadding }),
    () => false,
  );
  const fire = (name: string, chartCameraCommandId?: string) => {
    for (const cb of [...(listeners.get(name) ?? [])]) cb({ chartCameraCommandId });
  };
  return { map, camera, fire };
}

it('点位默认 zoom 10，回执来自完成后的真实镜头而非请求值', async () => {
  const { map, camera, fire } = fixture();
  const pending = camera.apply({ mode: 'point', center: [120, 30] }, 'command');
  expect(map.easeTo).toHaveBeenCalledWith(
    expect.objectContaining({ center: [120, 30], zoom: 10, duration: 800 }),
    { chartCameraCommandId: 'command' },
  );
  fire('moveend');
  expect(camera.current()).toBeNull();
  fire('moveend', 'command');
  expect(await pending).toEqual({
    commandId: 'command',
    center: [120, 30],
    zoom: 8,
    bbox: [119, 29, 121, 31],
  });
});

it('窄窗口两侧面板：point遗留padding在下一次bounds拟合前归零', async () => {
  const { map, camera, fire } = fixture(220);
  const point = camera.apply({ mode: 'point', center: [120, 30], zoom: 10 }, 'point');
  fire('moveend', 'point');
  await point;
  const bounds = camera.apply({ mode: 'bounds', bbox: [119, 29, 121, 31], maxZoom: 10 }, 'bounds');
  fire('moveend', 'bounds');
  await expect(bounds).resolves.toMatchObject({ commandId: 'bounds' });
  expect(map.setPadding).toHaveBeenCalledWith({ top: 0, right: 0, bottom: 0, left: 0 });
});

it('current相对缩放先捕获镜头前态，再归零旧padding', async () => {
  const { map, camera, fire } = fixture();
  map.setPadding.mockImplementation(() => {
    map.getCenter = () => ({ lng: 125, lat: 35 });
    map.getZoom = () => 3;
  });
  const pending = camera.apply({ mode: 'current', zoomDelta: 2 }, 'current');
  expect(map.easeTo).toHaveBeenCalledWith(
    expect.objectContaining({ center: [120, 30], zoom: 10 }),
    { chartCameraCommandId: 'current' },
  );
  fire('moveend', 'current');
  await pending;
});

it('人工打断和新命令取消旧过渡，旧moveend不能伪造成功', async () => {
  const { camera, fire } = fixture();
  const first = camera.apply({ mode: 'current', zoomDelta: 30 }, 'first');
  const rejected = expect(first).rejects.toMatchObject({
    message: '镜头操作已被更新',
    code: 'STATE_CONFLICT',
  });
  const second = camera.apply({ mode: 'current', zoom: 4 }, 'second');
  await rejected;
  const interrupted = expect(second).rejects.toMatchObject({
    message: '用户已接管镜头',
    code: 'STATE_CONFLICT',
  });
  camera.interrupt();
  fire('moveend');
  await interrupted;
  expect(camera.current()).toBeNull();
});

it('AbortSignal中断和释放均解除监听', async () => {
  const { camera } = fixture();
  const controller = new AbortController();
  const pending = camera.apply(
    { mode: 'bounds', bbox: [179, 10, -179, 20], maxZoom: 10 },
    'command',
    controller.signal,
  );
  const rejected = expect(pending).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  controller.abort();
  await rejected;
  camera.dispose();
});

it('已取消signal仍返回状态冲突，地图异常与超时保留独立错误码', async () => {
  const { camera, map } = fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    camera.apply({ mode: 'current', zoom: 4 }, 'aborted', controller.signal),
  ).rejects.toMatchObject({ code: 'STATE_CONFLICT' });
  map.easeTo.mockImplementationOnce(() => {
    throw new Error('WebGL lost');
  });
  await expect(camera.apply({ mode: 'current', zoom: 4 }, 'error')).rejects.toMatchObject({
    code: 'EXECUTION_FAILED',
  });
  vi.useFakeTimers();
  try {
    const pending = camera.apply({ mode: 'current', zoom: 4 }, 'timeout');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'POSTCONDITION_FAILED' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  } finally {
    vi.useRealTimers();
    camera.dispose();
  }
});
