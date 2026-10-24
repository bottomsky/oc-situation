import type { ReachabilityResult, NavigationWarningImpact } from '@ais/contracts';
import { shallowRef } from 'vue';
import {
  predictionInputObservation,
  type PredictionObservationEvidence,
} from '../utils/predictionObservation';
export interface PredictionRecord {
  id: string;
  prediction: ReachabilityResult;
  impacts: (NavigationWarningImpact & {
    geometry?: GeoJSON.Polygon | GeoJSON.MultiPolygon;
    documentId?: string;
    relationId?: string;
    relationRevision?: number;
  })[];
  computedAt: string;
  revision?: number;
  instanceId?: string;
  stale?: boolean;
  runId?: string;
  reused?: boolean;
  sourceRunId?: string;
  metadata?: { inputFingerprint?: string; expiresAt?: string };
  evidence?: {
    ais: (PredictionObservationEvidence & { recordId: string })[];
    documents: { id: string; title?: string; occurredAt?: string }[];
    steps: { rule?: string; outcome?: string; detail?: string }[];
    limitations: string[];
  };
}
/** The adapter owns transport and lifecycle; map and panels consume one committed result. */
export function useReachability() {
  const { api } = usePlatform();
  const mmsi = ref('');
  const watchlist = ref<string[]>([]);
  const busy = ref(false),
    error = ref(''),
    message = ref('');
  const result = shallowRef<PredictionRecord | null>(null);
  const inputObservation = computed(() =>
    result.value ? predictionInputObservation(result.value) : null,
  );
  const minutes = ref<15 | 30 | 60 | 120>(15);
  const view = ref<'position' | 'passage'>('position');
  const levels = ref<number[]>([0.5, 0.8, 0.95]);
  const visible = ref(true);
  type Invocation = { target: string; cancelled: boolean; instanceId?: string };
  let activeInvocation: Invocation | null = null;
  const watchInstances = new Map<string, string>();
  let generation = 0;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let watchTimer: ReturnType<typeof setInterval> | undefined;
  function setMmsi(value: string) {
    if (busy.value) return;
    mmsi.value = value;
  }
  function setMinutes(value: 15 | 30 | 60 | 120) {
    minutes.value = value;
  }
  function setView(value: 'position' | 'passage') {
    view.value = value;
  }
  function setLevels(value: number[]) {
    levels.value = value;
  }
  function setVisible(value: boolean) {
    visible.value = value;
  }
  async function follow(value = mmsi.value) {
    if (busy.value) return;
    if (!/^[1-9]\d{8}$/.test(value) || watchlist.value.includes(value)) return;
    if (watchlist.value.length >= 20) {
      error.value = '关注集合最多20艘，请先移除已有对象';
      return;
    }
    watchlist.value = [...watchlist.value, value];
    try {
      const response = await api<{ instanceId: string }>('/topics/predictions', {
        method: 'POST',
        body: { mmsi: value, watch: true },
        idempotent: true,
      });
      watchInstances.set(value, response.instanceId);
    } catch (e) {
      watchlist.value = watchlist.value.filter((id) => id !== value);
      error.value = (e as Error).message;
    }
  }
  async function unfollow(value: string) {
    try {
      const id = watchInstances.get(value);
      if (id)
        await api('/topics/predictions/' + encodeURIComponent(id) + '/watch', {
          method: 'PUT',
          body: { watch: false },
        });
      watchlist.value = watchlist.value.filter((id) => id !== value);
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  async function loadWatchlist() {
    if (!watchTimer)
      watchTimer = setInterval(() => {
        void loadWatchlist();
      }, 60000);
    try {
      const response = await api<{
        instances: { id: string; mmsi: string; watch: boolean }[];
        items: { id: string; stale?: boolean; revision?: number }[];
      }>('/topics/predictions');
      const watched = response.instances.filter((v) => v.watch).slice(0, 20);
      watchlist.value = watched.map((v) => v.mmsi);
      for (const v of watched) watchInstances.set(v.mmsi, v.id);
      const current = response.items.find((item) => item.id === result.value?.id);
      if (
        current &&
        result.value &&
        (current.stale || current.revision !== result.value.revision)
      ) {
        result.value = { ...result.value, stale: true, impacts: [] };
        message.value = '关注结果已有更新，当前保留固定历史修订；刷新结果可查看最新态势';
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }
  async function load(current = ++generation, attempt = 0, runId = ''): Promise<void> {
    try {
      let completedFingerprint: string | undefined;
      if (runId) {
        const run = await api<{
          status: string;
          error?: string | null;
          inputSnapshot?: { predictionContext?: { inputFingerprint?: string } };
        }>('/topics/runs/' + encodeURIComponent(runId));
        if (current !== generation) return;
        if (run.status === 'failed' || run.status === 'cancelled') {
          busy.value = false;
          error.value = run.status === 'failed' ? `预测计算失败：${run.error || '请重试'}` : '';
          message.value = run.status === 'cancelled' ? '预测任务已取消' : '';
          return;
        }
        if (run.status !== 'succeeded') {
          message.value = run.status === 'queued' ? '预测任务排队中' : '预测任务计算中';
          poll = setTimeout(() => {
            void load(current, attempt + 1, runId);
          }, 1500);
          return;
        }
        completedFingerprint = run.inputSnapshot?.predictionContext?.inputFingerprint;
      }
      const response = await api<{ items: PredictionRecord[] }>(
        '/topics/predictions?mmsi=' + encodeURIComponent(mmsi.value),
      );
      if (current !== generation) return;
      const record = response.items.find(
        (item) =>
          item.prediction?.mmsi === mmsi.value &&
          (!runId ||
            item.runId === runId ||
            (completedFingerprint?.length === 64 &&
              item.metadata?.inputFingerprint === completedFingerprint)),
      );
      if (record) {
        result.value = record;
        message.value =
          record.reused || (runId && record.runId !== runId)
            ? '输入未变化，已复用原预测快照'
            : '计算结果已加载';
        busy.value = false;
        visible.value = true;
      } else if (attempt < 20) {
        message.value = '任务运行中，等待完整计算结果';
        poll = setTimeout(() => {
          void load(current, attempt + 1, runId);
        }, 1500);
      } else {
        busy.value = false;
        message.value = '任务仍在运行，请稍后刷新结果';
      }
    } catch (e) {
      if (current === generation) {
        busy.value = false;
        error.value = (e as Error).message;
      }
    }
  }
  async function run() {
    if (busy.value) return;
    if (!/^[1-9]\d{8}$/.test(mmsi.value)) {
      error.value = '请输入9位有效MMSI';
      return;
    }
    const current = ++generation;
    const invocation: Invocation = { target: mmsi.value, cancelled: false };
    activeInvocation = invocation;
    clearTimeout(poll);
    busy.value = true;
    error.value = '';
    message.value = '正在提交预测任务';
    try {
      const response = await api<{ instanceId: string; runId: string }>('/topics/predictions', {
        method: 'POST',
        body: { mmsi: invocation.target },
        idempotent: true,
      });
      invocation.instanceId = response.instanceId;
      if (invocation.cancelled) {
        await cancelInvocation(invocation);
        return;
      }
      if (current === generation) {
        await load(current, 0, response.runId);
      }
    } catch (e) {
      if (current === generation || (invocation.cancelled && activeInvocation === invocation)) {
        error.value = (e as Error).message;
        busy.value = false;
      }
    }
  }
  async function cancel() {
    const invocation = activeInvocation;
    if (!invocation || invocation.cancelled) return;
    invocation.cancelled = true;
    generation++;
    clearTimeout(poll);
    if (result.value?.prediction.mmsi === invocation.target)
      result.value = { ...result.value, stale: true, impacts: [] };
    busy.value = true;
    if (!invocation.instanceId) {
      message.value = '已标记取消，任务受理后将停止';
      return;
    }
    await cancelInvocation(invocation);
  }
  async function cancelInvocation(invocation: Invocation) {
    if (!invocation.instanceId) return;
    try {
      await api('/topics/predictions/' + encodeURIComponent(invocation.instanceId) + '/cancel', {
        method: 'POST',
      });
      if (activeInvocation === invocation) message.value = '预测任务已取消';
    } catch (e) {
      if (activeInvocation === invocation) error.value = (e as Error).message;
    } finally {
      if (activeInvocation === invocation) busy.value = false;
    }
  }
  onBeforeUnmount(() => {
    generation++;
    clearTimeout(poll);
    clearInterval(watchTimer);
  });
  return {
    mmsi,
    watchlist,
    busy,
    error,
    message,
    result,
    inputObservation,
    minutes,
    view,
    levels,
    visible,
    follow,
    unfollow,
    run,
    load,
    loadWatchlist,
    cancel,
    setMmsi,
    setMinutes,
    setView,
    setLevels,
    setVisible,
  };
}
