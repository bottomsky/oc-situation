/** True on the painted chart surface, including disclosure and fullscreen semantics. */
export function isChartElementVisible(
  element: HTMLElement,
  fullscreen: Element | null = typeof document === 'undefined' ? null : document.fullscreenElement,
): boolean {
  if (fullscreen && !fullscreen.contains(element)) return false;
  if (element.closest('[inert]')) return false;
  if (typeof element.checkVisibility === 'function') {
    try {
      if (!element.checkVisibility({ checkVisibilityCSS: true })) return false;
    } catch {
      // Older engines can expose the method without supporting its options.
    }
  }
  if (!element.getClientRects().length) return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')
    return false;
  for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (
      ancestor.tagName !== 'DETAILS' ||
      (ancestor as HTMLDetailsElement).open ||
      ancestor === element
    )
      continue;
    const summary = Array.from(ancestor.children).find((child) => child.tagName === 'SUMMARY');
    if (!summary?.contains(element)) return false;
  }
  return true;
}
