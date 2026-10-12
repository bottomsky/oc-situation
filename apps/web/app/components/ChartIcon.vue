<script setup lang="ts">
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 24 });
const paths: Record<string, string[]> = {
  menu: ['M4 6h16M4 12h16M4 18h16'],
  x: ['m6 6 12 12M6 18 18 6'],
  search: ['M10 17a7 7 0 1 0 0-14 7 7 0 0 0 0 14Z', 'm15 15 6 6'],
  layers: ['m12 3 9 5-9 5-9-5 9-5Z', 'm3 12 9 5 9-5M3 16l9 5 9-5'],
  history: ['M3 11a9 9 0 1 1 3 8', 'M3 4v7h7M12 7v5l3 2'],
  ship: [
    'M7 10V5h10v5M10 5V2h4v3',
    'm12 9 9 4-3 6M12 9l-9 4 3 6M12 9v10',
    'M3 21c2 0 2-2 4-2s3 2 5 2 3-2 5-2 2 2 4 2',
  ],
  anchor: [
    'M12 7v14M8 11h8',
    'M12 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M3 14v3l3-1M21 14v3l-3-1M3 17a9 9 0 0 0 18 0',
  ],
  home: ['m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8'],
  maximize: ['M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5'],
  chevronleft: ['m15 5-7 7 7 7'],
  chevronright: ['m9 5 7 7-7 7'],
  chevrondown: ['m5 9 7 7 7-7'],
  chevronup: ['m5 15 7-7 7 7'],
  messagecircle: ['M21 11a9 9 0 0 1-9 9c-2 0-3-.3-4-1L3 21l1-5a9 9 0 1 1 17-5Z'],
  radio: [
    'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
    'M7 7a7 7 0 0 0 0 10M17 7a7 7 0 0 1 0 10M4 4a11 11 0 0 0 0 16M20 4a11 11 0 0 1 0 16',
  ],
  radar: [
    'M12 21a9 9 0 1 0-9-9 9 9 0 0 0 9 9Z',
    'M12 16a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z',
    'M12 12 19 5',
  ],
  clipboardlist: ['M9 3H5v18h14V3h-4M9 2h6v4H9V2Z', 'M9 11h7M9 16h7M7 11h.01M7 16h.01'],
  play: ['m7 3 14 9-14 9V3Z'],
  pause: ['M7 4v16M17 4v16'],
  refreshcw: ['M21 3v6h-6M3 21v-6h6', 'M3 11a9 9 0 0 1 15-7l3 5M21 13a9 9 0 0 1-15 7l-3-5'],
  shieldcheck: ['m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z', 'm8 12 3 3 5-6'],
  chartnoaxescombined: ['M3 3v18h18M6 15l5-5 4 3 6-8M17 5h4v4'],
  settings: [
    'm9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3H9Z',
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  ],
  arrowright: ['M4 12h16m-6-6 6 6-6 6'],
  send: ['m22 2-7 20-4-9-9-4 20-7Z', 'M22 2 11 13'],
  externallink: ['M14 3h7v7M10 14 21 3M10 3H3v18h18v-7'],
  bot: ['M12 3v3M9 3h3M5 6h14v14H5V6Z', 'M2 10v6M22 10v6M9 11h.01M15 11h.01M9 16h6'],
  compass: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'm16 8-3 5-5 3 3-5 5-3Z'],
  filter: ['M3 4h18l-7 8v7l-4 2v-9L3 4Z'],
  plus: ['M12 4v16M4 12h16'],
  minus: ['M4 12h16'],
  check: ['m4 12 5 5L20 6'],
  circlealert: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 7v6M12 17h.01'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z', 'M12 6v6l4 2'],
};
const iconPaths = computed(
  () =>
    paths[
      props.name
        .replace(/^i-lucide-/, '')
        .replace(/-/g, '')
        .toLowerCase()
    ] ?? paths.circlealert,
);
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.65"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <path v-for="(path, index) in iconPaths" :key="index" :d="path" />
  </svg>
</template>
