export interface ChartFooterMap<Control> {
  addControl(control: Control, position: 'bottom-right'): unknown;
  removeControl(control: Control): unknown;
}

/** Rebuild only public controls when the actual map's height changes mode. */
export function createChartFooterControls<Control>(
  map: ChartFooterMap<Control>,
  factory: { attribution(compact: boolean): Control; scale(maxWidth: number): Control },
  changed: (compactFooter: boolean) => void,
) {
  let compactFooter: boolean | undefined;
  let controls: Control[] = [];
  let disposed = false;
  const remove = () => {
    for (const control of controls) map.removeControl(control);
    controls = [];
  };
  return {
    update(height: number) {
      if (disposed) return;
      const next = height < 360;
      if (next === compactFooter) return;
      compactFooter = next;
      remove();
      controls = [factory.scale(next ? 80 : 140), factory.attribution(!next)];
      for (const control of controls) map.addControl(control, 'bottom-right');
      changed(next);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      remove();
    },
  };
}
