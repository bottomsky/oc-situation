import { expect, it } from 'vitest';
import { placeFocusReply } from './focusLayout';
it('短图区返回独立于当前卡高度的真实最大高度，保留正文与操作空间', () => {
  const view = { left: 24, right: 354, top: 8, bottom: 156 };
  const compact = placeFocusReply(view, null, 360, 90);
  const expanded = placeFocusReply(view, null, 360, 320);
  expect(expanded.top).toBe(8);
  expect(expanded.maxHeight).toBe(140);
  expect(compact.maxHeight).toBe(expanded.maxHeight);
});
it('places a reply 24px from a target with no overlap', () => {
  const r = placeFocusReply(
    { left: 0, top: 0, right: 1200, bottom: 800 },
    { left: 400, top: 300, right: 450, bottom: 350 },
    360,
    240,
  );
  expect(r.left).toBe(474);
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

it('可用图区小于卡片宽度时收缩，高遮挡不强占侧栏', () => {
  const small = placeFocusReply({ left: 24, right: 226, top: 24, bottom: 500 }, null);
  expect(small.width).toBe(178);
  expect(small.left + small.width).toBeLessThanOrEqual(226);
  const blocked = placeFocusReply({ left: 24, right: 80, top: 24, bottom: 500 }, null);
  expect(blocked.width).toBe(32);
  expect(blocked.left + blocked.width).toBeLessThanOrEqual(80);
});
