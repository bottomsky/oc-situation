<script setup lang="ts">
const route = useRoute();
const { notice } = usePlatform();
startFusionEvents();
const ui = useAgentUi();
const { session } = usePlatform();
useUiComponent('app.page', { read: () => uiProjection(true, []) });
onMounted(() => {
  void ui.start();
});
watch(
  () => session.value?.user.id,
  () => {
    if (import.meta.client) void ui.start();
  },
);
watch(
  () => route.path,
  () => ui.changed(),
);
onBeforeUnmount(() => ui.stop());
</script>

<template>
  <UApp>
    <div v-if="route.path === '/login'" class="login-shell"><NuxtPage /></div>
    <div v-else class="console-shell">
      <ConsoleHeader />
      <div class="workspace">
        <div
          v-if="notice"
          role="status"
          class="notice"
          :class="{ 'chart-notice': route.path === '/' }"
        >
          {{ notice }}<button @click="notice = ''">关闭</button>
        </div>
        <main><NuxtPage /></main>
      </div>
    </div>
  </UApp>
</template>
