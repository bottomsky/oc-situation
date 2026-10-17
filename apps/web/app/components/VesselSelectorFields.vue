<script setup lang="ts">
import type { VesselTracksSelector } from '@ais/contracts';
const model = defineModel<VesselTracksSelector | undefined>();
const selectedCategory = computed(() => {
  const codes = [...new Set(model.value?.shipTypes ?? [])].sort((a, b) => a - b);
  for (const start of [30, 60, 70, 80]) {
    const group = start === 30 ? [30] : Array.from({ length: 10 }, (_, i) => start + i);
    if (JSON.stringify(group) === JSON.stringify(codes)) return String(start);
  }
  return '';
});
const codesText = ref('');
function parseCodes(text: string) {
  return text.trim()
    ? text
        .trim()
        .split(/[,，\s]+/)
        .map((code) => (code ? Number(code) : NaN))
    : undefined;
}
watch(
  () => model.value?.shipTypes,
  (codes) => {
    if (JSON.stringify(parseCodes(codesText.value)) !== JSON.stringify(codes))
      codesText.value = codes?.join(', ') ?? '';
  },
  { immediate: true },
);
function text(field: 'query' | 'model', event: Event) {
  model.value = { ...model.value, [field]: (event.target as HTMLInputElement).value || undefined };
}
function codes(event: Event) {
  codesText.value = (event.target as HTMLInputElement).value;
  model.value = {
    ...model.value,
    shipTypes: parseCodes(codesText.value),
  };
}
function category(event: Event) {
  const value = Number((event.target as HTMLSelectElement).value);
  model.value = {
    ...model.value,
    shipTypes: value
      ? value === 30
        ? [30]
        : Array.from({ length: 10 }, (_, i) => value + i)
      : undefined,
  };
}
</script>
<template>
  <fieldset class="vessel-selector-fields">
    <legend>船舶条件（至少填写一项）</legend>
    <label
      >船名 / MMSI / IMO / 相关信息<input
        aria-label="船舶信息"
        :value="model?.query ?? ''"
        @input="text('query', $event)"
    /></label>
    <label
      >具体型号<input
        aria-label="具体型号"
        :value="model?.model ?? ''"
        placeholder="按已收录的型号资料匹配"
        @input="text('model', $event)"
    /></label>
    <label
      >AIS 船型类别<select aria-label="AIS 船型类别" :value="selectedCategory" @change="category">
        <option value="">请选择类别</option>
        <option value="70">货船（70–79）</option>
        <option value="80">油轮（80–89）</option>
        <option value="60">客船（60–69）</option>
        <option value="30">渔船（30）</option>
      </select></label
    >
    <label
      >AIS 精确船型编码<input
        aria-label="AIS 精确船型编码"
        :value="codesText"
        placeholder="例如 70, 71；范围 1–99"
        @input="codes"
    /></label>
    <p v-if="model?.mmsis?.length">
      已选 MMSI：{{ model.mmsis.join('、') }}
      <button type="button" @click="model = { ...model, mmsis: undefined }">清除</button>
    </p>
    <small>多个条件共同筛选。AIS 船型使用当前资料；具体型号依赖已收录的型号元数据。</small>
  </fieldset>
</template>
<style scoped>
.vessel-selector-fields {
  display: grid;
  gap: 10px;
  min-width: 0;
}
label {
  display: grid;
  gap: 5px;
}
input,
select {
  width: 100%;
  min-width: 0;
}
</style>
