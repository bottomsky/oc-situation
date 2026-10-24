import { expect, it } from 'vitest';
import { placeFocusReply } from './focusLayout';
import * as focusLayout from './focusLayout';

it('单对象卡片位于右上，距离逐对象光环24px并保留12px安全边界', () => {
  const result = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 800 },
    { left: 400, top: 400, right: 400, bottom: 400 },
    420,
    240,
  );
  expect(result.side).toBe('right');
  expect(result.left - (400 + 12)).toBe(24);
  expect(result.top).toBeLessThan(400);
  expect(result.top + 240).toBeLessThanOrEqual(400);
});

it('多对象卡片在目标组右侧并与组上缘对齐', () => {
  const result = placeFocusReply(
    { left: 0, top: 0, right: 1400, bottom: 800 },
    { left: 200, top: 180, right: 620, bottom: 560 },
    420,
    300,
    'right',
    2,
  );
  expect(result.side).toBe('right');
  expect(result.left).toBe(656);
  expect(result.top).toBe(180);
});

it('右侧容纳不下时转顶部居中，不在左右上下间跳动', () => {
  const view = { left: 24, top: 24, right: 1000, bottom: 700 };
  const result = placeFocusReply(view, { left: 600, right: 850, top: 300, bottom: 400 });
  expect(result.side).toBe('top');
  expect(result.left).toBe(302);
  expect(result.top).toBe(36);
  const next = placeFocusReply(
    view,
    { left: 100, right: 200, top: 400, bottom: 450 },
    420,
    250,
    'top',
  );
  expect(next.side).toBe('top');
});

it('无定位对象及分散组使用顶部布局，真实高度上限独立于正文当前高度', () => {
  const view = { left: 24, right: 354, top: 8, bottom: 180 };
  const compact = placeFocusReply(view, null, 420, 90);
  const expanded = placeFocusReply(view, null, 420, 360);
  expect(expanded.side).toBe('top');
  expect(expanded.top).toBe(20);
  expect(expanded.maxHeight).toBe(148);
  expect(compact.maxHeight).toBe(expanded.maxHeight);
  expect(expanded.compact).toBe(true);
  expect(expanded.width).toBe(306);
});

it('窗口顶部附近的对象仍可右侧显示，卡片上下边界受真实空间约束', () => {
  const result = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 800 },
    { left: 400, right: 400, top: 20, bottom: 20 },
    420,
    300,
  );
  expect(result.side).toBe('right');
  expect(result.top).toBe(12);
});

it('高遮挡不虚构可用空间，超高卡片回退顶部以便正文滚动', () => {
  const blocked = placeFocusReply({ left: 24, right: 80, top: 24, bottom: 500 }, null);
  expect(blocked.width).toBe(32);
  expect(blocked.left + blocked.width).toBeLessThanOrEqual(80);
  const tall = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 200 },
    { left: 400, top: 100, right: 400, bottom: 100 },
    420,
    500,
  );
  expect(tall.side).toBe('top');
  expect(tall.maxHeight).toBe(102);
});

it('窄图区单对象被顶部卡片覆盖时需要一次构图，进入预留对象区后停止调整', () => {
  expect(typeof focusLayout.focusObjectViewport).toBe('function');
  expect(typeof focusLayout.needsFocusComposition).toBe('function');
  const view = { left: 0, top: 0, right: 600, bottom: 800 };
  const target = { left: 300, top: 30, right: 300, bottom: 30 };
  const card = placeFocusReply(view, target, 420, 160, 'top');
  expect(card.side).toBe('top');
  expect(card.left).toBe(90);
  expect(card.top).toBe(12);
  expect(typeof focusLayout.focusReplyOccludes).toBe('function');
  expect(focusLayout.focusReplyOccludes(target, card, 160)).toBe(true);
  const objectView = focusLayout.focusObjectViewport(view, 'top', 420, 160);
  expect(focusLayout.needsFocusComposition(target, objectView, 'top', 'top', 1)).toBe(true);
  const fitted = { left: 300, right: 300, top: 500, bottom: 500 };
  expect(focusLayout.needsFocusComposition(fitted, objectView, 'top', 'top', 1)).toBe(false);
  expect(focusLayout.focusReplyOccludes(fitted, card, 160)).toBe(false);
});

it('420px卡片有274px净空时默认显示正文，真正窄卡及低净空才进入紧凑模式', () => {
  const readable = placeFocusReply({ left: 0, top: 0, right: 1002, bottom: 274 }, null, 420, 260);
  expect(readable.width).toBe(420);
  expect(readable.maxHeight).toBe(250);
  expect(readable.compact).toBe(false);
  expect(
    placeFocusReply({ left: 0, top: 0, right: 350, bottom: 500 }, null, 420, 260).compact,
  ).toBe(true);
  expect(
    placeFocusReply({ left: 0, top: 0, right: 1002, bottom: 160 }, null, 420, 160).compact,
  ).toBe(true);
});

it('宽卡实际可读高206px时保持正文默认展开', () => {
  const layout = placeFocusReply({ left: 0, top: 0, right: 1002, bottom: 230 }, null, 420, 206);
  expect(layout.maxHeight).toBe(206);
  expect(layout.compact).toBe(false);
});

it('顶部一次构图与卡片共享239px/227px净空间预算，物理不足保留控制并明确标记', () => {
  expect(typeof focusLayout.focusTopSpace).toBe('function');
  expect(focusLayout.focusTopSpace(239)).toEqual({
    maxHeight: 111,
    objectMinHeight: 80,
    shortHeader: true,
    feasible: true,
  });
  expect(focusLayout.focusTopSpace(227)).toEqual({
    maxHeight: 102,
    objectMinHeight: 77,
    shortHeader: true,
    feasible: true,
  });
  expect(focusLayout.focusTopSpace(132)).toEqual({
    maxHeight: 102,
    objectMinHeight: 0,
    shortHeader: true,
    feasible: false,
  });
  const layout = placeFocusReply(
    { left: 24, top: 24, right: 564, bottom: 263 },
    { left: 294, right: 294, top: 223, bottom: 223 },
    420,
    213,
    'top',
  );
  expect(layout.maxHeight).toBe(111);
  expect(223 - 12 - (layout.top + layout.maxHeight)).toBeGreaterThanOrEqual(24);
  expect(focusLayout.focusTopSpace(282, 111)).toEqual({
    maxHeight: 111,
    objectMinHeight: 123,
    shortHeader: true,
    feasible: true,
  });
  const relaxed = placeFocusReply(
    { left: 24, top: 24, right: 564, bottom: 306 },
    { left: 294, right: 294, top: 223, bottom: 223 },
    420,
    213,
    'top',
    1,
    true,
    111,
  );
  expect(relaxed.maxHeight).toBe(111);
  expect(223 - 12 - (relaxed.top + relaxed.maxHeight)).toBeGreaterThanOrEqual(24);
});
