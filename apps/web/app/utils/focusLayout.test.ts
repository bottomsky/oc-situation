import { expect, it } from 'vitest';
import { focusReplyGuide, placeFocusReply } from './focusLayout';
it('短图区返回独立于当前卡高度的真实最大高度，保留正文与操作空间', () => {
  const view = { left: 24, right: 354, top: 8, bottom: 156 };
  const compact = placeFocusReply(view, null, 360, 90);
  const expanded = placeFocusReply(view, null, 360, 320);
  expect(expanded.top).toBe(8);
  expect(expanded.maxHeight).toBe(140);
  expect(compact.maxHeight).toBe(expanded.maxHeight);
});
it('places a reply 24px from the attention frame with no overlap', () => {
  const r = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 800 },
    { left: 400, top: 300, right: 450, bottom: 350 },
    360,
    240,
  );
  expect(r.left - (450 + 16)).toBe(24);
  expect(r.left).toBeGreaterThan(450);
  expect(r.compact).toBe(false);
});
it('uses a compact summary in a narrow viewport', () =>
  expect(
    placeFocusReply({ left: 0, top: 0, right: 600, bottom: 800 }, null, 360, 240).compact,
  ).toBe(true));
it('holds the previous side while it remains valid', () => {
  const r = placeFocusReply(
    { left: 0, top: 0, right: 1600, bottom: 800 },
    { left: 800, top: 300, right: 850, bottom: 350 },
    360,
    240,
    'left',
  );
  expect(r.side).toBe('left');
});

it('对象靠近上边缘时沿边缘平移回复卡，仍贴近对象并保留明确侧向', () => {
  const result = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 800 },
    { left: 400, right: 450, top: 20, bottom: 30 },
    360,
    240,
  );
  expect(result.side).toBe('right');
  expect(result.left - (450 + 16)).toBe(24);
  expect(result.left).toBeGreaterThan(450);
  expect(result.top).toBe(12);
});

it('有引导线时连接四角框和卡片的真实边界，紧凑布局仍关联可见对象', () => {
  const target = { left: 200, right: 200, top: 400, bottom: 400 };
  const layout = placeFocusReply({ left: 0, top: 0, right: 600, bottom: 800 }, target, 360, 180);
  const guide = focusReplyGuide(target, layout, 180);
  expect(guide).not.toBe('');
  expect(guide).toContain('M200,384');
  expect(guide).toContain(`L200,${layout.top + 180}`);
  expect(focusReplyGuide(null, layout, 180)).toBe('');
});

it('卡片遮住目标时不伪造一条穿过正文的连接线', () => {
  expect(
    focusReplyGuide(
      { left: 200, right: 200, top: 80, bottom: 80 },
      { left: 100, top: 16, width: 360, side: undefined },
      180,
    ),
  ).toBe('');
});

it('紧凑卡也优先避开可见对象，在对象下方有空间时保持关联', () => {
  const target = { left: 200, top: 80, right: 200, bottom: 80 };
  const layout = placeFocusReply({ left: 0, top: 0, right: 600, bottom: 800 }, target, 360, 180);
  expect(layout.compact).toBe(true);
  expect(layout.side).toBe('bottom');
  expect(layout.top - (target.bottom + 16)).toBe(24);
  expect(layout.top + 180).toBeLessThanOrEqual(788);
  expect(focusReplyGuide(target, layout, 180)).not.toBe('');
});

it('可用图区较短时按真实DOM高度评估，不截短高度伪报侧向可容纳', () => {
  const layout = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 200 },
    { left: 400, top: 100, right: 400, bottom: 100 },
    360,
    500,
  );
  expect(layout.side).toBeUndefined();
});

it('紧凑摘要使用实测小尺寸，可在输入框上方较短图区绕开居中的对象', () => {
  const view = { left: 24, top: 24, right: 576, bottom: 306 };
  const target = { left: 300, top: 166, right: 300, bottom: 166 };
  const fullHeader = placeFocusReply(view, target, 360, 142);
  expect(fullHeader.side).toBeUndefined();
  const compactHeader = placeFocusReply(view, target, 360, 88);
  expect(compactHeader.side).toBe('top');
  expect(target.top - 16 - (compactHeader.top + 88)).toBe(24);
  expect(focusReplyGuide(target, compactHeader, 88)).not.toBe('');
});

it('可用图区小于卡片宽度时收缩，高遮挡不强占侧栏', () => {
  const small = placeFocusReply({ left: 24, right: 226, top: 24, bottom: 500 }, null);
  expect(small.width).toBe(178);
  expect(small.left + small.width).toBeLessThanOrEqual(226);
  const blocked = placeFocusReply({ left: 24, right: 80, top: 24, bottom: 500 }, null);
  expect(blocked.width).toBe(32);
  expect(blocked.left + blocked.width).toBeLessThanOrEqual(80);
});
