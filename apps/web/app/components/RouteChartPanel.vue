<script setup lang="ts">
import type { Route } from '@ais/contracts';
const props = defineProps<{ route: Route }>();
defineEmits<{ focus: [route: Route]; ask: [route: Route] }>();
</script>
<template>
  <section class="route-chart-panel">
    <small>计划航线 · 修订 {{ props.route.revision }}</small
    ><strong>{{ props.route.name }}</strong
    ><span
      >{{ (props.route.lengthMeters / 1852).toFixed(1) }} 海里 ·
      {{ props.route.waypoints.length }} 航点</span
    >
    <div>
      <button type="button" @click="$emit('focus', props.route)">关注此航线</button
      ><button type="button" @click="$emit('ask', props.route)">询问此航线</button>
    </div>
  </section>
</template>
<style scoped>
.route-chart-panel {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid #285262;
  border-radius: 8px;
  background: #0c2636;
  color: #c9e6ed;
}
.route-chart-panel small {
  color: #75a7b5;
}
.route-chart-panel div {
  display: flex;
  gap: 8px;
}
.route-chart-panel button {
  border: 1px solid #337483;
  border-radius: 5px;
  padding: 6px 10px;
  background: #123c4b;
  color: #a9f2e5;
  cursor: pointer;
}
</style>
