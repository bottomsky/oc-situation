import { describe, expect, it, vi } from 'vitest';
import {
  chartLayoutDefaults,
  resolveChartLayout,
  readChartLayout,
  writeChartLayout,
  createChartMeasurement,
} from './app/utils/chartLayout';

describe('海图尺寸测量调度', () => {
  function setup() {
    const callbacks = new Map<number, () => void>();
    let nextFrame = 0;
    const size = {
      viewportWidth: 1920,
      workspaceWidth: 1904,
      centerHeight: 800,
      centerChrome: 110,
    };
    const read = vi.fn(() => ({ ...size }));
    const update = vi.fn();
    const requestFrame = vi.fn((callback: () => void) => {
      const frame = nextFrame++;
      callbacks.set(frame, callback);
      return frame;
    });
    const cancelFrame = vi.fn();
    const measurement = createChartMeasurement({ read, update, requestFrame, cancelFrame });
    return { measurement, callbacks, size, read, update, requestFrame, cancelFrame };
  }

  it('同一帧的多个resize通知合并，并在下一帧读取最新尺寸', () => {
    const { measurement, callbacks, size, read, update, requestFrame } = setup();
    measurement.schedule();
    measurement.schedule();
    measurement.schedule();
    size.centerHeight = 600;
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    callbacks.get(0)!();
    expect(read).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ ...size });
    measurement.schedule();
    expect(requestFrame).toHaveBeenCalledTimes(2);
  });

  it('初次同步测量可用，相同尺寸不再次触发响应式写入', () => {
    const { measurement, callbacks, size, update } = setup();
    measurement.measure();
    measurement.measure();
    measurement.schedule();
    callbacks.get(0)!();
    expect(update).toHaveBeenCalledTimes(1);
    size.centerHeight -= 16;
    measurement.measure();
    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenLastCalledWith({ ...size });
  });

  it('卸载取消待处理帧，后续或已进入队列的回调均停止测量', () => {
    const { measurement, callbacks, read, update, requestFrame, cancelFrame } = setup();
    measurement.schedule();
    measurement.stop();
    expect(cancelFrame).toHaveBeenCalledWith(0);
    callbacks.get(0)!();
    measurement.schedule();
    measurement.measure();
    expect(requestFrame).toHaveBeenCalledTimes(1);
    expect(read).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});

describe('海图工作台尺寸', () => {
  const desktop = {
    viewportWidth: 1920,
    workspaceWidth: 1904,
    centerHeight: 900,
    centerChrome: 110,
    leftOpen: true,
    rightOpen: true,
  };

  it('默认尺寸延续现有布局，并给海图保留宽高', () => {
    const layout = resolveChartLayout(chartLayoutDefaults, desktop);
    expect(layout.sizes).toEqual({ left: 300, right: 340, bottom: 205 });
    expect(layout.enabled).toEqual({ left: true, right: true });
    const constrained = resolveChartLayout(
      { left: 440, right: 480, bottom: 480 },
      { ...desktop, viewportWidth: 1440, workspaceWidth: 1424, centerHeight: 580 },
    );
    expect(1424 - constrained.sizes.left - constrained.sizes.right - 16).toBeGreaterThanOrEqual(
      480,
    );
    expect(580 - 110 - constrained.sizes.bottom - 8).toBeGreaterThanOrEqual(240);
  });

  it('中屏左浮层保持300px，小屏抽屉保持原尺寸且禁用左右拖动', () => {
    const preferred = { left: 410, right: 460, bottom: 330 };
    const medium = resolveChartLayout(preferred, {
      ...desktop,
      viewportWidth: 1280,
      workspaceWidth: 1264,
    });
    expect(medium.enabled).toEqual({ left: false, right: true });
    expect(medium.sizes.left).toBe(300);
    expect(
      resolveChartLayout(
        { ...preferred, right: 340 },
        {
          ...desktop,
          viewportWidth: 1280,
          workspaceWidth: 1264,
        },
      ).sizes.right,
    ).toBe(340);
    const mobile = resolveChartLayout(preferred, { ...desktop, viewportWidth: 768 });
    expect(mobile.enabled).toEqual({ left: false, right: false });
    expect(mobile.sizes.left).toBe(300);
    expect(mobile.sizes.right).toBe(340);
    expect(mobile.sizes.bottom).toBe(330);
  });

  it('窗口缩小和折叠只调整显示尺寸，放大后恢复偏好', () => {
    const preferred = { left: 440, right: 480, bottom: 480 };
    const small = resolveChartLayout(preferred, {
      ...desktop,
      viewportWidth: 1024,
      workspaceWidth: 1008,
      centerHeight: 400,
      centerChrome: 130,
    });
    expect(1008 - small.sizes.right - 8).toBeGreaterThanOrEqual(480);
    expect(small.sizes.bottom).toBe(82);
    expect(resolveChartLayout(preferred, desktop).sizes).toEqual(preferred);
    const closed = resolveChartLayout(preferred, { ...desktop, leftOpen: false, rightOpen: false });
    expect(closed.enabled).toEqual({ left: false, right: false });
    expect(preferred).toEqual({ left: 440, right: 480, bottom: 480 });
  });

  it('按账号存储，异常值分别回退且存储不可用时仍可操作', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    writeChartLayout(storage, 'a', { left: 350, right: 400, bottom: 290 });
    expect(readChartLayout(storage, 'a')).toEqual({ left: 350, right: 400, bottom: 290 });
    expect(readChartLayout(storage, 'b')).toEqual(chartLayoutDefaults);
    values.set('ais:chart:a:layout', '{"left":null,"right":-2,"bottom":270}');
    expect(readChartLayout(storage, 'a')).toEqual({ left: 300, right: 340, bottom: 270 });
    values.set('ais:chart:a:layout', '{broken');
    expect(readChartLayout(storage, 'a')).toEqual(chartLayoutDefaults);
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readChartLayout(blocked, 'a')).toEqual(chartLayoutDefaults);
    expect(() => writeChartLayout(blocked, 'a', chartLayoutDefaults)).not.toThrow();
  });
});
