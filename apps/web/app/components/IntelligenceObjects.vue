<script setup lang="ts">
import { objectLabels } from '../utils/intelligenceLabels';
import type { IntelligenceGeoObject } from '@ais/contracts';
import { GeoObjectInputSchema, GeoObjectImportSchema } from '@ais/contracts';
const { api, session } = usePlatform();
const items = ref<IntelligenceGeoObject[]>([]);
const error = ref('');
const busy = ref(false);
const keyword = ref('');
const importText = ref('');
const editing = ref('');
const form = reactive({ kind: 'port', name: '', aliases: '', geometry: '', mmsi: '' });
const canManage = computed(() => session.value?.user.role !== 'viewer');
async function load() {
  busy.value = true;
  error.value = '';
  try {
    const response = await api<IntelligenceGeoObject[] | { items: IntelligenceGeoObject[] }>(
      '/intelligence/objects?keyword=' + encodeURIComponent(keyword.value),
    );
    items.value = Array.isArray(response) ? response : response.items;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
function edit(o: IntelligenceGeoObject) {
  editing.value = o.id;
  Object.assign(form, {
    kind: o.kind,
    name: o.name,
    aliases: o.aliases.join('、'),
    geometry: o.geometry ? JSON.stringify(o.geometry, null, 2) : '',
    mmsi: o.mmsi || '',
  });
}
async function save() {
  error.value = '';
  try {
    const body = GeoObjectInputSchema.parse({
      kind: form.kind,
      name: form.name,
      aliases: form.aliases
        .split(/[、,\n]/)
        .map((s) => s.trim())
        .filter(Boolean),
      ...(form.geometry ? { geometry: JSON.parse(form.geometry) } : {}),
      ...(form.kind === 'vessel' ? { mmsi: form.mmsi } : {}),
      metadata: {},
    });
    await api(
      '/intelligence/objects' + (editing.value ? '/' + encodeURIComponent(editing.value) : ''),
      { method: editing.value ? 'PUT' : 'POST', body },
    );
    editing.value = '';
    form.name = '';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
async function importObjects() {
  error.value = '';
  try {
    await api('/intelligence/objects/import', {
      method: 'POST',
      body: GeoObjectImportSchema.parse(JSON.parse(importText.value)),
    });
    importText.value = '';
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(() => void load());
</script>
<template>
  <details class="panel">
    <summary>地理对象目录（{{ items.length }}）</summary>
    <FetchState :busy="busy" :error="error" @retry="load" />
    <form class="search-row" @submit.prevent="load">
      <input v-model="keyword" placeholder="对象名称 / 别名" aria-label="对象搜索" /><button>
        搜索对象
      </button>
    </form>
    <div class="object-directory">
      <article v-for="o in items" :key="o.id" class="topic-instance">
        <strong>{{ o.name }}</strong>
        <p class="detail-time">
          {{ objectLabels[o.kind] }} · {{ o.id }} · {{ o.geometry?.type || '无固定几何' }}
          {{ o.mmsi || '' }}
        </p>
        <button v-if="canManage" @click="edit(o)">维护对象</button
        ><NuxtLink :to="'/?objectId=' + encodeURIComponent(o.id)">查看相关情报</NuxtLink>
      </article>
    </div>
    <form v-if="canManage" class="editor-grid" @submit.prevent="save">
      <h3 class="wide">{{ editing ? '维护对象' : '新增对象' }}</h3>
      <label>名称<input v-model="form.name" required /></label
      ><label
        >类型<select v-model="form.kind">
          <option value="port">港口</option>
          <option value="channel">航道</option>
          <option value="area">海域</option>
          <option value="facility">设施</option>
          <option value="vessel">船舶</option>
        </select></label
      ><label>别名（顿号分隔）<input v-model="form.aliases" /></label
      ><label v-if="form.kind === 'vessel'"
        >MMSI<input v-model="form.mmsi" required pattern="[1-9][0-9]{8}" /></label
      ><label class="wide">GeoJSON 几何<textarea v-model="form.geometry" rows="4" /></label>
      <div class="wide">
        <button>保存对象</button
        ><button
          type="button"
          @click="
            editing = '';
            form.name = '';
          "
        >
          取消维护
        </button>
      </div>
    </form>
    <form v-if="canManage" @submit.prevent="importObjects">
      <label
        >批量导入对象 GeoJSON<textarea
          v-model="importText"
          rows="5"
          required
          placeholder="FeatureCollection，properties 包含 kind、name、aliases"
        /></label
      ><button>导入对象目录</button>
    </form>
  </details>
</template>
<style scoped>
.object-directory {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.object-directory a {
  margin-left: 12px;
  color: #78d5e4;
}
</style>
