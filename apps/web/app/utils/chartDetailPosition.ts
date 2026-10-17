interface ChartDetailBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function chartDetailPosition(
  side: 'left' | 'right',
  workspace: ChartDetailBounds,
  anchor: Pick<ChartDetailBounds, 'left' | 'right'> | null,
  viewportWidth: number,
  viewportHeight = Number.POSITIVE_INFINITY,
) {
  const minLeft = Math.max(12, workspace.left + 4);
  const maxRight = Math.min(viewportWidth - 12, workspace.right - 4);
  const width = Math.max(0, Math.min(420, maxRight - minLeft));
  const requestedLeft =
    side === 'left'
      ? (anchor?.right ?? workspace.left) + 12
      : (anchor?.left ?? workspace.right) - width - 12;
  const top = Math.min(Math.max(8, workspace.top + 8), Math.max(8, viewportHeight - 96));
  return {
    left: Math.max(minLeft, Math.min(requestedLeft, maxRight - width)),
    top,
    width,
    height: Math.max(0, Math.min(workspace.bottom - 8, viewportHeight - 12) - top),
  };
}
