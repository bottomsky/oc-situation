<script setup lang="ts">
defineProps<{ title: string; eyebrow?: string; meta?: string }>();
</script>

<template>
  <section class="detail-section">
    <header class="detail-section-heading">
      <div>
        <p v-if="eyebrow" class="detail-eyebrow">{{ eyebrow }}</p>
        <h3>{{ title }}</h3>
      </div>
      <small v-if="meta" class="detail-meta">{{ meta }}</small>
      <div v-if="$slots.actions" class="detail-actions"><slot name="actions" /></div>
    </header>
    <slot />
  </section>
</template>
