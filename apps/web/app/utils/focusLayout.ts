export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type FocusSide = 'right' | 'left' | 'top' | 'bottom';
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
  height = Math.min(height, Math.max(60, vh - 24));
  const fallback = {
    left: view.left + (vw - width) / 2,
    top: view.top + (vh < 360 ? 0 : 16),
    maxHeight: Math.max(0, vh - (vh < 360 ? 0 : 16) - 8),
    width,
    compact,
    side: undefined as FocusSide | undefined,
  };
  if (!target || compact) return fallback;
  const cx = (target.left + target.right) / 2,
    cy = (target.top + target.bottom) / 2;
  const candidates: Record<FocusSide, { left: number; top: number }> = {
    right: { left: target.right + 24, top: cy - height / 2 },
    left: { left: target.left - 24 - width, top: cy - height / 2 },
    top: { left: cx - width / 2, top: target.top - 24 - height },
    bottom: { left: cx - width / 2, top: target.bottom + 24 },
  };
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
