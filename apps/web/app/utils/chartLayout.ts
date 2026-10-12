export interface ChartLayoutSizes {
  left: number;
  right: number;
  bottom: number;
}

export type ChartLayoutPanel = keyof ChartLayoutSizes;

export const chartLayoutDefaults: Readonly<ChartLayoutSizes> = {
  left: 300,
  right: 340,
  bottom: 205,
};

export function chartLayoutDefaultsForWidth(width: number): ChartLayoutSizes {
  return { ...chartLayoutDefaults, right: width >= 1024 && width < 1440 ? 320 : 340 };
}

interface LayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ChartLayoutMeasurement {
  viewportWidth: number;
  workspaceWidth: number;
  centerHeight: number;
  centerChrome: number;
}

interface ChartLayoutViewport extends ChartLayoutMeasurement {
  leftOpen: boolean;
  rightOpen: boolean;
}

export function createChartMeasurement(options: {
  read: () => ChartLayoutMeasurement | null;
  update: (measurement: ChartLayoutMeasurement) => void;
  requestFrame: (callback: () => void) => number;
  cancelFrame: (frame: number) => void;
}) {
  let pendingFrame: number | null = null;
  let previous: ChartLayoutMeasurement | null = null;
  let stopped = false;

  function measure() {
    if (stopped) return;
    const next = options.read();
    if (!next) return;
    if (
      previous &&
      next.viewportWidth === previous.viewportWidth &&
      next.workspaceWidth === previous.workspaceWidth &&
      next.centerHeight === previous.centerHeight &&
      next.centerChrome === previous.centerChrome
    )
      return;
    previous = next;
    options.update(next);
  }

  function schedule() {
    if (stopped || pendingFrame !== null) return;
    pendingFrame = options.requestFrame(() => {
      pendingFrame = null;
      measure();
    });
  }

  function stop() {
    stopped = true;
    if (pendingFrame !== null) options.cancelFrame(pendingFrame);
    pendingFrame = null;
  }

  return { measure, schedule, stop };
}

export function clampChartSize(value: number, min: number, max: number) {
  return Math.round(Math.max(min, Math.min(max, value)));
}

export function resolveChartLayout(preferred: ChartLayoutSizes, viewport: ChartLayoutViewport) {
  const desktop = viewport.viewportWidth >= 1440;
  const mobile = viewport.viewportWidth < 1024;
  const enabled = {
    left: desktop && viewport.leftOpen,
    right: !mobile && viewport.rightOpen,
  };
  // The two panel gaps consume 16px. A collapsed left rail consumes 48px.
  const sideBudget = viewport.workspaceWidth - 482 - (viewport.rightOpen ? 16 : 8);
  const leftMax = Math.max(240, Math.min(440, sideBudget - (enabled.right ? 280 : 0)));
  const left = enabled.left ? clampChartSize(preferred.left, 240, leftMax) : 300;
  const leftOccupied = mobile ? 0 : enabled.left ? left : 48;
  const rightMax = Math.max(280, Math.min(480, sideBudget - leftOccupied));
  const right = enabled.right ? clampChartSize(preferred.right, 280, rightMax) : 340;
  const leftDragMax = Math.max(240, Math.min(leftMax, sideBudget - (enabled.right ? right : 0)));
  const mapHeight = desktop ? 240 : viewport.viewportWidth > 600 ? 180 : 150;
  const bottomMax = Math.max(
    48,
    Math.min(480, viewport.centerHeight - viewport.centerChrome - mapHeight - 8),
  );
  const bottomMin = Math.min(100, bottomMax);
  return {
    sizes: { left, right, bottom: clampChartSize(preferred.bottom, bottomMin, bottomMax) },
    enabled,
    bounds: {
      left: { min: 240, max: leftDragMax },
      right: { min: 280, max: rightMax },
      bottom: { min: bottomMin, max: bottomMax },
    },
  };
}

const layoutKey = (user: string) => `ais:chart:${encodeURIComponent(user)}:layout`;

export function readChartLayout(
  storage: LayoutStorage,
  user: string,
  fallback: ChartLayoutSizes = chartLayoutDefaults,
): ChartLayoutSizes {
  const sizes = { ...fallback };
  try {
    const value: unknown = JSON.parse(storage.getItem(layoutKey(user)) ?? 'null');
    if (!value || typeof value !== 'object') return sizes;
    for (const panel of ['left', 'right', 'bottom'] as const) {
      const size = (value as Record<string, unknown>)[panel];
      if (typeof size === 'number' && Number.isFinite(size) && size > 0) {
        sizes[panel] = clampChartSize(
          size,
          panel === 'bottom' ? 48 : panel === 'left' ? 240 : 280,
          panel === 'left' ? 440 : 480,
        );
      }
    }
  } catch {
    // Restricted or damaged storage falls back to the current layout defaults.
  }
  return sizes;
}

export function writeChartLayout(storage: LayoutStorage, user: string, sizes: ChartLayoutSizes) {
  try {
    storage.setItem(layoutKey(user), JSON.stringify(sizes));
  } catch {
    // Resizing remains available when the browser blocks persistent storage.
  }
}
