import type {
  AgentAccountMemoryEntry,
  AgentMemorySettings,
} from '../../../../packages/contracts/agent-memory';

// UI renders JSON through a formatter; it does not recursively react to memory payloads.
export type AgentMemoryEntryView = Omit<AgentAccountMemoryEntry, 'value'> & { value: unknown };
interface AgentMemoryCatalogView {
  revision: number;
  entries: AgentMemoryEntryView[];
}

export interface AgentSessionMemoryView {
  sessionId: string;
  revision: number;
  turnSeq: number;
  generation: number;
  summary: string;
  conditions: Record<string, unknown>;
  objectSets: {
    id: string;
    label: string;
    kind: string;
    memberCount: number;
    turnSeq: number;
    source: { taskId?: string; messageId?: string; description?: string };
  }[];
  references: { refType: string; refId: string; label?: string }[];
  updatedAt: string;
  appliedAccountMemories: AgentMemoryEntryView[];
  appliedTaskId: string | null;
  features: { session: boolean; account: boolean; proposals: boolean };
}
export interface AgentMemoryPreferences extends AgentMemorySettings {
  features: { session: boolean; account: boolean; proposals: boolean };
}
export function explainMemoryConditions(conditions: Record<string, unknown>) {
  const labels: Record<string, string> = {
    intent: '任务类型',
    selection: '查询条件',
    historyHours: '回溯时长',
    from: '起始时间',
    to: '结束时间',
    mmsi: '船舶 MMSI',
    vesselClass: '船舶类型',
    region: '海域',
    bbox: '海域范围',
  };
  const intents: Record<string, string> = {
    vessel_list: '船舶查询',
    vessel_detail: '船舶详情',
    vessel_tracks: '历史航线',
    ais_heatmap: 'AIS 热力图',
    intelligence_search: '情报检索',
    focus: '海图定位',
    analysis: '区域研判',
    skill: '技能执行',
  };
  const region = (value: unknown): string => {
    if (Array.isArray(value) && value.length === 4)
      return `经度 ${value[0]}° 至 ${value[2]}°，纬度 ${value[1]}° 至 ${value[3]}°`;
    if (!value || typeof value !== 'object') return String(value ?? '');
    const selection = value as Record<string, unknown>;
    if (selection.kind === 'circle' && Array.isArray(selection.center))
      return `圆形海域 · 中心经度 ${selection.center[0]}°，纬度 ${selection.center[1]}° · 半径 ${selection.radiusNm ?? '—'} 海里`;
    if (selection.bbox) return region(selection.bbox);
    if (selection.label) return String(selection.label);
    if (selection.kind === 'polygon') return '圈选多边形海域';
    return '已按本轮确认的空间条件查询';
  };
  return Object.entries(conditions)
    .filter(([key]) => key in labels)
    .map(([key, value]) => ({
      label: labels[key]!,
      value:
        key === 'intent'
          ? (intents[String(value)] ?? '综合研判')
          : key === 'historyHours'
            ? `${value} 小时`
            : ['selection', 'bbox', 'region'].includes(key)
              ? region(value)
              : ['from', 'to'].includes(key) && typeof value === 'string'
                ? `${new Date(value).toLocaleString('zh-CN', { timeZone: 'UTC', hour12: false })} UTC`
                : String(value ?? ''),
    }));
}
export function useAgentMemories() {
  const { api, session } = usePlatform();
  const catalog = ref<AgentMemoryCatalogView>({ revision: 0, entries: [] });
  const settings = ref<AgentMemoryPreferences | null>(null);
  const sessionMemory = ref<AgentSessionMemoryView | null>(null);
  const busy = ref(false);
  const sessionBusy = ref(false);
  const error = ref('');
  const sessionError = ref('');
  const notice = ref('');
  const canManage = computed(() => !!session.value?.user.id);
  let generation = 0;
  let loading = 0;
  let selecting = 0;
  let selectedSession = '';
  const operations = new Map<string, string>();
  watch(
    () => session.value?.user.id,
    () => {
      generation++;
      loading++;
      selecting++;
      selectedSession = '';
      catalog.value = { revision: 0, entries: [] };
      settings.value = null;
      sessionMemory.value = null;
      busy.value = false;
      sessionBusy.value = false;
      error.value = '';
      sessionError.value = '';
      notice.value = '';
      operations.clear();
    },
    { flush: 'sync' },
  );
  async function load() {
    const turn = generation;
    const ticket = ++loading;
    busy.value = true;
    error.value = '';
    try {
      const [entries, prefs] = await Promise.all([
        api<AgentMemoryCatalogView>('/agent/memories'),
        api<AgentMemoryPreferences>('/agent/memories/settings'),
      ]);
      if (turn !== generation || ticket !== loading) return;
      catalog.value = entries;
      settings.value = prefs;
    } catch (failure) {
      if (turn === generation && ticket === loading) error.value = (failure as Error).message;
    } finally {
      if (turn === generation && ticket === loading) busy.value = false;
    }
  }
  async function loadSession(id: string) {
    const turn = generation;
    const ticket = ++selecting;
    selectedSession = id;
    sessionMemory.value = null;
    sessionError.value = '';
    if (!id) {
      sessionBusy.value = false;
      return;
    }
    sessionBusy.value = true;
    try {
      const result = await api<AgentSessionMemoryView>(
        `/agent/sessions/${encodeURIComponent(id)}/memory`,
      );
      if (turn === generation && ticket === selecting) sessionMemory.value = result;
    } catch (failure) {
      if (turn === generation && ticket === selecting)
        sessionError.value = (failure as Error).message;
    } finally {
      if (turn === generation && ticket === selecting) sessionBusy.value = false;
    }
  }
  async function mutate(
    path: string,
    method: 'POST' | 'PUT' | 'DELETE',
    payload: Record<string, unknown>,
    revision: number,
  ) {
    if (!canManage.value || busy.value) return false;
    const turn = generation;
    const body = { ...payload, expectedRevision: revision };
    const fingerprint = JSON.stringify({ path, method, body });
    const operationId = operations.get(fingerprint) ?? crypto.randomUUID();
    operations.set(fingerprint, operationId);
    busy.value = true;
    error.value = '';
    notice.value = '';
    try {
      await api(path, { method, body: { ...body, operationId } });
      if (turn !== generation) return false;
      operations.delete(fingerprint);
      await load();
      if (turn !== generation) return false;
      notice.value = '个人记忆已更新';
      return true;
    } catch (failure) {
      if (turn === generation)
        error.value =
          (failure as { status?: number }).status === 409
            ? '记忆已在其他窗口更新，请刷新后核对内容再操作。当前输入已保留。'
            : (failure as Error).message;
      return false;
    } finally {
      if (turn === generation) busy.value = false;
    }
  }
  const save = (value: { category: string; key: string; value: unknown }, id?: string) =>
    mutate(
      `/agent/memories${id ? `/${encodeURIComponent(id)}` : ''}`,
      id ? 'PUT' : 'POST',
      value,
      catalog.value.revision,
    );
  const act = (id: string, action: 'confirm' | 'dismiss' | 'delete') =>
    mutate(
      `/agent/memories/${encodeURIComponent(id)}${action === 'delete' ? '' : `/${action}`}`,
      action === 'delete' ? 'DELETE' : 'POST',
      {},
      catalog.value.revision,
    );
  const clear = () => mutate('/agent/memories', 'DELETE', {}, catalog.value.revision);
  const updateSettings = (readEnabled: boolean, proposalsEnabled: boolean) =>
    settings.value
      ? mutate(
          '/agent/memories/settings',
          'PUT',
          { readEnabled, proposalsEnabled },
          settings.value.revision,
        )
      : Promise.resolve(false);
  async function resetSession() {
    const id = selectedSession;
    if (!sessionMemory.value || sessionBusy.value) return false;
    const result = await mutate(
      `/agent/sessions/${encodeURIComponent(id)}/memory`,
      'DELETE',
      {},
      sessionMemory.value.revision,
    );
    if (result && selectedSession === id) await loadSession(id);
    return result;
  }
  return {
    catalog,
    settings,
    sessionMemory,
    busy,
    sessionBusy,
    error,
    sessionError,
    notice,
    canManage,
    load,
    loadSession,
    save,
    act,
    clear,
    updateSettings,
    resetSession,
  };
}
