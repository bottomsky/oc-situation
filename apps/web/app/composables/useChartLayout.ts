import { computed, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';
import {
  chartLayoutDefaults,
  chartLayoutDefaultsForWidth,
  clampChartSize,
  createChartMeasurement,
  readChartLayout,
  resolveChartLayout,
  writeChartLayout,
  type ChartLayoutPanel,
} from '../utils/chartLayout';

export function useChartLayout(options: {
  user: Ref<string | undefined>;
  workspace: Ref<HTMLElement | null>;
  center: Ref<HTMLElement | null>;
  leftOpen: Ref<boolean>;
  rightOpen: Ref<boolean>;
}) {
  const preferred = ref({ ...chartLayoutDefaults });
  const viewport = ref({
    viewportWidth: 1920,
    workspaceWidth: 1904,
    centerHeight: 800,
    centerChrome: 110,
  });
  const layout = computed(() =>
    resolveChartLayout(preferred.value, {
      ...viewport.value,
      leftOpen: options.leftOpen.value,
      rightOpen: options.rightOpen.value,
    }),
  );
  const style = computed(() => ({
    '--chart-left-width': `${layout.value.sizes.left}px`,
    '--chart-right-width': `${layout.value.sizes.right}px`,
  }));
  const defaults = computed(() => chartLayoutDefaultsForWidth(viewport.value.viewportWidth));
  let observer: ResizeObserver | undefined;

  function readMeasurement() {
    const workspace = options.workspace.value;
    const center = options.center.value;
    if (!workspace || !center) return null;
    const computedStyle = getComputedStyle(workspace);
    const centerStyle = getComputedStyle(center);
    const heading = center.querySelector('.chart-map-heading');
    const status = center.querySelector('.chart-status-strip');
    return {
      viewportWidth: window.innerWidth,
      workspaceWidth:
        workspace.clientWidth -
        parseFloat(computedStyle.paddingLeft) -
        parseFloat(computedStyle.paddingRight),
      centerHeight:
        center.clientHeight -
        parseFloat(centerStyle.paddingTop) -
        parseFloat(centerStyle.paddingBottom),
      centerChrome:
        (heading?.getBoundingClientRect().height ?? 0) +
        (status?.getBoundingClientRect().height ?? 0) +
        7,
    };
  }

  const measurement = createChartMeasurement({
    read: readMeasurement,
    update: (next) => {
      viewport.value = next;
    },
    requestFrame: (callback) => window.requestAnimationFrame(callback),
    cancelFrame: (frame) => window.cancelAnimationFrame(frame),
  });

  function restore() {
    const fallback = chartLayoutDefaultsForWidth(window.innerWidth);
    try {
      preferred.value = options.user.value
        ? readChartLayout(window.localStorage, options.user.value, fallback)
        : fallback;
    } catch {
      preferred.value = fallback;
    }
  }

  function change(panel: ChartLayoutPanel, size: number) {
    const { min, max } = layout.value.bounds[panel];
    preferred.value = { ...preferred.value, [panel]: clampChartSize(size, min, max) };
  }

  function persist() {
    try {
      if (options.user.value)
        writeChartLayout(window.localStorage, options.user.value, preferred.value);
    } catch {
      // Accessing localStorage itself can fail in a restricted browser context.
    }
  }

  onMounted(() => {
    restore();
    measurement.measure();
    observer = new ResizeObserver(measurement.schedule);
    if (options.workspace.value) observer.observe(options.workspace.value);
    if (options.center.value) {
      observer.observe(options.center.value);
      for (const child of options.center.value.querySelectorAll(
        '.chart-map-heading, .chart-status-strip',
      ))
        observer.observe(child);
    }
    window.addEventListener('resize', measurement.schedule);
  });
  onBeforeUnmount(() => {
    observer?.disconnect();
    window.removeEventListener('resize', measurement.schedule);
    measurement.stop();
  });
  watch(options.user, () => {
    if (import.meta.client) restore();
  });
  return { layout, style, defaults, change, persist };
}
