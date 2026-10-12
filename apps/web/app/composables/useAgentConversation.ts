import type { UnwrapNestedRefs } from 'vue';
import type {
  AgentEvent,
  AgentMessage,
  AgentSession,
  AgentStep,
  AgentTask,
  AnalysisResult,
  Bbox,
} from '@ais/contracts';
import { canOperate } from '../utils/display';

interface AgentConfig {
  enabled: boolean;
  defaultHistoryHours: number;
  maxHistoryHours: number;
  maxModelCalls: number;
  maxToolCalls: number;
}
interface SessionDetail {
  session: AgentSession;
  messages: AgentMessage[];
  tasks: AgentTask[];
}
interface TaskDetail {
  task: AgentTask;
  results: AnalysisResult[];
  steps: AgentStep[];
}
export const agentStatusLabel: Record<AgentTask['status'], string> = {
  awaiting_input: '等待补充',
  queued: '等待执行',
  running: '智能体分析中',
  waiting_result: '等待算法结果',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
export function agentTaskActive(task: AgentTask) {
  return ['queued', 'running', 'waiting_result'].includes(task.status);
}
export function agentTaskHasAnalysis(
  task: Pick<AgentTask, 'definitionId' | 'resultVersion'>,
  steps: Pick<AgentStep, 'name'>[],
) {
  return (
    !!task.definitionId ||
    task.resultVersion > 0 ||
    steps.some((step) => step.name === 'run_analysis')
  );
}
export function createAgentMessageFollow() {
  let initialized = false;
  let sessionId: string | null = null;
  let knownIds = new Set<string>();
  let submittedId = '';
  return {
    update(id: string | null, messageIds: string[], sentId: string, nearBottom: boolean) {
      const sent = initialized && !!sentId && sentId !== submittedId;
      const appended =
        initialized && id === sessionId && messageIds.some((item) => !knownIds.has(item));
      initialized = true;
      sessionId = id;
      knownIds = new Set(messageIds);
      submittedId = sentId;
      return sent || (appended && nearBottom);
    },
  };
}

export function useAgentConversation() {
  const { api, session: identity } = usePlatform();
  const config = ref<AgentConfig | null>(null);
  const sessions = ref<AgentSession[]>([]);
  const activeSession = ref<AgentSession | null>(null);
  const messages = ref<AgentMessage[]>([]);
  const tasks = ref<AgentTask[]>([]);
  const detail = ref<TaskDetail | null>(null);
  const selectedTaskId = ref('');
  const draft = ref('');
  const historyHours = ref(24);
  const region = ref<Bbox | null>(null);
  const operationError = ref('');
  const sendError = ref('');
  const pollingError = ref('');
  const error = computed(() => sendError.value || operationError.value || pollingError.value);
  const submittedMessageId = ref('');
  const busy = ref(false);
  const loading = ref(false);
  const detailLoading = ref(false);
  const canWrite = computed(() => canOperate(identity.value?.user.role));
  const activeTask = computed(() => tasks.value.some(agentTaskActive));
  let generation = 0;
  let detailGeneration = 0;
  let cursor = '0';
  let disposed = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: { fingerprint: string; key: string } | null = null;
  function current(value: number) {
    return !disposed && generation === value;
  }
  function storageKey() {
    return `ais-agent-session:${identity.value?.user.id ?? ''}`;
  }
  function remember(id: string | null) {
    if (typeof localStorage === 'undefined') return;
    try {
      if (id) localStorage.setItem(storageKey(), id);
      else localStorage.removeItem(storageKey());
    } catch {
      /* Session recovery remains available through the server list. */
    }
  }
  function reset() {
    generation++;
    detailGeneration++;
    activeSession.value = null;
    messages.value = [];
    tasks.value = [];
    detail.value = null;
    selectedTaskId.value = '';
    region.value = null;
    draft.value = '';
    cursor = '0';
    pending = null;
    busy.value = false;
    loading.value = false;
    detailLoading.value = false;
    operationError.value = '';
    sendError.value = '';
    pollingError.value = '';
    submittedMessageId.value = '';
  }
  function setDraft(value: string) {
    draft.value = value;
  }
  function newSession() {
    reset();
    remember(null);
  }
  function confirmRegion(bbox: Bbox) {
    if (
      !bbox.every(Number.isFinite) ||
      bbox[0] < -180 ||
      bbox[2] > 180 ||
      bbox[0] > 180 ||
      bbox[2] < -180 ||
      bbox[1] < -90 ||
      bbox[3] > 90 ||
      bbox[1] >= bbox[3]
    ) {
      operationError.value = '当前视野无法作为分析区域，请调整海图后重试。';
      return;
    }
    region.value = [...bbox];
    operationError.value = '';
  }
  async function loadTask(id: string, propagateError = false) {
    const turn = generation;
    const request = ++detailGeneration;
    selectedTaskId.value = id;
    detail.value = null;
    detailLoading.value = true;
    try {
      const response = await api<TaskDetail>(`/agent/tasks/${encodeURIComponent(id)}`);
      if (
        current(turn) &&
        request === detailGeneration &&
        response.task.sessionId === activeSession.value?.id
      )
        detail.value = response;
    } catch (e) {
      if (current(turn) && request === detailGeneration && !propagateError)
        operationError.value = (e as Error).message;
      if (propagateError) throw e;
    } finally {
      if (current(turn) && request === detailGeneration) detailLoading.value = false;
    }
  }
  async function refresh(turn = generation) {
    const id = activeSession.value?.id;
    if (!id) return;
    const response = await api<SessionDetail>(`/agent/sessions/${encodeURIComponent(id)}`);
    if (!current(turn) || response.session.id !== id) return;
    messages.value = response.messages;
    tasks.value = response.tasks;
    const selected =
      response.tasks.find((item) => item.id === selectedTaskId.value) ?? response.tasks.at(-1);
    if (selected) await loadTask(selected.id, true);
  }
  async function openSession(id: string) {
    reset();
    const turn = generation;
    loading.value = true;
    try {
      const response = await api<SessionDetail>(`/agent/sessions/${encodeURIComponent(id)}`);
      if (!current(turn) || response.session.id !== id) return;
      activeSession.value = response.session;
      messages.value = response.messages;
      tasks.value = response.tasks;
      const latest = response.tasks.at(-1);
      if (latest) {
        region.value = latest.bbox ? [...latest.bbox] : null;
        historyHours.value = latest.historyHours;
        await loadTask(latest.id);
      }
      if (current(turn)) remember(id);
    } catch (e) {
      if (current(turn)) {
        operationError.value = (e as Error).message;
        remember(null);
      }
    } finally {
      if (current(turn)) loading.value = false;
    }
  }
  async function initialize() {
    const turn = generation;
    loading.value = true;
    operationError.value = '';
    try {
      const settings = await api<AgentConfig>('/agent/config');
      if (!current(turn)) return;
      config.value = settings;
      historyHours.value = settings.defaultHistoryHours;
      if (!settings.enabled) return;
      const response = await api<{ items: AgentSession[] }>('/agent/sessions');
      if (!current(turn)) return;
      sessions.value = response.items;
      let saved: string | null = null;
      try {
        if (typeof localStorage !== 'undefined') saved = localStorage.getItem(storageKey());
      } catch {
        /* Storage can be unavailable. */
      }
      if (saved && response.items.some((item) => item.id === saved)) await openSession(saved);
    } catch (e) {
      if (current(turn)) operationError.value = (e as Error).message;
    } finally {
      if (current(turn)) loading.value = false;
    }
  }
  async function send() {
    if (
      !canWrite.value ||
      !config.value?.enabled ||
      busy.value ||
      loading.value ||
      activeTask.value
    )
      return;
    const content = draft.value.trim();
    if (!content || content.length > 4000) {
      sendError.value = '请输入 1～4000 字的问题。';
      return;
    }
    if (
      !Number.isInteger(historyHours.value) ||
      historyHours.value < 1 ||
      historyHours.value > config.value.maxHistoryHours
    ) {
      sendError.value = `分析窗口应为 1～${config.value.maxHistoryHours} 小时。`;
      return;
    }
    const turn = generation;
    const body = {
      content,
      historyHours: historyHours.value,
      ...(region.value ? { bbox: [...region.value] } : {}),
    };
    busy.value = true;
    sendError.value = '';
    operationError.value = '';
    try {
      if (!activeSession.value) {
        const created = await api<AgentSession>('/agent/sessions', {
          method: 'POST',
          body: { title: content.slice(0, 60) },
        });
        if (!current(turn)) return;
        activeSession.value = created;
        sessions.value = [created, ...sessions.value];
        remember(created.id);
      }
      const id = activeSession.value.id;
      const fingerprint = JSON.stringify({ id, body });
      if (pending?.fingerprint !== fingerprint) pending = { fingerprint, key: crypto.randomUUID() };
      const response = await api<{ message: AgentMessage; task: AgentTask }>(
        `/agent/sessions/${id}/messages`,
        {
          method: 'POST',
          body,
          idempotencyKey: pending.key,
        },
      );
      if (!current(turn)) return;
      pending = null;
      if (draft.value.trim() === content) draft.value = '';
      messages.value = [
        ...messages.value.filter((item) => item.id !== response.message.id),
        response.message,
      ];
      tasks.value = [...tasks.value.filter((item) => item.id !== response.task.id), response.task];
      submittedMessageId.value = response.message.id;
      selectedTaskId.value = response.task.id;
      await refresh(turn);
    } catch (e) {
      if (current(turn)) sendError.value = (e as Error).message;
    } finally {
      if (current(turn)) busy.value = false;
    }
  }
  async function cancel(id: string) {
    if (!canWrite.value || busy.value) return;
    const turn = generation;
    busy.value = true;
    operationError.value = '';
    try {
      await api(`/agent/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (current(turn)) await refresh(turn);
    } catch (e) {
      if (current(turn)) operationError.value = (e as Error).message;
    } finally {
      if (current(turn)) busy.value = false;
    }
  }
  async function poll() {
    const id = activeSession.value?.id;
    if (!id || polling || busy.value || loading.value || !config.value?.enabled) return;
    const turn = generation;
    polling = true;
    try {
      const response = await api<{ items: AgentEvent[]; nextCursor: string }>(
        `/agent/sessions/${encodeURIComponent(id)}/events?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!current(turn)) return;
      if (response.items.length) await refresh(turn);
      if (current(turn)) {
        cursor = response.nextCursor;
        pollingError.value = '';
      }
    } catch (e) {
      if (current(turn)) {
        pollingError.value = (e as Error).message;
        // Permission can change while a session is open. Hide cached evidence until a fresh read succeeds.
        detail.value = null;
      }
    } finally {
      polling = false;
    }
  }
  onMounted(() => {
    void initialize();
    timer = setInterval(() => void poll(), 2500);
  });
  watch(
    () => identity.value?.user.id,
    () => {
      reset();
      config.value = null;
      sessions.value = [];
      void initialize();
    },
  );
  onBeforeUnmount(() => {
    disposed = true;
    generation++;
    detailGeneration++;
    clearInterval(timer);
  });
  return {
    config,
    sessions,
    activeSession,
    messages,
    submittedMessageId,
    tasks,
    detail,
    selectedTaskId,
    draft,
    setDraft,
    historyHours,
    region,
    error,
    busy,
    loading,
    detailLoading,
    canWrite,
    activeTask,
    initialize,
    newSession,
    openSession,
    confirmRegion,
    loadTask,
    send,
    cancel,
    poll,
  };
}

export type AgentConversationState = UnwrapNestedRefs<ReturnType<typeof useAgentConversation>>;
