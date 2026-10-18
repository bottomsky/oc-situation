<script setup lang="ts">
import type {
  DynamicSkillArtifact,
  DynamicSkillExecution,
} from '../../../../packages/contracts/dynamic-skills';
import type { AgentHeatmapResult, AgentVesselTracksResult } from '@ais/contracts';
import { readSkillArtifacts } from '../utils/skillArtifacts';
import { dateLabel } from '../utils/display';
import { eventStatusLabels, eventSeverityLabels } from '../utils/operationalEvents';
import { routePlanError } from '../utils/routeWorkspace';
const props = defineProps<{
  execution?: DynamicSkillExecution;
  artifacts: DynamicSkillArtifact[];
  inputRevision: number;
}>();
const emit = defineEmits<{
  heatmap: [result: AgentHeatmapResult];
  tracks: [result: AgentVesselTracksResult];
}>();
const cards = computed(() => readSkillArtifacts(props.artifacts, props.inputRevision));
const labels: Record<string, string> = {
  vessel_list: '船舶清单',
  vessel_detail: '船舶详情',
  vessel_tracks: '历史航线',
  ais_heatmap: 'AIS 热力图',
  intelligence_search: '情报检索',
  analysis: '分析结果',
  route: '计划航线',
  route_plan: '航路规划候选',
  operational_event: '业务事件',
  operational_events: '业务事件清单',
  map_focus: '空间关注',
};
const routeStates = { draft: '草稿', active: '启用', archived: '已归档' };
const planStates = {
  queued: '排队中',
  running: '规划中',
  completed: '候选已生成',
  failed: '规划失败',
  cancelled: '已取消',
};
const focusStates = { complete: '完整展示', partial: '部分展示', unlocated: '未定位' };
</script>
<template>
  <section
    v-if="execution?.taskBinding || execution?.createdVersions.length"
    class="skill-task-record"
    aria-label="任务技能版本"
  >
    <h4>技能版本</h4>
    <div
      v-for="item in execution.createdVersions"
      :key="'created:' + item.binding.skillId + ':' + item.binding.version"
      class="skill-task-version"
    >
      <span class="badge">本次创建</span
      ><NuxtLink
        :to="{
          path: '/skills',
          query: { id: item.binding.skillId, version: item.binding.version },
        }"
        >{{ item.definition.name }} · {{ item.binding.version }}</NuxtLink
      >
      <small>{{ dateLabel(item.createdAt) }}</small
      ><code>{{ item.binding.contentHash }}</code>
    </div>
    <div v-if="execution.taskBinding" class="skill-task-version">
      <span class="badge">本次使用</span
      ><NuxtLink
        :to="{
          path: '/skills',
          query: {
            id: execution.taskBinding.binding.skillId,
            version: execution.taskBinding.binding.version,
          },
        }"
        >{{ execution.version?.definition.name || execution.taskBinding.binding.skillId }} ·
        {{ execution.taskBinding.binding.version }}</NuxtLink
      >
      <small>输入修订 {{ execution.taskBinding.inputRevision }}</small
      ><code>{{ execution.taskBinding.binding.contentHash }}</code>
    </div>
  </section>
  <section v-if="cards.length" class="skill-task-artifacts" aria-label="技能多步骤产物">
    <h4>步骤产物 · {{ cards.length }} 项（本轮修订快照）</h4>
    <article
      v-for="item in cards"
      :key="item.id"
      class="skill-artifact-card"
      :data-artifact-id="item.id"
    >
      <div class="skill-artifact-heading">
        <strong>{{ labels[item.kind] || item.kind }}</strong
        ><small>步骤 {{ item.stepId }}</small>
      </div>
      <template v-if="item.result?.kind === 'vessel_list' || item.result?.kind === 'vessel_detail'">
        <p>共 {{ item.result.total }} 艘<span v-if="item.result.truncated"> · 已截断</span></p>
        <p v-for="vessel in item.result.items" :key="vessel.mmsi">
          {{ vessel.name || '未命名船舶' }} · MMSI {{ vessel.mmsi }}
        </p>
        <p v-if="!item.result.items.length">此步骤没有匹配船舶。</p>
      </template>
      <template v-else-if="item.result?.kind === 'vessel_tracks'">
        <p>
          {{ item.result.returnedVessels }} 艘 ·
          {{ item.result.tracks.reduce((sum, track) => sum + track.returned, 0) }} 个轨迹点
        </p>
        <p>{{ dateLabel(item.result.query.from) }} ～ {{ dateLabel(item.result.query.to) }}</p>
        <button @click="emit('tracks', item.result)">在海图展示此航线快照</button>
      </template>
      <template v-else-if="item.result?.kind === 'ais_heatmap'">
        <p>{{ item.result.totalVessels }} 艘去重船舶 · {{ item.result.cells.length }} 个非空网格</p>
        <p>{{ dateLabel(item.result.query.from) }} ～ {{ dateLabel(item.result.query.to) }}</p>
        <button @click="emit('heatmap', item.result)">在海图展示此热力快照</button>
      </template>
      <template v-else-if="item.result?.kind === 'route'">
        <p>
          共 {{ item.result.total }} 条<span v-if="item.result.truncated">
            · 已截断，展示 {{ item.result.routes.length }} 条</span
          >
        </p>
        <div v-for="route in item.result.routes" :key="route.id" class="business-snapshot">
          <strong>{{ route.name }}</strong>
          <p>
            {{ routeStates[route.status] }} · 修订 {{ route.revision }} ·
            {{ (route.lengthMeters / 1852).toFixed(1) }} 海里 · {{ route.waypoints.length }} 航点
          </p>
          <NuxtLink :to="{ path: '/routes', query: { id: route.id } }">查看当前航线</NuxtLink>
          <NuxtLink :to="{ path: '/', query: { routeId: route.id } }">在海图查看当前对象</NuxtLink>
        </div>
        <p v-if="!item.result.routes.length">当前条件下没有匹配航线。</p>
      </template>
      <template v-else-if="item.result?.kind === 'route_plan'">
        <p>规划候选 · {{ planStates[item.result.plan.status] }}</p>
        <p>
          路网版本 {{ item.result.plan.datasetVersion ?? '待确定' }} · 禁区版本
          {{ item.result.plan.restrictionVersion
          }}<span v-if="item.result.plan.stale"> · 数据版本已更新</span>
        </p>
        <p v-if="item.result.plan.result">
          候选里程 {{ (item.result.plan.result.lengthMeters / 1852).toFixed(1) }} 海里
        </p>
        <p v-if="item.result.plan.error" role="status">
          {{ routePlanError(item.result.plan.error) }}
        </p>
        <p>候选经工作台保存后形成正式计划航线。</p>
        <NuxtLink to="/routes">进入航线工作台</NuxtLink>
      </template>
      <template
        v-else-if="
          item.result?.kind === 'operational_event' || item.result?.kind === 'operational_events'
        "
      >
        <p v-if="item.result.kind === 'operational_events'">
          共 {{ item.result.total }} 条<span v-if="item.result.truncated">
            · 已截断，展示 {{ item.result.items.length }} 条</span
          >
        </p>
        <div
          v-for="event in item.result.kind === 'operational_event'
            ? [item.result.event]
            : item.result.items"
          :key="event.id"
          class="business-snapshot"
        >
          <strong>{{ event.title }}</strong>
          <p>
            {{ eventStatusLabels[event.status] }} · {{ eventSeverityLabels[event.severity] }} · 修订
            {{ event.revision }}
          </p>
          <p>{{ event.summary || '暂无摘要' }}</p>
          <p>
            {{ event.occurredAt ? dateLabel(event.occurredAt) : '发生时间待确认' }} ·
            {{ event.geometry ? '已定位' : '未定位' }}
          </p>
          <NuxtLink :to="{ path: '/events', query: { id: event.id } }">查看当前事件与来源</NuxtLink>
          <NuxtLink
            v-if="event.geometry"
            :to="{ path: '/', query: { operationalEventId: event.id } }"
            >海图定位</NuxtLink
          >
        </div>
        <p v-if="item.result.kind === 'operational_events' && !item.result.items.length">
          当前条件下没有匹配事件。
        </p>
      </template>
      <template v-else-if="item.result?.kind === 'map_focus'">
        <p>
          {{ focusStates[item.result.displayStatus] }} · {{ item.result.targets.length }} 个关注对象
          · {{ item.result.missing.length }} 个未定位<span v-if="item.result.omittedCount">
            · {{ item.result.omittedCount }} 个超出展示上限</span
          >
        </p>
      </template>
      <p v-else>此产物已记录，当前页面暂无有效的快照预览。</p>
    </article>
  </section>
</template>
<style scoped>
.skill-task-record,
.skill-task-artifacts {
  display: grid;
  gap: 10px;
  margin-block: 14px;
}
.skill-task-version,
.skill-artifact-card {
  display: grid;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 5px;
  background: rgb(36 204 242 / 4%);
}
.skill-task-version a {
  color: var(--teal);
  overflow-wrap: anywhere;
}
.skill-task-version code {
  font-size: 10px;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.skill-task-version small,
.skill-artifact-heading small {
  color: var(--muted);
  font-size: 11px;
}
.skill-task-version .badge {
  justify-self: start;
}
.skill-artifact-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.skill-artifact-card p {
  font-size: 12px;
  line-height: 1.7;
}
.skill-artifact-card button {
  justify-self: start;
  font-size: 12px;
}
.business-snapshot {
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.skill-artifact-card a {
  color: var(--teal);
  font-size: 12px;
  margin-right: 12px;
}
</style>
