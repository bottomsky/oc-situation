<script setup lang="ts">
import type {
  DynamicSkillArtifact,
  DynamicSkillExecution,
} from '../../../../packages/contracts/dynamic-skills';
import type { AgentHeatmapResult, AgentVesselTracksResult } from '@ais/contracts';
import { readSkillArtifacts } from '../utils/skillArtifacts';
import { dateLabel } from '../utils/display';
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
};
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
    <h4>步骤产物 · {{ cards.length }} 项</h4>
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
      <p v-else>此产物已记录，当前页面暂无对应的快照预览。</p>
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
</style>
