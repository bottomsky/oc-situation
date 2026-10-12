import type { TopicInstance, TopicRun } from '@ais/contracts';
import { canOperate } from '../utils/display';
import { createRequestGeneration } from '../utils/chartWorkspace';
export function useChartTasks() {
  const { api, session } = usePlatform();
  const { analysisVersion } = useFusionEvents();
  const instances = ref<TopicInstance[]>([]);
  const selectedId = ref('');
  const runs = ref<TopicRun[]>([]);
  const error = ref('');
  const runsError = ref('');
  const busy = ref(false);
  const runsBusy = ref(false);
  const submitting = ref(false);
  const loadedId = ref('');
  const requests = createRequestGeneration();
  const listRequests = createRequestGeneration();
  let disposed = false;
  let loadQueued = false;
  let selectionGeneration = 0;
  const selected = computed(() =>
    instances.value.find((instance) => instance.id === selectedId.value),
  );
  const pending = computed(() =>
    runs.value.some((run) => run.status === 'queued' || run.status === 'running'),
  );
  const canRun = computed(
    () =>
      canOperate(session.value?.user.role) &&
      selected.value?.enabled &&
      loadedId.value === selectedId.value &&
      !pending.value &&
      !submitting.value &&
      !runsBusy.value,
  );
  async function load() {
    if (disposed) return;
    if (busy.value) {
      loadQueued = true;
      return;
    }
    const current = listRequests.next();
    busy.value = true;
    error.value = '';
    try {
      const response = await api<{ instances: TopicInstance[] }>('/topics');
      if (listRequests.isCurrent(current) && !disposed) instances.value = response.instances;
    } catch (e) {
      if (listRequests.isCurrent(current) && !disposed) error.value = (e as Error).message;
    } finally {
      busy.value = false;
      if (loadQueued && !disposed) {
        loadQueued = false;
        void load();
      }
    }
  }
  async function loadRuns() {
    if (!selectedId.value || disposed) return;
    const id = selectedId.value;
    const current = requests.next();
    loadedId.value = '';
    runsError.value = '';
    runsBusy.value = true;
    try {
      const response = await api<{ items: TopicRun[] }>(
        '/topics/instances/' + encodeURIComponent(id) + '/runs',
      );
      if (requests.isCurrent(current)) {
        runs.value = response.items;
        loadedId.value = id;
      }
    } catch (e) {
      if (requests.isCurrent(current)) {
        loadedId.value = '';
        runsError.value = (e as Error).message;
      }
    } finally {
      if (requests.isCurrent(current)) runsBusy.value = false;
    }
  }
  async function run() {
    if (!canRun.value || !selected.value) return;
    const id = selected.value.id;
    const generation = selectionGeneration;
    submitting.value = true;
    error.value = '';
    try {
      const result = await api<TopicRun>('/topics/instances/' + encodeURIComponent(id) + '/run', {
        method: 'POST',
        body: {},
        idempotent: true,
      });
      if (!disposed && selectionGeneration === generation && selectedId.value === id)
        runs.value = [result, ...runs.value.filter((item) => item.id !== result.id)];
      await load();
      if (!disposed && selectionGeneration === generation && selectedId.value === id)
        await loadRuns();
    } catch (e) {
      if (!disposed && selectionGeneration === generation) {
        loadedId.value = '';
        runsError.value = '提交结果未确认，请刷新运行状态后重试。' + (e as Error).message;
      }
    } finally {
      submitting.value = false;
    }
  }
  watch(selectedId, () => {
    selectionGeneration++;
    requests.next();
    runs.value = [];
    loadedId.value = '';
    error.value = '';
    runsError.value = '';
    void loadRuns();
  });
  watch(analysisVersion, () => {
    void load();
    if (selectedId.value) void loadRuns();
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    void load();
    timer = setInterval(() => {
      if (selectedId.value) {
        void load();
        if (!runsBusy.value) void loadRuns();
      }
    }, 5000);
  });
  onBeforeUnmount(() => {
    disposed = true;
    selectionGeneration++;
    clearInterval(timer);
    requests.next();
    listRequests.next();
  });

  return {
    instances,
    selectedId,
    runs,
    error,
    runsError,
    busy,
    runsBusy,
    submitting,
    loadedId,
    selected,
    pending,
    canRun,
    load,
    loadRuns,
    run,
  };
}
