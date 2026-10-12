<script setup lang="ts">
defineProps<{ busy?: boolean; error?: string; empty?: boolean }>();
defineEmits<{ retry: [] }>();
</script>
<template>
  <div v-if="busy" role="status" class="fetch-state">正在读取数据…</div>
  <div v-else-if="error" role="alert" class="fetch-state error">
    {{ error }} <button @click="$emit('retry')">重新加载</button>
  </div>
  <div v-else-if="empty" class="fetch-state">当前范围没有记录。调整筛选条件或运行采集任务。</div>
</template>
