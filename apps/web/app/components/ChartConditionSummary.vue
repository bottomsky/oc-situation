<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    settingsLabel: string;
    items: { key: string; label: string; removable?: boolean }[];
    icon?: string;
    removable?: boolean;
  }>(),
  { icon: 'filter', removable: true },
);
const emit = defineEmits<{ settings: []; remove: [key: string] }>();
</script>

<template>
  <section class="chart-section condition-summary" :aria-label="title">
    <header class="condition-heading">
      <h3>
        <ChartIcon :name="icon" />{{ title }}<span class="condition-count">{{ items.length }}</span>
      </h3>
      <button type="button" :aria-label="settingsLabel" @click="emit('settings')">
        <ChartIcon name="settings" />设置
      </button>
    </header>
    <div v-if="items.length" class="condition-tags">
      <template v-for="item in items" :key="item.key">
        <button
          v-if="removable && item.removable !== false"
          type="button"
          class="condition-tag"
          :aria-label="'移除' + item.label"
          @click="emit('remove', item.key)"
        >
          {{ item.label }}<ChartIcon name="x" />
        </button>
        <span v-else class="condition-tag">{{ item.label }}</span>
      </template>
    </div>
    <p v-else class="condition-empty">无</p>
  </section>
</template>
