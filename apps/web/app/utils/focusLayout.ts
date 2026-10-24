export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}
export type FocusSide = 'right' | 'top';
export const FOCUS_CARD_WIDTH = 420;
export const FOCUS_CARD_HEIGHT = 360;
export const FOCUS_HIGHLIGHT_RADIUS = 12;
export const FOCUS_REPLY_GAP = 24;
export const FOCUS_SAFE_GAP = 12;
export const FOCUS_RESERVATION_GAP = FOCUS_HIGHLIGHT_RADIUS + FOCUS_REPLY_GAP + FOCUS_SAFE_GAP;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

/** One physical budget for the top card, its separation, and the visible object area. */
export function focusTopSpace(height: number, adoptedLimit = Infinity) {
  const maxHeight = Math.max(
    0,
    Math.min(
      adoptedLimit,
      height - 2 * FOCUS_SAFE_GAP,
      Math.max(102, Math.min(FOCUS_CARD_HEIGHT, height - FOCUS_RESERVATION_GAP - 80)),
    ),
  );
  const objectMinHeight = Math.max(0, height - maxHeight - FOCUS_RESERVATION_GAP);
  return {
    maxHeight,
    objectMinHeight,
    shortHeader: height < 360 || maxHeight < 160,
    feasible: maxHeight >= 102 && objectMinHeight >= 24,
  };
}

/** Object viewport after reserving one card, in the same coordinates as the highlights. */
export function focusObjectViewport(
  view: FocusRect,
  placement: FocusSide,
  width: number,
  height: number,
  objectMinHeight = 80,
): FocusRect {
  return {
    ...view,
    right: view.right - (placement === 'right' ? width + FOCUS_RESERVATION_GAP : 0),
    top:
      view.top +
      (placement === 'top'
        ? Math.min(
            height + FOCUS_RESERVATION_GAP,
            Math.max(0, view.bottom - view.top - objectMinHeight),
          )
        : 0),
  };
}

/** A top card needs object space for one object just as it does for a whole group. */
export function needsFocusComposition(
  target: FocusRect | null,
  objectView: FocusRect,
  placement: FocusSide,
  cardSide: FocusSide,
  targetCount: number,
) {
  if (!target) return false;
  const inside =
    target.left >= objectView.left &&
    target.right <= objectView.right &&
    target.top >= objectView.top &&
    target.bottom <= objectView.bottom;
  const centered =
    Math.abs((target.left + target.right - objectView.left - objectView.right) / 2) <=
      Math.max(24, (objectView.right - objectView.left) * 0.12) &&
    Math.abs((target.top + target.bottom - objectView.top - objectView.bottom) / 2) <=
      Math.max(24, (objectView.bottom - objectView.top) * 0.12);
  return (
    !inside || (placement === 'right' && cardSide !== 'right') || (targetCount > 1 && !centered)
  );
}

export function focusReplyOccludes(
  target: FocusRect | null,
  card: { left: number; top: number; width: number },
  height: number,
) {
  return (
    !!target &&
    target.left - FOCUS_HIGHLIGHT_RADIUS < card.left + card.width &&
    target.right + FOCUS_HIGHLIGHT_RADIUS > card.left &&
    target.top - FOCUS_HIGHLIGHT_RADIUS < card.top + height &&
    target.bottom + FOCUS_HIGHLIGHT_RADIUS > card.top
  );
}

/** Keep the card beside its objects or in one stable top slot; never join them with a guide. */
export function placeFocusReply(
  view: FocusRect,
  target: FocusRect | null,
  width = FOCUS_CARD_WIDTH,
  height = FOCUS_CARD_HEIGHT,
  previous?: FocusSide,
  targetCount = 1,
  reserveObjects = !!target,
  topCardLimit?: number,
) {
  const vw = Math.max(0, view.right - view.left),
    vh = Math.max(0, view.bottom - view.top);
  width = Math.min(width, Math.max(0, vw - 2 * FOCUS_SAFE_GAP));
  const top = view.top + FOCUS_SAFE_GAP;
  const budget = reserveObjects ? focusTopSpace(vh, topCardLimit) : null;
  const maxHeight = budget?.maxHeight ?? Math.max(0, view.bottom - top - FOCUS_SAFE_GAP);
  const fallback = {
    left: view.left + (vw - width) / 2,
    top,
    maxHeight,
    width,
    compact: width < 360 || maxHeight < 160,
    shortHeader: budget?.shortHeader ?? false,
    objectMinHeight: budget?.objectMinHeight ?? 80,
    compositionFits: budget?.feasible ?? true,
    side: 'top' as FocusSide,
  };
  if (!target || previous === 'top') return fallback;
  const left = target.right + FOCUS_HIGHLIGHT_RADIUS + FOCUS_REPLY_GAP;
  const preferredTop = targetCount > 1 ? target.top : target.top - height - FOCUS_REPLY_GAP;
  const cardTop = clamp(preferredTop, top, view.bottom - height - FOCUS_SAFE_GAP);
  const fits =
    left >= view.left + FOCUS_SAFE_GAP &&
    left + width <= view.right - FOCUS_SAFE_GAP &&
    cardTop + height <= view.bottom - FOCUS_SAFE_GAP &&
    target.right >= view.left &&
    target.left <= view.right &&
    target.bottom >= view.top &&
    target.top <= view.bottom;
  return fits
    ? {
        left,
        top: cardTop,
        width,
        compact: width < 360 || view.bottom - cardTop - FOCUS_SAFE_GAP < 160,
        side: 'right' as FocusSide,
        maxHeight: Math.max(0, view.bottom - cardTop - FOCUS_SAFE_GAP),
        shortHeader: false,
        objectMinHeight: 80,
        compositionFits: true,
      }
    : fallback;
}
