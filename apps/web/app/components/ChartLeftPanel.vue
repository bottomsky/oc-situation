<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { ChartLayerVisibility } from '../types/chart';
import { dateLabel } from '../utils/display';
import { resolveVesselDirection } from '../utils/vesselMarkers';
const workspace = defineModel<UnwrapNestedRefs<ReturnType<typeof useChartWorkspace>>>('workspace', {
  required: true,
});
defineProps<{ layers: ChartLayerVisibility }>();
const emit = defineEmits<{
  close: [];
  layer: [key: keyof ChartLayerVisibility, enabled: boolean];
}>();
const detailDirection = computed(() =>
  resolveVesselDirection(workspace.value.detail?.latestPosition ?? {}),
);
// Mount heavy editors on first use, then retain their drafts while the panel or tab is hidden.
const visitedTabs = reactive(new Set<string>());
watch(
  () => workspace.value.leftTab,
  (tab) => visitedTabs.add(tab),
  { immediate: true },
);
const layerNames: Record<keyof ChartLayerVisibility, string> = {
  ais: 'AIS 船位',
  tracks: '船舶轨迹',
  evidence: '专题证据',
};
</script>
<template>
  <aside class="chart-left chart-panel" aria-label="人工操控面板" data-testid="chart-left-panel">
    <header class="chart-panel-heading">
      <div>
        <h2>人工操控面板</h2>
        <small>MANUAL OPERATIONS</small>
      </div>
      <button aria-label="折叠操作面板" @click="emit('close')">×</button>
    </header>
    <div class="chart-tabs" role="tablist" aria-label="操作面板功能">
      <button
        v-for="tab in [
          { id: 'search', name: '船舶搜索' },
          { id: 'intelligence', name: '情报标绘' },
          { id: 'layers', name: '图层控制' },
          { id: 'playback', name: '时间回放' },
          { id: 'heatmap', name: 'AIS 热力图' },
        ] as const"
        :key="tab.id"
        role="tab"
        :aria-selected="workspace.leftTab === tab.id"
        @click="workspace.leftTab = tab.id"
      >
        {{ tab.name }}
      </button>
    </div>
    <div class="chart-panel-scroll">
      <div v-if="visitedTabs.has('intelligence')" v-show="workspace.leftTab === 'intelligence'">
        <slot name="intelligence" />
      </div>
      <div v-if="visitedTabs.has('heatmap')" v-show="workspace.leftTab === 'heatmap'">
        <slot name="heatmap" />
      </div>
      <section v-show="workspace.leftTab === 'search'" class="chart-section">
        <h2>船舶搜索</h2>
        <form class="search-row" @submit.prevent="workspace.find(false)">
          <input
            v-model="workspace.search"
            aria-label="船舶搜索"
            placeholder="MMSI / 船名 / IMO"
          /><button :disabled="workspace.searchBusy">搜索</button>
        </form>
        <FetchState
          :busy="workspace.searchBusy"
          :error="workspace.searchError"
          @retry="workspace.find(false)"
        />
        <p v-if="workspace.searchCompleted" class="muted" data-testid="applied-search">
          已加载结果：{{ workspace.appliedSearch || '全部船舶' }} ·
          {{ workspace.results.length }} 条
          <span v-if="workspace.searchBusy"> · 正在查询新条件</span>
        </p>
        <button
          v-for="v in workspace.results"
          :key="v.mmsi"
          class="search-result"
          data-testid="vessel-result"
          @click="workspace.select(v.mmsi)"
        >
          <strong>{{ v.staticFields.name || '船名待补充' }}</strong
          ><small>{{ v.mmsi }} · {{ v.latestPosition?.sourceId || '暂无船位' }}</small></button
        ><button
          v-if="workspace.cursor"
          :disabled="workspace.searchBusy"
          @click="workspace.find(true)"
        >
          加载更多</button
        ><FetchState :error="workspace.detailError" />
        <div v-if="workspace.detail" class="vessel-detail">
          <div class="section-rule" />
          <h2>船舶详情</h2>
          <button @click="workspace.leftTab = 'playback'">查询历史轨迹 →</button>
          <h3>{{ workspace.detail.staticFields.name || workspace.detail.mmsi }}</h3>
          <span
            v-if="workspace.detail.latestPosition?.quality.includes('synthetic')"
            class="badge sample"
            >样例数据</span
          >
          <dl class="detail-grid">
            <div>
              <dt>MMSI</dt>
              <dd class="mono">{{ workspace.detail.mmsi }}</dd>
            </div>
            <div>
              <dt>IMO</dt>
              <dd>{{ workspace.detail.staticFields.imo || '—' }}</dd>
            </div>
            <div>
              <dt>航速 / 对地航向</dt>
              <dd>
                {{ workspace.detail.latestPosition?.sogKnots ?? '—' }} kn /
                {{ workspace.detail.latestPosition?.cogDegrees ?? '—' }}°
              </dd>
            </div>
            <div>
              <dt>地图方向</dt>
              <dd>{{ detailDirection.directionLabel }}</dd>
            </div>
            <div>
              <dt>坐标</dt>
              <dd>
                {{ workspace.detail.latestPosition?.lon.toFixed(4) }},
                {{ workspace.detail.latestPosition?.lat.toFixed(4) }}
              </dd>
            </div>
            <div>
              <dt>目的地</dt>
              <dd>{{ workspace.detail.staticFields.destination || '—' }}</dd>
            </div>
            <div>
              <dt>数据来源</dt>
              <dd>{{ workspace.detail.latestPosition?.sourceId || '—' }}</dd>
            </div>
          </dl>
          <div class="detail-time">
            报告：{{ dateLabel(workspace.detail.latestPosition?.observedAt) }}<br />接收：{{
              dateLabel(workspace.detail.latestPosition?.receivedAt)
            }}<br />质量：{{ workspace.detail.latestPosition?.quality.join('、') || '有效观测' }}
          </div>
          <details>
            <summary class="muted">静态资料与字段来源</summary>
            <dl
              v-for="(value, field) in workspace.detail.staticFields"
              :key="field"
              class="detail-time"
            >
              <dt>{{ field }}：{{ typeof value === 'object' ? JSON.stringify(value) : value }}</dt>
              <dd>
                {{ workspace.detail.provenance[field]?.sourceId || '—' }} ·
                {{ dateLabel(workspace.detail.provenance[field]?.observedAt) }}
              </dd>
            </dl>
          </details>
        </div>
        <p v-else-if="!workspace.results.length" class="muted" style="margin-top: 20px">
          在地图中选择单船，或搜索船舶查看详情与历史轨迹。
        </p>
      </section>
      <section v-show="workspace.leftTab === 'layers'" class="chart-section">
        <h3>图层控制</h3>
        <p class="muted">开关控制海图显示，船位采集持续进行。</p>
        <label v-for="(name, key) in layerNames" :key="key" class="chart-layer-check"
          ><input
            type="checkbox"
            :checked="layers[key]"
            @change="emit('layer', key, ($event.target as HTMLInputElement).checked)"
          />{{ name }}</label
        >
      </section>
      <section v-show="workspace.leftTab === 'playback'" class="chart-section">
        <h3>时间回放</h3>
        <p v-if="!workspace.detail" class="empty-copy">
          先在搜索或海图中选择单船，再查询历史轨迹。
        </p>
        <template v-else
          ><form class="track-form" @submit.prevent="workspace.loadTrack">
            <label
              >轨迹起始（UTC）<input
                v-model="workspace.from"
                type="datetime-local"
                step="1"
                required /></label
            ><label
              >轨迹结束（UTC）<input
                v-model="workspace.to"
                type="datetime-local"
                step="1"
                required /></label
            ><button :disabled="workspace.trackBusy">查询轨迹</button>
          </form>
          <FetchState
            :busy="workspace.trackBusy"
            :error="workspace.trackError"
            @retry="workspace.loadTrack"
          />
          <div v-if="workspace.track" class="track-controls">
            <p data-testid="track-summary">
              {{ workspace.track.returned }} / {{ workspace.track.total }} 点 ·
              {{ workspace.track.segments.length }} 段<span v-if="workspace.track.sampled">
                · 抽稀显示</span
              ><span v-if="workspace.track.truncated"> · 已截断</span>
            </p>
            <p class="muted">超过 30 分钟的缺口及日期变更线分段显示。</p>
            <template v-if="workspace.track.returned"
              ><button @click="workspace.playing = !workspace.playing">
                {{ workspace.playing ? '暂停播放' : '播放轨迹' }}</button
              ><input
                v-model.number="workspace.frameIndex"
                aria-label="轨迹播放位置"
                type="range"
                min="0"
                :max="Math.max(0, workspace.track.returned - 1)"
              />
              <p class="detail-time">
                {{ dateLabel(workspace.frame?.observedAt) }}<br />接收：{{
                  dateLabel(workspace.frame?.receivedAt)
                }}<br />{{ workspace.frame?.sourceId }} · {{ workspace.frame?.sogKnots ?? '—' }} kn
              </p></template
            >
            <p v-else class="muted">该时间范围没有轨迹点。</p>
          </div>
        </template>
      </section>
      <section class="chart-section chart-filters">
        <h3>观测筛选</h3>
        <label
          >数据来源<select v-model="workspace.sourceId">
            <option value="">全部来源</option>
            <option
              v-for="source in workspace.sources"
              :key="source.sourceId"
              :value="source.sourceId"
            >
              {{ source.name }}
            </option>
          </select></label
        ><label
          >最近报告<select v-model="workspace.hours">
            <option :value="24">24 小时</option>
            <option :value="72">3 天</option>
            <option :value="168">7 天</option>
            <option :value="720">30 天</option>
          </select></label
        ><label
          >船型代码<input
            v-model="workspace.shipType"
            type="number"
            min="1"
            max="99"
            placeholder="全部船型"
        /></label>
      </section>
      <section class="chart-section">
        <h3>航线筹划</h3>
        <p class="muted">航线规划、气象风险、碰撞 CPA / TCPA 服务未接入。</p>
        <button disabled>生成航线 · 未接入</button>
      </section>
    </div>
  </aside>
</template>
