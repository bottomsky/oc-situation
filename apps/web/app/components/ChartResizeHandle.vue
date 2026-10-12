<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
const props = defineProps<{
  panel: 'left' | 'right' | 'bottom';
  label: string;
  controls: string;
  value: number;
  min: number;
  max: number;
  defaultValue: number;
}>();
const emit = defineEmits<{ change: [value: number]; commit: [] }>();
const dragging = ref(false);
let activePointer: number | null = null;
let element: HTMLElement | null = null;
let origin = 0;
let startValue = 0;
let originalUserSelect = '';
let originalCursor = '';
const coordinate = (event: PointerEvent) =>
  props.panel === 'bottom' ? event.clientY : event.clientX;
const direction = () => (props.panel === 'left' ? 1 : -1);

function finish() {
  if (activePointer === null) return;
  const pointer = activePointer;
  activePointer = null;
  dragging.value = false;
  document.documentElement.style.userSelect = originalUserSelect;
  document.documentElement.style.cursor = originalCursor;
  document.documentElement.classList.remove('chart-layout-resizing');
  window.removeEventListener('blur', finish);
  if (element?.hasPointerCapture(pointer)) element.releasePointerCapture(pointer);
  element = null;
  emit('commit');
}

function start(event: PointerEvent) {
  if (activePointer !== null || !event.isPrimary || event.button !== 0) return;
  event.preventDefault();
  element = event.currentTarget as HTMLElement;
  element.focus();
  element.setPointerCapture(event.pointerId);
  activePointer = event.pointerId;
  origin = coordinate(event);
  startValue = props.value;
  dragging.value = true;
  originalUserSelect = document.documentElement.style.userSelect;
  originalCursor = document.documentElement.style.cursor;
  document.documentElement.style.userSelect = 'none';
  document.documentElement.style.cursor = props.panel === 'bottom' ? 'row-resize' : 'col-resize';
  document.documentElement.classList.add('chart-layout-resizing');
  window.addEventListener('blur', finish);
}

function move(event: PointerEvent) {
  if (event.pointerId !== activePointer) return;
  event.preventDefault();
  emit('change', startValue + (coordinate(event) - origin) * direction());
}

function end(event: PointerEvent) {
  if (event.pointerId === activePointer) finish();
}

function reset() {
  emit('change', props.defaultValue);
  emit('commit');
}

function keydown(event: KeyboardEvent) {
  if (event.key === 'Home') {
    event.preventDefault();
    reset();
    return;
  }
  const positive = props.panel === 'bottom' ? 'ArrowDown' : 'ArrowRight';
  const negative = props.panel === 'bottom' ? 'ArrowUp' : 'ArrowLeft';
  if (event.key !== positive && event.key !== negative) return;
  event.preventDefault();
  emit(
    'change',
    props.value + (event.key === positive ? 1 : -1) * direction() * (event.shiftKey ? 40 : 10),
  );
  emit('commit');
}

onBeforeUnmount(finish);
</script>

<template>
  <div
    class="chart-resize-handle"
    :class="[`chart-resize-${panel}`, { dragging }]"
    role="separator"
    tabindex="0"
    :aria-label="label"
    :aria-controls="controls"
    :aria-orientation="panel === 'bottom' ? 'horizontal' : 'vertical'"
    :aria-valuenow="Math.round(value)"
    :aria-valuemin="min"
    :aria-valuemax="max"
    :aria-valuetext="`${Math.round(value)} 像素`"
    :title="`${label}：拖动或方向键调整，Home / 双击恢复默认`"
    :data-testid="`chart-resize-${panel}`"
    @pointerdown="start"
    @pointermove="move"
    @pointerup="end"
    @pointercancel="end"
    @lostpointercapture="end"
    @keydown.stop="keydown"
    @dblclick="reset"
  >
    <span aria-hidden="true" />
  </div>
</template>
