import { describe, expect, it } from 'vitest';
import { chartDetailPosition, replyDockClearance } from './app/utils/chartDetailPosition';

describe('海图详情浮层定位', () => {
  it('来源说明实际重叠时测量dock净空，重复测量不累加；无重叠保留原基准', () => {
    const dock = { left: 480, right: 1120, height: 68 };
    const note = { left: 920, right: 1375, top: 915, bottom: 980 };
    expect(replyDockClearance(990, dock, [note])).toBe(83);
    expect(replyDockClearance(990, dock, [note])).toBe(83);
    expect(replyDockClearance(990, dock, [{ ...note, left: 1200 }])).toBe(0);
    expect(Math.max(132, replyDockClearance(990, dock, [note]))).toBe(132);
    expect(replyDockClearance(990, dock, [note], 132)).toBe(0);
    expect(
      replyDockClearance(990, dock, [note, { left: 500, right: 700, top: 200, bottom: 250 }]),
    ).toBe(83);
    expect(
      replyDockClearance(990, dock, [note, { left: 500, right: 700, top: 825, bottom: 855 }]),
    ).toBe(173);
  });
  const workspace = { left: 8, right: 1912, top: 124, bottom: 992 };
  it('人工详情紧随左面板，协同详情位于右面板左侧', () => {
    expect(chartDetailPosition('left', workspace, { left: 8, right: 308 }, 1920)).toEqual({
      left: 320,
      top: 132,
      width: 420,
      height: 852,
    });
    expect(chartDetailPosition('right', workspace, { left: 1572, right: 1912 }, 1920)).toEqual({
      left: 1140,
      top: 132,
      width: 420,
      height: 852,
    });
  });
  it('面板调整后以实际边缘重新定位', () => {
    expect(chartDetailPosition('left', workspace, { left: 8, right: 448 }, 1920).left).toBe(460);
    expect(chartDetailPosition('right', workspace, { left: 1432, right: 1912 }, 1920).left).toBe(
      1000,
    );
  });
  it('历史会话使用紧凑宽度，窄窗口继续限制在视口内', () => {
    const desktop = chartDetailPosition(
      'right',
      workspace,
      { left: 1572, right: 1912 },
      1920,
      1080,
      288,
    );
    expect(desktop.width).toBe(288);
    expect(desktop.left).toBe(1272);
    const compact = chartDetailPosition(
      'right',
      { left: 0, right: 260, top: 80, bottom: 600 },
      null,
      260,
      640,
      288,
    );
    expect(compact.left).toBe(12);
    expect(compact.width).toBe(236);
  });
  it('窄屏将完整浮层夹紧到视口并保留关闭区', () => {
    const result = chartDetailPosition(
      'left',
      { left: 5, right: 385, top: 240, bottom: 776 },
      { left: 4, right: 304 },
      390,
    );
    expect(result.left).toBe(12);
    expect(result.width).toBe(366);
    expect(result.left + result.width).toBe(378);
    expect(result.top + result.height).toBe(768);
  });
  it('短窗口以实际视口高度为界，工作区最小高度不会遮住关闭区', () => {
    const result = chartDetailPosition(
      'right',
      { left: 5, right: 385, top: 300, bottom: 800 },
      null,
      390,
      320,
    );
    expect(result.top).toBe(224);
    expect(result.top + result.height).toBe(308);
  });
});
