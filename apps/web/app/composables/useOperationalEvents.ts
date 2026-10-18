import { computed, ref, onScopeDispose, watch } from 'vue';
import {
  OperationalEventSchema,
  type OperationalEvent,
  type OperationalEventQuery,
  type OperationalEventSource,
} from '@ais/contracts';
export function useOperationalEvents() {
  const { api, session } = usePlatform();
  const canWrite = computed(() => ['operator', 'admin'].includes(session.value?.user.role ?? ''));
  const isAdmin = computed(() => session.value?.user.role === 'admin');
  const items = ref<OperationalEvent[]>([]),
    total = ref(0),
    selected = ref<OperationalEvent | null>(null);
  const history = ref<OperationalEvent[]>([]),
    sources = ref<OperationalEventSource[]>([]),
    sourceHistory = ref<OperationalEventSource[]>([]);
  const error = ref(''),
    busy = ref(false),
    loading = ref(false),
    updated = ref(false);
  let listTurn = 0,
    detailTurn = 0,
    sourceTurn = 0,
    disposed = false;
  let query: Partial<OperationalEventQuery> = { limit: 20, offset: 0 };
  const operations = new Map<string, string>();
  const identityKey = () => `${session.value?.user.id ?? ''}:${session.value?.user.role ?? ''}`;
  let writeGeneration = 0;
  const writeCurrent = (identity: number) => !disposed && identity === writeGeneration;
  function report(e: unknown) {
    error.value =
      (e as { status?: number }).status === 409
        ? '版本已更新，请刷新详情后合并；当前草稿已保留。'
        : (e as Error).message;
  }
  async function load(input = query) {
    query = { limit: 20, offset: 0, ...input };
    const turn = ++listTurn;
    loading.value = true;
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== '')
        params.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    try {
      const result = await api<{ items: unknown[]; total: number }>(
        `/operational-events?${params}`,
      );
      if (!disposed && turn === listTurn) {
        items.value = result.items.map((v) => OperationalEventSchema.parse(v));
        total.value = result.total;
      }
    } catch (e) {
      if (!disposed && turn === listTurn) report(e);
    } finally {
      if (!disposed && turn === listTurn) loading.value = false;
    }
  }
  async function detail(id: string) {
    const turn = ++detailTurn;
    ++sourceTurn;
    sourceHistory.value = [];
    updated.value = false;
    try {
      const [value, revisions, evidence] = await Promise.all([
        api<unknown>(`/operational-events/${id}`),
        api<{ items: OperationalEvent[] }>(`/operational-events/${id}/history`),
        api<{ items: OperationalEventSource[] }>(`/operational-events/${id}/sources`),
      ]);
      if (disposed || turn !== detailTurn) return null;
      selected.value = OperationalEventSchema.parse(value);
      history.value = revisions.items;
      sources.value = evidence.items;
      return selected.value;
    } catch (e) {
      if (!disposed && turn === detailTurn) report(e);
      return null;
    }
  }
  function clear() {
    ++detailTurn;
    ++sourceTurn;
    selected.value = null;
    history.value = [];
    sources.value = [];
    sourceHistory.value = [];
    updated.value = false;
  }
  async function readSource(key: string) {
    const current = selected.value,
      turn = ++sourceTurn;
    sourceHistory.value = [];
    if (!current) return;
    try {
      const result = await api<{ items: OperationalEventSource[] }>(
        `/operational-events/${current.id}/source-history?key=${encodeURIComponent(key)}`,
      );
      if (!disposed && turn === sourceTurn && selected.value?.id === current.id)
        sourceHistory.value = result.items;
    } catch (e) {
      if (!disposed && turn === sourceTurn) report(e);
    }
  }
  async function mutate(
    path: string,
    body: Record<string, unknown>,
    method: 'POST' | 'PATCH' = 'PATCH',
  ): Promise<OperationalEvent | null> {
    if (!canWrite.value || busy.value || disposed) return null;
    const identity = writeGeneration;
    const key = `${method}:${path}:${JSON.stringify(body)}`;
    if (!operations.has(key)) operations.set(key, crypto.randomUUID());
    busy.value = true;
    error.value = '';
    try {
      const value = OperationalEventSchema.parse(
        await api(path, {
          method,
          body: { ...body, operationId: operations.get(key) },
          timeoutMs: 30000,
        }),
      );
      if (!writeCurrent(identity)) return null;
      operations.delete(key);
      await load();
      if (!writeCurrent(identity)) return null;
      return value;
    } catch (e) {
      if (writeCurrent(identity)) report(e);
      return null;
    } finally {
      if (writeCurrent(identity)) busy.value = false;
    }
  }
  async function backfill() {
    if (!isAdmin.value || busy.value) return;
    const identity = writeGeneration;
    busy.value = true;
    error.value = '';
    try {
      await api('/operational-events/backfill', { method: 'POST' });
      if (!writeCurrent(identity)) return;
      await load();
    } catch (e) {
      if (writeCurrent(identity)) report(e);
    } finally {
      if (writeCurrent(identity)) busy.value = false;
    }
  }
  async function poll() {
    if (disposed || (typeof document !== 'undefined' && document.visibilityState !== 'visible'))
      return;
    await load();
    const current = selected.value,
      turn = detailTurn;
    if (!current) return;
    try {
      const latest = OperationalEventSchema.parse(await api(`/operational-events/${current.id}`));
      if (
        !disposed &&
        turn === detailTurn &&
        selected.value?.id === current.id &&
        latest.revision !== current.revision
      )
        updated.value = true;
    } catch {
      /* Preserve the current revision and draft during a background read failure. */
    }
  }
  const timer = setInterval(() => {
    void poll();
  }, 30000);
  watch(
    identityKey,
    () => {
      ++writeGeneration;
      ++listTurn;
      clear();
      items.value = [];
      total.value = 0;
      busy.value = false;
      loading.value = false;
      error.value = '';
      operations.clear();
    },
    { flush: 'sync' },
  );
  onScopeDispose(() => {
    disposed = true;
    ++listTurn;
    clear();
    clearInterval(timer);
  });
  return {
    items,
    total,
    selected,
    history,
    sources,
    sourceHistory,
    error,
    busy,
    loading,
    updated,
    canWrite,
    isAdmin,
    load,
    detail,
    clear,
    readSource,
    mutate,
    backfill,
    poll,
  };
}
