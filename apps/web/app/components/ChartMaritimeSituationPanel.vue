<script setup lang="ts">
import type { IntelligenceGeometry } from '@ais/contracts';
import {
  situationAgeDraft,
  situationAgeLabel,
  situationAgeMinutes,
  situationAgePresets,
  type SituationAgeUnit,
} from '../utils/maritimeSituation';

interface BusinessReference {
  kind: 'route' | 'event';
  id: string;
  label: string;
  revision: number;
  geometry?: IntelligenceGeometry | null;
}
const props = withDefaults(
  defineProps<{
    hours: number;
    loadedCount: number;
    loading: boolean;
    paused: boolean;
    selectedShips: string[];
    vesselNames: Record<string, string>;
    selectedBusiness: BusinessReference[];
    currentMmsi?: string;
    businessChoices: { kind: 'route' | 'event'; id: string; label: string }[];
    businessLoading?: boolean;
    error?: string;
  }>(),
  { businessLoading: false, error: '' },
);
const emit = defineEmits<{
  applyHours: [hours: number];
  addCurrentShip: [];
  removeShip: [mmsi: string];
  selectShip: [mmsi: string];
  loadBusiness: [];
  addBusiness: [choice: string];
  removeBusiness: [reference: { kind: 'route' | 'event'; id: string }];
  clear: [];
}>();
const draft = reactive<{ value: number | string; unit: SituationAgeUnit }>(
  situationAgeDraft(props.hours),
);
const businessChoice = ref('');
const minutes = computed(() => situationAgeMinutes(Number(draft.value), draft.unit));
const pending = computed(() => minutes.value !== Math.round(props.hours * 60));
const selectedCount = computed(() => props.selectedShips.length + props.selectedBusiness.length);
const full = computed(() => selectedCount.value >= 100);
const currentSelected = computed(
  () => !!props.currentMmsi && props.selectedShips.includes(props.currentMmsi),
);
watch(
  () => props.hours,
  (hours) => Object.assign(draft, situationAgeDraft(hours)),
);
function preset(value: number) {
  Object.assign(draft, situationAgeDraft(value / 60));
}
function changeUnit(event: Event) {
  const unit = (event.target as HTMLSelectElement).value as SituationAgeUnit;
  const factors = { minutes: 1, hours: 60, days: 1440 };
  const current = minutes.value;
  draft.unit = unit;
  if (current !== null) draft.value = current / factors[unit];
}
function apply() {
  if (minutes.value !== null) emit('applyHours', minutes.value / 60);
}
function addBusiness() {
  if (!businessChoice.value || full.value) return;
  emit('addBusiness', businessChoice.value);
  businessChoice.value = '';
}
</script>

<template>
  <section
    class="maritime-situation-panel"
    aria-label="海洋态势"
    data-testid="maritime-situation-panel"
  >
    <header class="situation-heading">
      <small>MARITIME SITUATION</small>
      <h2>海洋态势</h2>
      <p>管理海图船位的报告时效与本次人工关注对象。</p>
    </header>

    <section class="situation-block" aria-labelledby="situation-age-heading">
      <div class="situation-block-title">
        <h3 id="situation-age-heading"><ChartIcon name="History" :size="15" />船位时间范围</h3>
        <span class="situation-status" :class="{ muted: paused }" role="status">{{
          loading ? '加载中' : paused ? '更新已暂停' : '持续更新'
        }}</span>
      </div>
      <div class="situation-current" data-testid="situation-current-age">
        <div>
          <span>当前范围</span><strong>最近 {{ situationAgeLabel(hours) }}</strong>
        </div>
        <div>
          <span>{{ loading ? '上一完整视窗' : '当前范围已加载' }}</span
          ><strong class="situation-count"
            >{{ loadedCount.toLocaleString() }}<small> 艘</small></strong
          >
        </div>
      </div>
      <p class="situation-copy">
        按末报观测时间筛选，每艘显示最新船位，范围随当前时间滚动。历史轨迹可在时间回放中查看。
      </p>
      <form class="situation-age-form" @submit.prevent="apply">
        <fieldset>
          <legend>快捷范围</legend>
          <div class="situation-presets" role="group" aria-label="船位时间快捷范围">
            <button
              v-for="option in situationAgePresets"
              :key="option.minutes"
              type="button"
              :aria-pressed="minutes === option.minutes"
              @click="preset(option.minutes)"
            >
              {{ option.label }}
            </button>
          </div>
        </fieldset>
        <label class="situation-custom">
          <span>自定义时长</span>
          <span class="situation-custom-fields">
            <input
              v-model="draft.value"
              type="number"
              step="any"
              min="0"
              inputmode="decimal"
              aria-label="船位时间范围数值"
              :aria-invalid="minutes === null"
              :aria-describedby="minutes === null ? 'situation-age-validation' : undefined"
            />
            <select :value="draft.unit" aria-label="船位时间范围单位" @change="changeUnit">
              <option value="minutes">分钟</option>
              <option value="hours">小时</option>
              <option value="days">天</option>
            </select>
          </span>
        </label>
        <p
          v-if="minutes === null"
          id="situation-age-validation"
          class="situation-validation"
          role="alert"
        >
          请按整分钟设置，范围为 1 分钟至 30 天。
        </p>
        <div class="situation-apply">
          <span>{{
            pending && minutes !== null
              ? '待应用：最近 ' + situationAgeLabel(minutes / 60)
              : '当前范围已应用'
          }}</span>
          <button type="submit" :disabled="minutes === null || !pending">
            应用范围<ChartIcon name="ArrowRight" :size="13" />
          </button>
        </div>
      </form>
    </section>

    <section
      class="situation-block situation-attention"
      aria-labelledby="situation-attention-heading"
    >
      <div class="situation-block-title">
        <h3 id="situation-attention-heading"><ChartIcon name="Radar" :size="15" />人工关注</h3>
        <span class="situation-quota" :class="{ full }"
          >{{ selectedCount }} <small>/ 100</small></span
        >
      </div>
      <p class="situation-copy">
        供人工和 AI 研判使用的船舶、航线与事件。修改船位时间范围时保留关注集合。
      </p>
      <div class="situation-attention-actions">
        <button
          type="button"
          :disabled="!currentMmsi || currentSelected || full"
          @click="emit('addCurrentShip')"
        >
          <ChartIcon name="Plus" :size="13" />{{
            currentSelected ? '当前船已关注' : '关注当前船舶'
          }}
        </button>
        <button type="button" :disabled="businessLoading" @click="emit('loadBusiness')">
          <ChartIcon name="Compass" :size="13" />{{
            businessLoading ? '读取中…' : '添加航线或事件'
          }}
        </button>
      </div>
      <p class="situation-current-vessel">
        {{ currentMmsi ? '当前船舶 ' + currentMmsi : '在海图或船舶搜索中选船后，可加入关注。' }}
      </p>
      <label v-if="businessChoices.length" class="situation-business-choice"
        ><span>选择业务对象</span
        ><select
          v-model="businessChoice"
          :disabled="full"
          aria-label="添加关注业务对象"
          @change="addBusiness"
        >
          <option value="">选择航线或事件加入集合</option>
          <option
            v-for="item in businessChoices"
            :key="`${item.kind}:${item.id}`"
            :value="`${item.kind}:${item.id}`"
          >
            {{ item.kind === 'route' ? '航线' : '事件' }} · {{ item.label }}
          </option>
        </select></label
      >
      <p v-if="full" class="situation-capacity" role="status">
        关注集合已满，可先移除部分对象再添加。
      </p>
      <p v-if="error" class="situation-validation" role="alert">{{ error }}</p>

      <div v-if="!selectedCount" class="situation-empty">
        <ChartIcon name="Ship" :size="24" /><strong>暂无人工关注对象</strong
        ><span>关注对象将在这里统一管理。</span>
      </div>
      <div v-else class="situation-object-lists">
        <div v-if="selectedShips.length" class="situation-list-heading">
          船舶<span>{{ selectedShips.length }}</span>
        </div>
        <ul v-if="selectedShips.length" class="situation-object-list" aria-label="人工关注船舶">
          <li v-for="mmsi in selectedShips" :key="mmsi">
            <ChartIcon name="Ship" :size="16" />
            <div>
              <button
                class="situation-object-name"
                type="button"
                :title="vesselNames[mmsi] || mmsi"
                @click="emit('selectShip', mmsi)"
              >
                {{ vesselNames[mmsi] || '船舶 ' + mmsi }}</button
              ><small>MMSI {{ mmsi }}</small>
            </div>
            <button
              class="situation-remove"
              type="button"
              :aria-label="`移除关注船舶 ${mmsi}`"
              @click="emit('removeShip', mmsi)"
            >
              <ChartIcon name="X" :size="14" />
            </button>
          </li>
        </ul>
        <div v-if="selectedBusiness.length" class="situation-list-heading">
          航线与事件<span>{{ selectedBusiness.length }}</span>
        </div>
        <ul
          v-if="selectedBusiness.length"
          class="situation-object-list"
          aria-label="人工关注业务对象"
        >
          <li v-for="item in selectedBusiness" :key="`${item.kind}:${item.id}`">
            <ChartIcon :name="item.kind === 'route' ? 'Compass' : 'Radio'" :size="16" />
            <div>
              <strong class="situation-business-name" :title="item.label">{{ item.label }}</strong
              ><small
                >{{ item.kind === 'route' ? '航线' : '事件' }} · r{{ item.revision
                }}{{ item.geometry ? '' : ' · 未定位' }}</small
              >
            </div>
            <button
              class="situation-remove"
              type="button"
              :aria-label="`移除关注${item.kind === 'route' ? '航线' : '事件'} ${item.label}`"
              @click="emit('removeBusiness', { kind: item.kind, id: item.id })"
            >
              <ChartIcon name="X" :size="14" />
            </button>
          </li>
        </ul>
      </div>
      <footer v-if="selectedCount" class="situation-attention-footer">
        <span>{{ selectedShips.length }} 艘船舶 · {{ selectedBusiness.length }} 个业务对象</span
        ><button type="button" @click="emit('clear')">清空关注</button>
      </footer>
    </section>
  </section>
</template>

<style scoped>
.maritime-situation-panel {
  display: grid;
  gap: 14px;
  padding: 16px 12px 20px;
  color: #d4eaf2;
}
.situation-heading small {
  color: #658e9f;
  font-size: 9px;
  letter-spacing: 0.15em;
}
.situation-heading h2 {
  margin: 5px 0 7px;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.05em;
}
.situation-heading p,
.situation-copy {
  margin: 0;
  color: #87aebb;
  font-size: 11px;
  line-height: 1.7;
}
.situation-block {
  padding: 13px 12px;
  border: 1px solid #244f63;
  border-radius: 5px;
  background: #08243780;
  min-width: 0;
}
.situation-block-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 13px;
}
.situation-block-title h3 {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.situation-block-title h3 svg {
  color: #56c6d9;
}
.situation-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #79c6bc;
  font-size: 10px;
  white-space: nowrap;
}
.situation-status::before {
  content: '';
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
}
.situation-status.muted {
  color: #9ab1bb;
}
.situation-current {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 10px;
  margin-bottom: 11px;
}
.situation-current > div {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.situation-current > div:last-child {
  align-items: flex-end;
}
.situation-current span {
  color: #6f9aaa;
  font-size: 10px;
}
.situation-current strong {
  color: #a5ebf2;
  font-size: 16px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.situation-current .situation-count {
  color: #d7edf3;
}
.situation-current strong small {
  color: #8bafbc;
  font-size: 10px;
}
.situation-age-form {
  margin-top: 14px;
}
.situation-age-form fieldset {
  padding: 0;
  margin: 0 0 13px;
  border: 0;
  min-width: 0;
}
.situation-age-form legend,
.situation-custom > span:first-child,
.situation-business-choice > span {
  display: block;
  margin-bottom: 7px;
  color: #9dbfcb;
  font-size: 10px;
}
.situation-presets {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 5px;
}
.situation-presets button {
  min-width: 0;
  padding: 7px 2px;
  font-size: 10px;
  white-space: nowrap;
}
.situation-presets button,
.situation-attention-actions button {
  border: 1px solid #2b586b;
  border-radius: 3px;
  background: #092b3d;
  color: #9ec1cd;
}
.situation-presets button[aria-pressed='true'] {
  color: #a5f1f5;
  border-color: #4bb6c7;
  background: #104359;
}
.situation-custom {
  display: block;
}
.situation-custom-fields {
  display: flex;
  gap: 7px;
}
.situation-custom input,
.situation-custom select,
.situation-business-choice select {
  border: 1px solid #2a5368;
  border-radius: 3px;
  background: #071f31;
  color: #d3e9f2;
  font-size: 12px;
  padding: 8px 9px;
  min-width: 0;
}
.situation-custom input {
  flex: 1;
  width: 100%;
  font-variant-numeric: tabular-nums;
}
.situation-custom select {
  flex: 0 0 77px;
}
.situation-custom input[aria-invalid='true'] {
  border-color: #bd825e;
}
.situation-apply {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.situation-apply > span {
  color: #7199a8;
  font-size: 9px;
}
.situation-apply > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex: 0 0 auto;
  border: 1px solid #3e9eb2;
  border-radius: 3px;
  background: #0d4057;
  color: #a6edf5;
  padding: 7px 9px;
  font-size: 11px;
}
.situation-quota {
  font-size: 16px;
  color: #a4e5ec;
  font-variant-numeric: tabular-nums;
}
.situation-quota small {
  color: #6f9aab;
  font-size: 10px;
}
.situation-quota.full,
.situation-capacity {
  color: #d7bc83;
}
.situation-attention-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
  margin-top: 13px;
}
.situation-attention-actions button {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 8px 3px;
  font-size: 10px;
}
.situation-current-vessel {
  margin: 8px 0 0;
  color: #729dad;
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.situation-business-choice {
  display: block;
  margin-top: 13px;
}
.situation-business-choice select {
  width: 100%;
  font-size: 10px;
}
.situation-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 24px 8px 13px;
  color: #507f92;
}
.situation-empty strong {
  color: #8fb3c0;
  font-size: 11px;
  font-weight: 400;
}
.situation-empty span {
  color: #648d9e;
  font-size: 10px;
}
.situation-object-lists {
  margin-top: 16px;
}
.situation-list-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 14px 0 7px;
  color: #7da5b5;
  font-size: 10px;
}
.situation-list-heading span {
  font-variant-numeric: tabular-nums;
  color: #9fcbd6;
}
.situation-object-list {
  list-style: none;
  display: grid;
  gap: 5px;
  padding: 0;
  margin: 0;
}
.situation-object-list li {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
  padding: 9px 8px;
  border: 1px solid #204c61;
  border-radius: 3px;
  background: #09293d;
}
.situation-object-list li > svg {
  color: #67b2c6;
  flex: 0 0 16px;
}
.situation-object-list li > div {
  flex: 1;
  min-width: 0;
}
.situation-object-list small {
  display: block;
  margin-top: 4px;
  color: #6998aa;
  font-size: 9px;
  font-variant-numeric: tabular-nums;
}
.situation-object-name,
.situation-business-name {
  display: block;
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #b8dce8;
  text-align: left;
  font-size: 11px;
  font-weight: 400;
}
.situation-object-name {
  padding: 0;
  border: 0;
  background: transparent;
}
.situation-object-name:hover {
  color: #a5f1f5;
  text-decoration: underline;
  text-underline-offset: 3px;
}
.situation-remove {
  display: grid;
  place-items: center;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: #6e99aa;
}
.situation-remove:hover {
  color: #bce9f1;
  background: #1b4356;
}
.situation-attention-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #204b5e;
  font-size: 9px;
  color: #6e99a9;
}
.situation-attention-footer button {
  flex: 0 0 auto;
  padding: 4px 0 4px 6px;
  border: 0;
  background: transparent;
  color: #9db9c4;
  font-size: 10px;
}
.situation-validation,
.situation-capacity {
  margin: 8px 0 0;
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
.situation-validation {
  color: #e6b29a;
}
button:not(:disabled),
select:not(:disabled) {
  cursor: pointer;
}
button:disabled,
select:disabled {
  opacity: 0.48;
  cursor: default;
}
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: 1px solid #68dce8;
  outline-offset: 3px;
}
@container (max-width: 290px) {
  .maritime-situation-panel {
    padding-inline: 8px;
  }
  .situation-block {
    padding-inline: 9px;
  }
  .situation-attention-actions {
    grid-template-columns: 1fr;
  }
  .situation-presets {
    gap: 3px;
  }
}
</style>
