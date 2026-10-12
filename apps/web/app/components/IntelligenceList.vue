<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { IntelligenceCategorySchema } from '@ais/contracts';
import {
  categoryLabels,
  reviewLabels,
  statusLabels,
  objectLabels,
} from '../utils/intelligenceLabels';
import { dateLabel } from '../utils/display';
const state = defineModel<UnwrapNestedRefs<ReturnType<typeof useIntelligenceWorkspace>>>('state', {
  required: true,
});
const emit = defineEmits<{ select: [id: string]; locate: [id?: string] }>();
const objectSearch = ref('');
const filteredObjects = computed(() =>
  state.value.objects.filter((o) =>
    [o.name, ...o.aliases].some((v) => v.includes(objectSearch.value)),
  ),
);
const categories = IntelligenceCategorySchema.options;
</script>
<template>
  <section class="chart-section intelligence-list" aria-label="情报标绘">
    <h2>情报检索与标绘</h2>
    <form class="track-form" @submit.prevent="state.load()">
      <input
        v-model="state.filters.keyword"
        aria-label="情报关键词"
        placeholder="标题、摘要、原文关键词"
      />
      <select v-model="state.filters.category" aria-label="情报类别">
        <option value="">全部类别</option>
        <option v-for="c in categories" :key="c" :value="c">{{ categoryLabels[c] }}</option>
      </select>
      <select v-model="state.filters.sourceId" aria-label="情报来源">
        <option value="">全部来源</option>
        <option v-for="s in state.sources" :key="s.sourceId" :value="s.sourceId">
          {{ s.name }}
        </option>
      </select>
      <select v-model="state.filters.reviewStatus" aria-label="情报审核状态">
        <option value="">全部审核状态</option>
        <option value="candidate">待核实</option>
        <option value="confirmed">已确认</option>
        <option value="rejected">已驳回</option>
      </select>
      <select v-model="state.filters.status" aria-label="情报有效状态">
        <option value="">全部有效状态</option>
        <option value="active">有效</option>
        <option value="revised">已修订</option>
        <option value="withdrawn">已撤回</option>
      </select>
      <label>有效期起（UTC）<input v-model="state.filters.from" type="datetime-local" /></label>
      <label>有效期止（UTC）<input v-model="state.filters.to" type="datetime-local" /></label>
      <input
        v-model="objectSearch"
        aria-label="筛选关联对象"
        placeholder="搜索对象名称 / 别名"
      /><select v-model="state.filters.objectId" aria-label="关联对象">
        <option value="">全部关联对象</option>
        <option v-for="o in filteredObjects" :key="o.id" :value="o.id">
          {{ o.name }} · {{ objectLabels[o.kind] }}
        </option>
      </select>
      <label class="chart-layer-check"
        ><input v-model="state.viewportOnly" type="checkbox" />仅当前海图视野</label
      >
      <button :disabled="state.busy">检索情报</button>
    </form>
    <FetchState :busy="state.busy" :error="state.error" @retry="state.load()" />
    <p class="detail-time">
      已勾选 {{ state.selectedIds.length }} · 标绘 {{ state.plottedIds.length }} · 隐藏
      {{ state.hiddenIds.length }}
    </p>
    <div class="intelligence-actions">
      <button :disabled="!state.selectedIds.length" @click="state.add()">批量加入</button
      ><button :disabled="!state.selectedIds.length" @click="state.remove()">批量移除</button
      ><button :disabled="!state.selectedIds.length" @click="state.hide()">隐藏所选</button
      ><button @click="state.clear()">清空标绘</button
      ><button @click="emit('locate')">定位全部</button>
    </div>
    <details>
      <summary>情报图层显示</summary>
      <label
        v-for="(label, key) in {
          location: '发生位置',
          object: '对象关联',
          impact: '影响范围',
          candidate: '待核实关系',
          directory: '对象目录',
        }"
        :key="key"
        class="chart-layer-check"
        ><input v-model="state.layerVisibility[key]" type="checkbox" />{{ label }}</label
      >
    </details>
    <label class="chart-layer-check"
      ><input
        v-model="state.includeCandidates"
        type="checkbox"
        @change="state.refreshPlot()"
      />显示待核实候选关系</label
    >
    <details v-if="state.plottedIds.length" open>
      <summary>当前标绘集合</summary>
      <article v-for="item in state.plot.items" :key="item.eventId" class="plotted-item">
        <strong>{{ item.title }}</strong
        ><small
          >{{ item.featureCount }} 个几何 ·
          {{ state.hiddenIds.includes(item.eventId) ? '已隐藏' : '显示中' }}</small
        >
        <div class="intelligence-actions">
          <button @click="emit('select', item.eventId)">证据</button
          ><button @click="emit('locate', item.eventId)">定位</button
          ><button v-if="state.hiddenIds.includes(item.eventId)" @click="state.add([item.eventId])">
            恢复显示</button
          ><button v-else @click="state.hide([item.eventId])">隐藏</button
          ><button @click="state.remove([item.eventId])">移除</button>
        </div>
      </article>
    </details>
    <p v-if="state.feedback" class="chart-caution" role="status">{{ state.feedback }}</p>
    <div
      v-for="item in state.items"
      :key="item.id"
      class="intelligence-row"
      :class="{ selected: state.activeId === item.id }"
    >
      <input
        :checked="state.selectedIds.includes(item.id)"
        type="checkbox"
        :aria-label="'勾选 ' + item.title"
        @change="state.toggleSelection(item.id)"
      />
      <button class="fusion-event" @click="emit('select', item.id)">
        <strong>{{ item.title }}</strong
        ><span>{{ item.summary }}</span
        ><small>{{ item.sourceId }} · v{{ item.version }} · {{ dateLabel(item.publishedAt) }}</small
        ><small
          >{{ statusLabels[item.status] }} · {{ reviewLabels[item.reviewStatus || 'candidate'] }} ·
          {{ state.plottedIds.includes(item.id) ? '已标绘' : '未标绘' }}</small
        >
      </button>
      <button :aria-label="'定位 ' + item.title" @click="emit('locate', item.id)">⌖</button>
    </div>
    <p v-if="!state.items.length && !state.busy" class="empty-copy">当前条件没有情报记录。</p>
    <button v-if="state.cursor" :disabled="state.busy" @click="state.load(true)">
      加载更多情报
    </button>
  </section>
</template>
<style scoped>
.plotted-item {
  padding: 8px;
  border-bottom: 1px solid #1c4c60;
}
.plotted-item small {
  display: block;
  color: #8eaabc;
}
.intelligence-actions {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin: 10px 0;
}
.intelligence-actions button {
  font-size: 12px;
  padding: 6px 9px;
}
.intelligence-row {
  display: flex;
  align-items: start;
  gap: 7px;
  border-bottom: 1px solid #183e51;
  padding: 8px 0;
}
.intelligence-row.selected {
  border-left: 3px solid #5ad4df;
  padding-left: 6px;
}
.intelligence-row > input {
  margin-top: 14px;
}
.intelligence-row .fusion-event {
  flex: 1;
  min-width: 0;
  margin: 0;
}
.intelligence-row small {
  display: block;
}
</style>
