<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { dateLabel } from '../utils/display';
import type { IntelligenceGeometry } from '@ais/contracts';
const props = defineProps<{
  state: UnwrapNestedRefs<ReturnType<typeof useReachability>>;
  selectedMmsi?: string;
}>();
const result = computed(() => props.state.result?.prediction);
const emit = defineEmits<{ locate: [geometry: IntelligenceGeometry] }>();
const locateGeometry = computed(() => {
  if (result.value?.status !== 'ready') return null;
  const horizon = result.value.horizons.find((h) => h.minutes === props.state.minutes);
  if (props.state.view === 'passage' && horizon?.passageCells.length)
    return {
      type: 'MultiPolygon' as const,
      coordinates: horizon.passageCells.map((cell) => cell.geometry.coordinates),
    };
  return horizon?.coverage.find((c) => c.level === 0.95)?.geometry ?? null;
});
const toggleLevel = (level: number) => {
  const levels = props.state.levels;
  props.state.setLevels(
    levels.includes(level) ? levels.filter((v) => v !== level) : [...levels, level],
  );
};
</script>
<template>
  <section class="prediction-panel" aria-label="船舶可达性预测" data-testid="prediction-panel">
    <header>
      <small>MOTION ENSEMBLE</small>
      <h2>未来航行态势</h2>
      <p>用近期运动与历史残差推演未来位置与沿途通过概率。</p>
    </header>
    <form @submit.prevent="state.run()">
      <label
        >目标船舶 MMSI<input
          :value="state.mmsi"
          :disabled="state.busy"
          @input="state.setMmsi(($event.target as HTMLInputElement).value)"
          inputmode="numeric"
          maxlength="9"
          placeholder="输入9位MMSI"
      /></label>
      <div class="prediction-actions">
        <button type="button" :disabled="!selectedMmsi" @click="state.setMmsi(selectedMmsi!)">
          使用当前船</button
        ><button :disabled="state.busy">{{ state.busy ? '计算中…' : '立即预测' }}</button
        ><button type="button" @click="state.follow()">＋ 关注</button>
      </div>
    </form>
    <FetchState :busy="state.busy" :error="state.error" @retry="state.run()" />
    <button v-if="state.busy" @click="state.cancel()">取消任务</button>
    <p v-if="state.message" role="status" class="muted">{{ state.message }}</p>
    <button v-if="state.result && !state.busy" @click="state.load()">刷新结果</button>
    <div class="prediction-watch">
      <span>关注船舶 {{ state.watchlist.length }} / 20</span>
      <div>
        <span v-for="id in state.watchlist" :key="id"
          ><button
            @click="
              state.setMmsi(id);
              state.run();
            "
          >
            {{ id }}</button
          ><button :aria-label="'移除关注 ' + id" @click="state.unfollow(id)">×</button></span
        >
      </div>
    </div>
    <template v-if="result">
      <div class="prediction-result-head">
        <strong>{{ result.mmsi }}</strong
        ><span class="prediction-badge">未校准 · 模型概率</span
        ><button @click="state.setVisible(!state.visible)">
          {{ state.visible ? '隐藏图层' : '显示图层' }}
        </button>
        <button
          :disabled="!locateGeometry"
          @click="if (locateGeometry) emit('locate', locateGeometry);"
        >
          定位预测
        </button>
      </div>
      <dl class="prediction-times">
        <div>
          <dt>数据时间</dt>
          <dd>{{ dateLabel(result.inputWindow.to) }}</dd>
        </div>
        <div>
          <dt>计算时间</dt>
          <dd>{{ dateLabel(state.result?.computedAt) }}</dd>
        </div>
        <div>
          <dt>基准时间</dt>
          <dd>{{ dateLabel(result.asOf) }}</dd>
        </div>
      </dl>
      <p v-if="state.result?.stale" class="prediction-quality" role="status">
        历史结果已过期 · 保留原基准与几何供核对，航警影响已停用。重新预测可获取当前态势。
      </p>
      <p v-if="result.status !== 'ready'" class="prediction-quality" role="status">
        {{ result.reason || '观测质量暂不满足预测条件' }}
      </p>
      <template v-else>
        <div class="prediction-timeaxis" aria-label="预测时间轴">
          <button
            v-for="time in [15, 30, 60, 120] as const"
            :key="time"
            :aria-pressed="state.minutes === time"
            @click="state.setMinutes(time)"
          >
            ＋{{ time }}分钟
          </button>
        </div>
        <div class="prediction-views" role="group" aria-label="预测视图">
          <button :aria-pressed="state.view === 'position'" @click="state.setView('position')">
            位置概率</button
          ><button :aria-pressed="state.view === 'passage'" @click="state.setView('passage')">
            沿途概率走廊
          </button>
        </div>
        <p class="muted">
          {{
            state.view === 'position'
              ? '显示所选时刻的位置分布，每条样本路径贡献一个位置。'
              : '显示基准时刻至所选时刻的通过概率，同一路径在同一网格去重。'
          }}
        </p>
        <div v-if="state.view === 'position'" class="prediction-levels">
          <label v-for="level in [0.5, 0.8, 0.95]" :key="level"
            ><input
              type="checkbox"
              :checked="state.levels.includes(level)"
              @change="toggleLevel(level)"
            />{{ level * 100 }}% 累计区</label
          >
        </div>
        <div class="probability-ramp"><span>平滑密度 低</span><i /><span>高</span></div>
        <p class="muted">
          色彩为实际网格概率加权的平滑密度。悬停读取原始概率，虚线保留原始累计区。
        </p>
      </template>
      <details open class="prediction-quality">
        <summary>样本与质量</summary>
        <p>
          有效观测 {{ result.quality.acceptedObservations }} · 拒绝观测
          {{ result.quality.rejectedObservations }}<br />有效路径
          {{ result.monteCarlo.effectivePaths }} · 陆地拒绝 {{ result.rejection.land }} /
          {{ result.rejection.proposed }}<br />随机种子 {{ result.seed }} ·
          {{ result.landConstraint === 'checked' ? '已执行陆地约束' : '陆地约束数据缺失' }}
        </p>
        <p>{{ result.calibration.note }}</p>
        <p v-if="result.residuals">
          残差来源 {{ result.residuals.source === 'historical' ? '历史航行' : '近期轨迹' }} ·
          {{ result.residuals.samples }} 个样本
        </p>
        <p v-for="note in result.limitations" :key="note">{{ note }}</p>
        <p v-for="note in state.result?.evidence?.limitations" :key="note">{{ note }}</p>
        <p>概率条件：路径通过完整120分钟陆地检验。模型 {{ result.modelVersion }}</p>
      </details>
    </template>
    <p v-else class="prediction-empty">选择目标后运行预测。结果将在全部计算完成后显示。</p>
  </section>
</template>
<style scoped>
.prediction-panel {
  padding: 20px 16px;
  color: #bad7e4;
  font-size: 12px;
}
.prediction-panel header {
  padding-bottom: 16px;
  border-bottom: 1px solid #235168;
  margin-bottom: 16px;
}
.prediction-panel header small {
  font:
    10px Georgia,
    serif;
  letter-spacing: 0.18em;
  color: #63c9d2;
}
.prediction-panel h2 {
  font-size: 20px;
  letter-spacing: 0.06em;
  color: #e1f1f3;
  margin: 5px 0 8px;
}
.prediction-panel p {
  line-height: 1.7;
}
.prediction-panel input:not([type='checkbox']) {
  display: block;
  width: 100%;
  margin-top: 7px;
  padding: 9px;
  background: #071c2b;
  border: 1px solid #2c5870;
  color: #d9eef4;
}
.prediction-actions {
  display: flex;
  gap: 6px;
  margin: 10px 0;
}
.prediction-panel button {
  font-size: 11px;
  padding: 7px;
  color: #b8d7e3;
  background: #0c2a3d;
  border: 1px solid #2a566d;
  border-radius: 3px;
}
.prediction-panel button[aria-pressed='true'],
.prediction-actions button:nth-child(2) {
  background: #12465a;
  border-color: #35a7b5;
  color: #a6f6ee;
}
.prediction-panel button:disabled {
  opacity: 0.5;
}
.prediction-watch {
  padding: 12px 0;
  border-bottom: 1px solid #22465a;
  color: #8daeba;
}
.prediction-watch > div {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}
.prediction-watch > div > span {
  display: flex;
}
.prediction-result-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 18px;
}
.prediction-result-head strong {
  color: #a2f3e9;
  font-size: 16px;
}
.prediction-badge {
  font-size: 10px;
  color: #dfbd7a;
  border: 1px solid #7a6844;
  border-radius: 2px;
  padding: 3px 5px;
}
.prediction-times {
  font-size: 10px;
}
.prediction-times > div {
  display: flex;
  justify-content: space-between;
  margin: 7px 0;
}
.prediction-times dt {
  color: #7fa2b6;
}
.prediction-times dd {
  margin: 0;
}
.prediction-timeaxis,
.prediction-views {
  display: flex;
  gap: 4px;
  margin-top: 16px;
}
.prediction-timeaxis button,
.prediction-views button {
  flex: 1;
}
.prediction-levels {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
}
.prediction-levels label {
  display: flex;
  align-items: center;
  gap: 3px;
}
.prediction-levels input {
  accent-color: #3ac5d1;
}
.probability-ramp {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 16px 0;
  font-size: 10px;
}
.probability-ramp i {
  flex: 1;
  height: 5px;
  background: linear-gradient(90deg, #17456e, #2079b9, #2cd3df, #b8fbef);
  border-radius: 2px;
}
.prediction-quality {
  padding: 12px;
  background: #0a2334;
  border-left: 2px solid #397e92;
  margin-top: 16px;
  font-size: 11px;
}
.prediction-quality summary {
  cursor: pointer;
  color: #a8dce4;
}
.prediction-empty {
  margin-top: 24px;
  color: #7a9dad;
  text-align: center;
}
</style>
