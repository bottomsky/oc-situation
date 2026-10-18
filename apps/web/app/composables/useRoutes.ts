import { computed, onScopeDispose, ref, watch } from 'vue';
import type {
  CreateRoute,
  Route,
  RouteCoordinate,
  RoutePlan,
  RouteRestrictionInput,
  UpdateRoute,
} from '@ais/contracts';
import { RouteSchema } from '@ais/contracts';
import { routePlanError } from '../utils/routeWorkspace';
export type RestrictionRecord = Omit<RouteRestrictionInput, 'operationId' | 'expectedRevision'> & {
  id: string;
  revision: number;
  version: number;
};
type RouteQuery = {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
  longitude?: number;
  latitude?: number;
  radiusMeters?: number;
};
export function useRoutes() {
  const { api, session } = usePlatform();
  const canWrite = computed(() => ['operator', 'admin'].includes(session.value?.user.role || ''));
  const items = ref<Route[]>([]),
    total = ref(0),
    selected = ref<Route | null>(null),
    history = ref<Route[]>([]);
  const candidate = ref<RoutePlan | null>(null),
    restrictions = ref<RestrictionRecord[]>([]);
  const loading = ref(false),
    busy = ref(false),
    error = ref('');
  let query: RouteQuery = { limit: 20, offset: 0 },
    listTurn = 0,
    detailTurn = 0,
    planTurn = 0,
    disposed = false;
  let reader: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const operations = new Map<string, string>();
  const identityKey = () => `${session.value?.user.id ?? ''}:${session.value?.user.role ?? ''}`;
  let writeGeneration = 0;
  const writeCurrent = (identity: number) => !disposed && identity === writeGeneration;
  function operation(key: string) {
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    return operations.get(key)!;
  }
  function report(e: unknown) {
    error.value =
      (e as { status?: number }).status === 409
        ? '版本已更新，请刷新详情后合并。当前草稿已保留，请勿覆盖。'
        : (e as Error).message;
  }
  async function load(input: RouteQuery = query) {
    query = { limit: 20, offset: 0, ...input };
    const turn = ++listTurn;
    loading.value = true;
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== '') params.set(k, String(v));
    });
    try {
      const result = await api<{ items: Route[]; total: number }>(`/routes?${params}`);
      if (!disposed && turn === listTurn) {
        items.value = result.items;
        total.value = result.total;
      }
    } catch (e) {
      if (turn === listTurn && !disposed) report(e);
    } finally {
      if (turn === listTurn && !disposed) loading.value = false;
    }
  }
  async function detail(id: string) {
    const turn = ++detailTurn;
    try {
      const [route, revisions] = await Promise.all([
        api<Route>(`/routes/${id}`),
        api<{ items: Route[] }>(`/routes/${id}/history`),
      ]);
      if (!disposed && turn === detailTurn) {
        selected.value = RouteSchema.parse(route);
        history.value = revisions.items;
      }
    } catch (e) {
      if (turn === detailTurn && !disposed) report(e);
    }
  }
  async function mutation<T>(
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PUT' = 'POST',
  ): Promise<T | null> {
    if (!canWrite.value) {
      error.value = '当前账号为只读权限。';
      return null;
    }
    if (busy.value || disposed) return null;
    const identity = writeGeneration;
    const key = `${method}:${path}:${JSON.stringify(body)}`;
    busy.value = true;
    error.value = '';
    try {
      const value = await api<T>(path, {
        method,
        body: { ...body, operationId: operation(key) },
        timeoutMs: 30000,
      });
      if (!writeCurrent(identity)) return null;
      operations.delete(key);
      return value;
    } catch (e) {
      if (writeCurrent(identity)) report(e);
      return null;
    } finally {
      if (writeCurrent(identity)) busy.value = false;
    }
  }
  async function save(
    input: Omit<CreateRoute, 'operationId'> | Omit<UpdateRoute, 'operationId'>,
    route?: Route,
  ) {
    const identity = writeGeneration;
    const saved = await mutation<Route>(
      route ? `/routes/${route.id}` : '/routes',
      { ...input, ...(route ? { expectedRevision: route.revision } : {}) },
      route ? 'PUT' : 'POST',
    );
    if (saved) {
      selected.value = saved;
      await load();
      if (!writeCurrent(identity)) return null;
      await detail(saved.id);
    }
    return saved;
  }
  async function copy(route: Route) {
    const identity = writeGeneration;
    const value = await mutation<Route>(`/routes/${route.id}/copy`, {
      expectedRevision: route.revision,
      name: `${route.name} · 副本`,
    });
    if (value) {
      await load();
      if (!writeCurrent(identity)) return null;
      await detail(value.id);
    }
    return value;
  }
  async function archive(route: Route) {
    const identity = writeGeneration;
    const value = await mutation<Route>(`/routes/${route.id}/archive`, {
      expectedRevision: route.revision,
    });
    if (value) {
      await load();
      if (!writeCurrent(identity)) return null;
      await detail(value.id);
    }
    return value;
  }
  function stopReading() {
    ++planTurn;
    reader?.abort();
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  async function readPlan(id: string, turn: number) {
    reader = new AbortController();
    try {
      const result = await api<RoutePlan>(`/routes/plans/${id}`, {
        signal: reader.signal,
        timeoutMs: 30000,
      });
      if (turn !== planTurn || disposed) return;
      candidate.value = result;
      if (result.status === 'failed') error.value = routePlanError(result.error);
      if (['queued', 'running'].includes(result.status))
        timer = setTimeout(() => {
          void readPlan(id, turn);
        }, 1000);
    } catch (e) {
      if (turn === planTurn && !disposed) report(e);
    }
  }
  async function plan(waypoints: RouteCoordinate[]) {
    stopReading();
    const turn = planTurn;
    candidate.value = null;
    const value = await mutation<RoutePlan>('/routes/plans', { waypoints });
    if (!value || disposed || turn !== planTurn) return;
    candidate.value = value;
    if (value.status === 'failed') error.value = routePlanError(value.error);
    if (['queued', 'running'].includes(value.status))
      timer = setTimeout(() => {
        void readPlan(value.id, turn);
      }, 1000);
  }
  async function cancelPlan() {
    const current = candidate.value;
    if (!current) return;
    stopReading();
    const value = await mutation<RoutePlan>(`/routes/plans/${current.id}/cancel`, {});
    if (value) candidate.value = value;
  }
  function clearPlan() {
    stopReading();
    candidate.value = null;
  }
  async function loadRestrictions() {
    const identity = writeGeneration;
    try {
      const values = (await api<{ items: RestrictionRecord[] }>('/routes/restrictions')).items;
      if (writeCurrent(identity)) restrictions.value = values;
    } catch (e) {
      if (writeCurrent(identity)) report(e);
    }
  }
  async function saveRestriction(input: Omit<RouteRestrictionInput, 'operationId'>, id?: string) {
    const value = await mutation<RestrictionRecord>(
      id ? `/routes/restrictions/${id}` : '/routes/restrictions',
      input,
      id ? 'PUT' : 'POST',
    );
    if (value) await loadRestrictions();
    return value;
  }
  async function importGeoJSON(name: string, geojson: unknown) {
    const identity = writeGeneration;
    const value = await mutation<Route>('/routes/import', { name, geojson });
    if (value) {
      await load();
      if (!writeCurrent(identity)) return null;
      await detail(value.id);
    }
    return value;
  }
  async function exportGeoJSON(route: Route) {
    try {
      return await api<unknown>(`/routes/${route.id}/export`);
    } catch (e) {
      report(e);
      return null;
    }
  }
  watch(
    identityKey,
    () => {
      ++writeGeneration;
      stopReading();
      ++listTurn;
      ++detailTurn;
      restrictions.value = [];
      history.value = [];
      items.value = [];
      selected.value = null;
      candidate.value = null;
      busy.value = false;
      loading.value = false;
      total.value = 0;
      error.value = '';
      operations.clear();
    },
    { flush: 'sync' },
  );
  onScopeDispose(() => {
    disposed = true;
    ++listTurn;
    ++detailTurn;
    stopReading();
  });
  return {
    canWrite,
    items,
    total,
    selected,
    history,
    candidate,
    restrictions,
    loading,
    busy,
    error,
    load,
    detail,
    save,
    copy,
    archive,
    plan,
    cancelPlan,
    clearPlan,
    loadRestrictions,
    saveRestriction,
    importGeoJSON,
    exportGeoJSON,
  };
}
