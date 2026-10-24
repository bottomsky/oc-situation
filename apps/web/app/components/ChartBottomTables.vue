<script setup lang="ts">
import type { AnalysisResult, MapPoint } from '@ais/contracts';
import { dateLabel } from '../utils/display';
import { vesselTablePage } from '../utils/chartWorkspace';
const props = defineProps<{
  rows: (MapPoint & { name: string })[];
  total: number;
  clustered: boolean;
  truncated: boolean;
  items: AnalysisResult[];
  collapsed: boolean;
  selectedId?: string;
}>();
const page = ref(0);
const pageCount = computed(() => Math.max(1, Math.ceil(props.rows.length / 100)));
const pageRows = computed(() => vesselTablePage(props.rows, page.value));
watch(
  () => props.rows,
  () => {
    page.value = Math.min(page.value, pageCount.value - 1);
  },
);
const emit = defineEmits<{
  selectVessel: [mmsi: string];
  selectResult: [result: AnalysisResult];
  toggle: [];
}>();
</script>
<template>
  <section
    class="chart-bottom"
    :class="{ collapsed }"
    aria-label="海图数据列表"
    data-testid="chart-bottom-tables"
  >
    <header class="chart-bottom-heading">
      <strong>视野观测与专题结论</strong
      ><button :aria-expanded="!collapsed" @click="emit('toggle')">
        {{ collapsed ? '展开列表' : '折叠列表' }}
        <ChartIcon :name="collapsed ? 'ChevronDown' : 'Minus'" />
      </button>
    </header>
    <div v-if="!collapsed" class="chart-bottom-grid">
      <section class="chart-panel">
        <div class="section-heading">
          <h2>
            视野船舶 <small>{{ rows.length }} 单船 / {{ total.toLocaleString() }} 艘</small>
          </h2>
          <nav aria-label="船舶表格分页">
            <button :disabled="page === 0" @click="page--">上一页</button
            ><span>{{ page + 1 }} / {{ pageCount }}</span
            ><button :disabled="page >= pageCount - 1" @click="page++">下一页</button>
          </nav>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>船名 / MMSI</th>
                <th>航速 kn</th>
                <th>对地航向</th>
                <th>观测时间 UTC</th>
                <th>来源</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in pageRows" :key="row.mmsi">
                <td>
                  {{ row.name || '船名待补充' }}<small class="mono">{{ row.mmsi }}</small>
                  <span v-if="row.quality.includes('synthetic')" class="badge sample"
                    >样例数据</span
                  >
                </td>
                <td>{{ row.sogKnots ?? '—' }}</td>
                <td>{{ row.cogDegrees === null ? '—' : row.cogDegrees + '°' }}</td>
                <td>{{ dateLabel(row.observedAt) }}</td>
                <td>{{ row.sourceId }}</td>
                <td>
                  <button
                    :aria-label="'查看船舶 ' + row.mmsi"
                    @click="emit('selectVessel', row.mmsi)"
                  >
                    <ChartIcon name="ArrowRight" />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!rows.length" class="empty-copy">
            {{ clustered ? '聚合视图，放大至单船级查看' : '当前视野没有单船观测' }}
          </p>
          <p v-if="truncated" class="chart-caution">显示已达 5,000 元素上限，请放大视窗。</p>
        </div>
      </section>
      <section class="chart-panel">
        <div class="section-heading">
          <h2>
            专题结论 <small>{{ items.length }} 条 · 最近 30 条</small>
          </h2>
          <NuxtLink to="/topics">全部专题 →</NuxtLink>
        </div>
        <div class="table-scroll">
          <table>
            <thead>
              <tr>
                <th>专题结论</th>
                <th>状态 / 修订</th>
                <th>更新时间 UTC</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="item in items"
                :key="item.id"
                :class="{ selected: selectedId === item.id }"
              >
                <td>
                  {{ item.title }}<small class="mono">{{ item.mmsi }}</small>
                </td>
                <td>
                  {{
                    item.status === 'withdrawn'
                      ? '已撤回'
                      : item.status === 'revised'
                        ? '已修订'
                        : '有效'
                  }}
                  · {{ item.revision }}
                </td>
                <td>{{ dateLabel(item.updatedAt) }}</td>
                <td>
                  <button
                    :aria-label="'查看结论 ' + item.title"
                    :aria-pressed="selectedId === item.id"
                    @click="emit('selectResult', item)"
                  >
                    证据
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="!items.length" class="empty-copy">暂无专题结论</p>
        </div>
      </section>
    </div>
  </section>
</template>
