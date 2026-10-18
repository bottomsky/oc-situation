export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type FocusSide = 'right' | 'left' | 'top' | 'bottom';
const framePadding = 16;
const replyGap = framePadding + 24;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** Connect exposed frame and card edges; never draw through the reply itself. */
export function focusReplyGuide(
  target: FocusRect | null,
  card: { left: number; top: number; width: number; side?: FocusSide },
  height: number,
) {
  if (!target) return '';
  const frame = {
    left: target.left - framePadding,
    right: target.right + framePadding,
    top: target.top - framePadding,
    bottom: target.bottom + framePadding,
  };
  const right = card.left + card.width,
    bottom = card.top + height;
  const side =
    card.left > frame.right
      ? 'right'
      : right < frame.left
        ? 'left'
        : bottom < frame.top
          ? 'top'
          : card.top > frame.bottom
            ? 'bottom'
            : undefined;
  if (!side) return '';
  if (side === 'right' || side === 'left') {
    const x = side === 'right' ? frame.right : frame.left,
      y = (frame.top + frame.bottom) / 2,
      cx = side === 'right' ? card.left : right,
      cy = clamp(y, card.top + 12, bottom - 12),
      elbow = (x + cx) / 2;
    return `M${x},${y}L${elbow},${y}L${elbow},${cy}L${cx},${cy}`;
  }
  const x = (frame.left + frame.right) / 2,
    y = side === 'top' ? frame.top : frame.bottom,
    cx = clamp(x, card.left + 12, right - 12),
    cy = side === 'top' ? bottom : card.top,
    elbow = (y + cy) / 2;
  return `M${x},${y}L${x},${elbow}L${cx},${elbow}L${cx},${cy}`;
}

export function placeFocusReply(
  view: FocusRect,
  target: FocusRect | null,
  width = 360,
  height = 320,
  previous?: FocusSide,
) {
  const vw = view.right - view.left,
    vh = view.bottom - view.top;
  const compact = vw < 640 || vh < 360;
  width = Math.min(width, Math.max(0, vw - 24));
  const fallback = {
    left: view.left + (vw - width) / 2,
    top: view.top + (vh < 360 ? 0 : 16),
    maxHeight: Math.max(0, vh - (vh < 360 ? 0 : 16) - 8),
    width,
    compact,
    side: undefined as FocusSide | undefined,
  };
  if (!target) return fallback;
  const cx = (target.left + target.right) / 2,
    cy = (target.top + target.bottom) / 2;
  const candidates: Record<FocusSide, { left: number; top: number }> = {
    right: { left: target.right + replyGap, top: cy - height / 2 },
    left: { left: target.left - replyGap - width, top: cy - height / 2 },
    top: { left: cx - width / 2, top: target.top - replyGap - height },
    bottom: { left: cx - width / 2, top: target.bottom + replyGap },
  };
  // Slide parallel to the target's edge before discarding an otherwise useful side.
  for (const side of ['right', 'left'] as const)
    candidates[side].top = clamp(candidates[side].top, view.top + 12, view.bottom - height - 12);
  for (const side of ['top', 'bottom'] as const)
    candidates[side].left = clamp(candidates[side].left, view.left + 12, view.right - width - 12);
  const valid = (side: FocusSide) => {
    const p = candidates[side];
    return (
      p.left >= view.left + 12 &&
      p.left + width <= view.right - 12 &&
      p.top >= view.top + 12 &&
      p.top + height <= view.bottom - 12
    );
  };
  const order: FocusSide[] = previous
    ? [
        previous,
        ...(['right', 'left', 'top', 'bottom'] as FocusSide[]).filter((s) => s !== previous),
      ]
    : ['right', 'left', 'top', 'bottom'];
  const side = order.find(valid);
  return side
    ? {
        ...candidates[side],
        width,
        compact,
        side,
        maxHeight: Math.max(0, view.bottom - candidates[side].top - 8),
      }
    : fallback;
}
