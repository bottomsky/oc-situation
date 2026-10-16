<script setup lang="ts">
const open = defineModel<boolean>({ required: true });
const props = defineProps<{
  title: string;
  sections: { id: string; label: string }[];
}>();
const emit = defineEmits<{ apply: []; reset: [] }>();
const dialog = useTemplateRef<HTMLDialogElement>('dialog');
const section = ref('');
let previousFocus: HTMLElement | null = null;
watch(open, async (value) => {
  if (value) {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    section.value = props.sections[0]?.id ?? '';
    await nextTick();
    if (open.value && !dialog.value?.open) dialog.value?.showModal();
  } else {
    dialog.value?.close();
    previousFocus?.focus({ preventScroll: true });
  }
});
onBeforeUnmount(() => dialog.value?.close());
</script>

<template>
  <dialog
    ref="dialog"
    class="chart-settings-dialog"
    :aria-label="title"
    @cancel.prevent="open = false"
    @close="open = false"
    @keydown.stop
    @wheel.stop
  >
    <form @submit.prevent="emit('apply')">
      <header class="settings-heading">
        <h2>{{ title }}</h2>
        <button type="button" :aria-label="'关闭' + title" @click="open = false">
          <ChartIcon name="x" />
        </button>
      </header>
      <div class="settings-body">
        <nav aria-label="设置分组">
          <button
            v-for="item in sections"
            :key="item.id"
            type="button"
            :aria-current="section === item.id ? 'page' : undefined"
            @click="section = item.id"
          >
            {{ item.label }}
          </button>
        </nav>
        <div class="settings-content"><slot :section="section" /></div>
      </div>
      <footer class="settings-footer">
        <button type="button" @click="emit('reset')">重置</button>
        <span />
        <button type="button" @click="open = false">取消</button>
        <button type="submit" class="settings-apply">应用</button>
      </footer>
    </form>
  </dialog>
</template>
