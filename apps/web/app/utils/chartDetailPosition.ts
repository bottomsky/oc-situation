interface ChartDetailBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Solve from the CSS baseline; new collisions never add offsets from a previous measurement. */
export function replyDockClearance(
  stageBottom: number,
  dock: Pick<ChartDetailBounds, 'left' | 'right'> & { height: number },
  notes: ChartDetailBounds[],
  baseline = 40,
) {
  let bottom = baseline;
  for (let pass = 0; pass <= notes.length; pass++) {
    const previous = bottom;
    for (const note of notes) {
      const dockBottom = stageBottom - bottom;
      if (
        note.left < dock.right &&
        note.right > dock.left &&
        note.top < dockBottom &&
        note.bottom > dockBottom - dock.height
      )
        bottom = Math.max(bottom, stageBottom - note.top + 8);
    }
    if (bottom === previous) break;
  }
  return bottom > baseline ? bottom : 0;
}

export function chartDetailPosition(
  side: 'left' | 'right',
  workspace: ChartDetailBounds,
  anchor: Pick<ChartDetailBounds, 'left' | 'right'> | null,
  viewportWidth: number,
  viewportHeight = Number.POSITIVE_INFINITY,
  preferredWidth = 420,
) {
  const minLeft = Math.max(12, workspace.left + 4);
  const maxRight = Math.min(viewportWidth - 12, workspace.right - 4);
  const width = Math.max(0, Math.min(preferredWidth, maxRight - minLeft));
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
