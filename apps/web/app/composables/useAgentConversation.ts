import { isUiIntent } from '../../../../packages/domain/agent-ui-intent';
import type { UnwrapNestedRefs } from 'vue';
import type {
  AgentEvent,
  UiBinding,
  AgentMessage,
  AgentSession,
  AgentStep,
  AgentTask,
  AnalysisResult,
  Bbox,
  AgentMapContext,
  AgentInputRequest,
  AgentInputValues,
  AgentQueryResult,
  AgentIntelligenceResult,
  IntelligenceEvidence,
  IntelligenceSourceHealth,
  AgentHeatmapResult,
  AgentVesselTracksResult,
} from '@ais/contracts';
import { canOperate } from '../utils/display';
import type {
  DynamicSkillArtifact,
  DynamicSkillExecution,
} from '../../../../packages/contracts/dynamic-skills';

export interface AgentConfig {
  enabled: boolean;
  uiEnabled?: boolean;
  dynamicSkillsEnabled?: boolean;
  defaultHistoryHours: number;
  maxHistoryHours: number;
  maxModelCalls: number;
  maxToolCalls: number;
}
interface SessionDetail {
  session: AgentSession;
  messages: AgentMessage[];
  tasks: AgentTask[];
  pendingInputRequests?: AgentInputRequest[];
  snapshotCursor?: string;
}
interface TaskDetail {
  task: AgentTask;
  results: AnalysisResult[];
  steps: AgentStep[];
  pendingInputRequests?: AgentInputRequest[];
  queryResult?: AgentQueryResult | null;
  intelligenceResult?: AgentIntelligenceResult | null;
  heatmapResult?: AgentHeatmapResult | null;
  tracksResult?: AgentVesselTracksResult | null;
  dynamicSkill?: DynamicSkillExecution;
  artifacts?: DynamicSkillArtifact[];
}
export interface AgentHeatmapDisplay {
  begin(): number;
  accept(result: AgentHeatmapResult, scope: string, token: number): unknown;
  reset(): void;
}
export interface AgentTracksDisplay {
  begin(): number;
  accept(result: AgentVesselTracksResult, scope: string, token: number): unknown;
  reset(): void;
}
export type CurrentAgentReplyStatus = AgentTask['status'] | 'sending' | 'send_failed';
export interface CurrentAgentReply {
  question: string;
  sessionId: string | null;
  taskId: string | null;
  userMessageId: string | null;
  assistant: AgentMessage | null;
  status: CurrentAgentReplyStatus;
  error: string;
  createdAt: string;
}
export const agentStatusLabel: Record<AgentTask['status'], string> = {
  awaiting_input: '等待补充',
  queued: '等待执行',
  running: '智能体分析中',
  waiting_result: '等待算法结果',
  waiting_ui: '等待界面执行',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
};
export function agentTaskActive(task: AgentTask) {
  return ['queued', 'running', 'waiting_result', 'waiting_ui'].includes(task.status);
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

export function useAgentConversation(
  context?: () => AgentMapContext | undefined,
  heatmap?: AgentHeatmapDisplay,
  bindUi?: (sessionId: string) => Promise<UiBinding | undefined>,
  readConfig?: () => Promise<AgentConfig>,
  tracks?: AgentTracksDisplay,
) {
  let heatmapTicket: number | undefined;
  let tracksTicket: number | undefined;
  const { api, session: identity } = usePlatform();
  const config = ref<AgentConfig | null>(null);
  const sessions = ref<AgentSession[]>([]);
  const activeSession = ref<AgentSession | null>(null);
  const messages = ref<AgentMessage[]>([]);
  const tasks = ref<AgentTask[]>([]);
  const detail = ref<TaskDetail | null>(null);
  const sourceOpen = ref(false);
  const sourceBusy = ref(false);
  const sourceError = ref('');
  const sourceEvidence = ref<IntelligenceEvidence | null>(null);
  const sourceHealth = ref<IntelligenceSourceHealth[]>([]);
  const sourceScopeNote = ref('');
  let sourceGeneration = 0;
  function closeSource() {
    sourceGeneration++;
    sourceOpen.value = false;
    sourceBusy.value = false;
    sourceEvidence.value = null;
    sourceHealth.value = [];
    sourceScopeNote.value = '';
    sourceError.value = '';
  }
  async function openSource(reference: string, taskId: string, resultVersion: number) {
    const turn = generation;
    const sourceTurn = ++sourceGeneration;
    sourceOpen.value = true;
    sourceBusy.value = true;
    sourceEvidence.value = null;
    sourceHealth.value = [];
    sourceScopeNote.value = '';
    sourceError.value = '';
    try {
      const response = await api<TaskDetail>(
        `/agent/tasks/${encodeURIComponent(taskId)}?resultVersion=${resultVersion}`,
      );
      if (!current(turn) || sourceTurn !== sourceGeneration) return;
      const result = response.intelligenceResult;
      if (response.task.sessionId !== activeSession.value?.id || result?.version !== resultVersion)
        throw new Error('此引用的结果版本不可用，请重新查询。');
      const evidence = result.evidence.find((item) => item.reference === reference);
      if (!evidence) throw new Error('此版本中没有对应情报引用。');
      sourceEvidence.value = evidence;
      sourceHealth.value = result.sourceHealth;
      sourceScopeNote.value = result.spec?.locationKeyword
        ? `${result.spec.locationKeyword}：粗略检索范围，非官方海域界线；文字提及不代表已确认位置。`
        : '';
    } catch (e) {
      if (current(turn) && sourceTurn === sourceGeneration)
        sourceError.value = (e as Error).message;
    } finally {
      if (current(turn) && sourceTurn === sourceGeneration) sourceBusy.value = false;
    }
  }
  const inputRequests = ref<AgentInputRequest[]>([]);
  const openInputId = ref('');
  const inputError = ref('');
  const inputBusy = ref(false);
  const seenInputs = new Set<string>();
  const inputKeys = new Map<string, { fingerprint: string; key: string }>();
  const retryKeys = new Map<string, string>();
  const openInput = computed(
    () =>
      inputRequests.value.find(
        (item) => item.id === openInputId.value && item.status === 'pending',
      ) ?? null,
  );
  function syncInputs(items: AgentInputRequest[] | undefined, autoOpen = false, taskId?: string) {
    if (!items) return;
    const incoming = items.filter(
      (item) => item.sessionId === activeSession.value?.id && item.status === 'pending',
    );
    inputRequests.value = taskId
      ? [
          ...inputRequests.value.filter((item) => item.taskId !== taskId),
          ...incoming.filter((item) => item.taskId === taskId),
        ]
      : incoming;
    if (!inputRequests.value.some((item) => item.id === openInputId.value)) openInputId.value = '';
    for (const item of inputRequests.value) {
      if (!seenInputs.has(item.id) && autoOpen && !openInputId.value) openInputId.value = item.id;
      seenInputs.add(item.id);
    }
  }
  function showInput(id: string) {
    inputError.value = '';
    openInputId.value = id;
  }
  function closeInput() {
    openInputId.value = '';
  }
  const selectedTaskId = ref('');
  const draft = ref('');
  const historyHours = ref(24);
  const region = ref<Bbox | null>(null);
  const operationError = ref('');
  const sendError = ref('');
  const pollingError = ref('');
  const error = computed(() => sendError.value || operationError.value || pollingError.value);
  const submittedMessageId = ref('');
  const currentRequest = ref<Omit<CurrentAgentReply, 'assistant'> | null>(null);
  const replyDismissed = ref(false);
  const replyReadable = ref(true);
  const currentReply = computed<CurrentAgentReply | null>(() => {
    const request = currentRequest.value;
    if (!request || replyDismissed.value) return null;
    const task = tasks.value.find(
      (item) => item.id === request.taskId && item.sessionId === request.sessionId,
    );
    const assistant =
      replyReadable.value && request.taskId
        ? (messages.value.findLast(
            (item) =>
              item.role === 'assistant' &&
              item.sessionId === request.sessionId &&
              item.taskId === request.taskId,
          ) ?? null)
        : null;
    return {
      ...request,
      assistant,
      status: task?.status ?? request.status,
      error: request.error || pollingError.value || task?.error || '',
    };
  });
  const busy = ref(false);
  const loading = ref(false);
  const detailLoading = ref(false);
  const canWrite = computed(() => canOperate(identity.value?.user.role));
  const activeTask = computed(() => tasks.value.some(agentTaskActive));
  let generation = 0;
  let detailGeneration = 0;
  let readEpoch = 0;
  let cursor = '0';
  let disposed = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending: {
    fingerprint: string;
    retryFingerprint: string;
    key: string;
    body: {
      content: string;
      historyHours: number;
      bbox?: number[];
      mapContext?: AgentMapContext;
      uiBinding?: UiBinding;
    };
  } | null = null;
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
    heatmap?.reset();
    heatmapTicket = undefined;
    tracks?.reset();
    tracksTicket = undefined;
    closeSource();
    generation++;
    detailGeneration++;
    activeSession.value = null;
    messages.value = [];
    tasks.value = [];
    detail.value = null;
    inputRequests.value = [];
    openInputId.value = '';
    inputError.value = '';
    inputBusy.value = false;
    seenInputs.clear();
    inputKeys.clear();
    retryKeys.clear();
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
    currentRequest.value = null;
    replyDismissed.value = false;
    replyReadable.value = true;
  }
  function dismissCurrentReply() {
    replyDismissed.value = true;
  }
  function hideCachedReply(message: string) {
    heatmap?.reset();
    heatmapTicket = undefined;
    tracks?.reset();
    tracksTicket = undefined;
    closeSource();
    readEpoch++;
    detailGeneration++;
    detailLoading.value = false;
    replyReadable.value = false;
    messages.value = [];
    detail.value = null;
    pollingError.value = message;
    inputRequests.value = [];
    openInputId.value = '';
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
  function displayHeatmap(response: TaskDetail) {
    if (config.value?.uiEnabled && response.task.uiBinding) return;
    const result = response.heatmapResult;
    const task = response.task;
    const latest = tasks.value.find((item) => item.id === task.id);
    if (
      heatmapTicket !== undefined &&
      result &&
      task.status === 'completed' &&
      task.id === currentRequest.value?.taskId &&
      task.sessionId === activeSession.value?.id &&
      task.sessionId === currentRequest.value?.sessionId &&
      latest?.inputRevision === task.inputRevision &&
      latest?.resultVersion === task.resultVersion &&
      result.inputRevision === task.inputRevision &&
      task.resultInputRevision === task.inputRevision &&
      result.version === task.resultVersion
    )
      heatmap?.accept(result, `${task.sessionId}:${task.id}`, heatmapTicket);
  }
  function displayTracks(response: TaskDetail) {
    if (config.value?.uiEnabled && response.task.uiBinding) return;
    const result = response.tracksResult;
    const task = response.task;
    const latest = tasks.value.find((item) => item.id === task.id);
    if (
      tracksTicket !== undefined &&
      result &&
      task.status === 'completed' &&
      task.id === currentRequest.value?.taskId &&
      task.sessionId === activeSession.value?.id &&
      task.sessionId === currentRequest.value?.sessionId &&
      latest?.inputRevision === task.inputRevision &&
      latest?.resultVersion === task.resultVersion &&
      result.inputRevision === task.inputRevision &&
      task.resultInputRevision === task.inputRevision &&
      result.version === task.resultVersion
    )
      tracks?.accept(result, `${task.sessionId}:${task.id}`, tracksTicket);
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
      ) {
        detail.value = response;
        displayHeatmap(response);
        displayTracks(response);
      }
    } catch (e) {
      if (current(turn) && request === detailGeneration) hideCachedReply((e as Error).message);
      if (propagateError) throw e;
    } finally {
      if (current(turn) && request === detailGeneration) detailLoading.value = false;
    }
  }
  async function refresh(turn = generation, autoOpen = true) {
    const id = activeSession.value?.id;
    if (!id) return false;
    const epoch = readEpoch;
    try {
      const response = await api<SessionDetail>(`/agent/sessions/${encodeURIComponent(id)}`);
      if (!current(turn) || epoch !== readEpoch || response.session.id !== id) return false;
      messages.value = response.messages;
      tasks.value = response.tasks;
      syncInputs(response.pendingInputRequests, autoOpen);
      replyReadable.value = true;
      const selected =
        response.tasks.find((item) => item.id === selectedTaskId.value) ?? response.tasks.at(-1);
      if (selected) await loadTask(selected.id, true);
      const liveId = currentRequest.value?.taskId;
      if (
        (heatmapTicket !== undefined || tracksTicket !== undefined) &&
        liveId &&
        liveId !== selected?.id
      ) {
        const live = await api<TaskDetail>(`/agent/tasks/${encodeURIComponent(liveId)}`);
        if (current(turn) && epoch === readEpoch) {
          displayHeatmap(live);
          displayTracks(live);
        }
      }
      return current(turn) && epoch === readEpoch;
    } catch (e) {
      if (current(turn) && epoch === readEpoch) hideCachedReply((e as Error).message);
      return false;
    }
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
      syncInputs(response.pendingInputRequests);
      if (response.snapshotCursor) cursor = response.snapshotCursor;
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
      const settings = await (readConfig ? readConfig() : api<AgentConfig>('/agent/config'));
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
      (activeTask.value && !isUiIntent(draft.value))
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
    const mapContext = context?.();
    heatmapTicket = heatmap?.begin();
    tracksTicket = tracks?.begin();
    let body: {
      content: string;
      historyHours: number;
      bbox?: number[];
      mapContext?: AgentMapContext;
      uiBinding?: UiBinding;
    } = {
      content,
      historyHours: historyHours.value,
      ...(region.value ? { bbox: [...region.value] } : {}),
      ...(mapContext
        ? { mapContext: JSON.parse(JSON.stringify(mapContext)) as AgentMapContext }
        : {}),
    };
    currentRequest.value = {
      question: content,
      sessionId: activeSession.value?.id ?? null,
      taskId: null,
      userMessageId: null,
      status: 'sending',
      error: '',
      createdAt: new Date().toISOString(),
    };
    replyDismissed.value = false;
    replyReadable.value = true;
    let accepted = false;
    busy.value = true;
    sendError.value = '';
    operationError.value = '';
    pollingError.value = '';
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
      currentRequest.value!.sessionId = id;
      const uiBinding = await bindUi?.(id);
      if (uiBinding) body.uiBinding = uiBinding;
      const retryFingerprint = JSON.stringify({
        id,
        content,
        historyHours: body.historyHours,
        bbox: body.bbox,
      });
      if (pending?.retryFingerprint === retryFingerprint) body = pending.body;
      const fingerprint = JSON.stringify({ id, body });
      if (pending?.fingerprint !== fingerprint)
        pending = { fingerprint, retryFingerprint, body, key: crypto.randomUUID() };
      const response = await api<{
        message: AgentMessage;
        task: AgentTask;
        pendingInputRequests?: AgentInputRequest[];
      }>(`/agent/sessions/${id}/messages`, {
        method: 'POST',
        body,
        idempotencyKey: pending.key,
      });
      if (!current(turn)) return;
      accepted = true;
      pending = null;
      if (draft.value.trim() === content) draft.value = '';
      messages.value = [
        ...messages.value.filter((item) => item.id !== response.message.id),
        response.message,
      ];
      tasks.value = [...tasks.value.filter((item) => item.id !== response.task.id), response.task];
      syncInputs(response.pendingInputRequests, true, response.task.id);
      submittedMessageId.value = response.message.id;
      selectedTaskId.value = response.task.id;
      currentRequest.value = {
        ...currentRequest.value!,
        sessionId: id,
        taskId: response.task.id,
        userMessageId: response.message.id,
        status: response.task.status,
      };
      await refresh(turn);
    } catch (e) {
      if (current(turn)) {
        const message = (e as Error).message;
        if (accepted) {
          hideCachedReply(message);
        } else {
          sendError.value = message;
          currentRequest.value = {
            ...currentRequest.value!,
            status: 'send_failed',
            error: message,
          };
        }
      }
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
  async function answerInput(request: AgentInputRequest, values?: AgentInputValues) {
    if (
      !canWrite.value ||
      inputBusy.value ||
      busy.value ||
      request.sessionId !== activeSession.value?.id
    )
      return false;
    const turn = generation;
    const body = values
      ? { action: 'accept' as const, inputRevision: request.inputRevision, values }
      : { action: 'decline' as const, inputRevision: request.inputRevision };
    if (values) {
      heatmapTicket = heatmap?.begin();
      tracksTicket = tracks?.begin();
    }
    const fingerprint = JSON.stringify(body);
    if (inputKeys.get(request.id)?.fingerprint !== fingerprint)
      inputKeys.set(request.id, { fingerprint, key: crypto.randomUUID() });
    inputBusy.value = true;
    busy.value = true;
    inputError.value = '';
    try {
      const response = await api<{ task: AgentTask; request: AgentInputRequest }>(
        `/agent/tasks/${encodeURIComponent(request.taskId)}/input-requests/${encodeURIComponent(request.id)}/responses`,
        { method: 'POST', body, idempotencyKey: inputKeys.get(request.id)!.key },
      );
      if (!current(turn)) return false;
      inputKeys.delete(request.id);
      tasks.value = tasks.value.map((item) =>
        item.id === response.task.id ? response.task : item,
      );
      inputRequests.value = inputRequests.value.filter((item) => item.id !== request.id);
      selectedTaskId.value = response.task.id;
      if (values) {
        const userMessage = messages.value.findLast(
          (item) => item.taskId === response.task.id && item.role === 'user',
        );
        currentRequest.value = {
          question: response.task.goal,
          sessionId: response.task.sessionId,
          taskId: response.task.id,
          userMessageId: userMessage?.id ?? null,
          status: response.task.status,
          error: '',
          createdAt: new Date().toISOString(),
        };
        replyDismissed.value = false;
        replyReadable.value = true;
      }
      closeInput();
      if (values?.bbox) region.value = [...values.bbox];
      if (values?.historyHours) historyHours.value = values.historyHours;
      await refresh(turn);
      return true;
    } catch (e) {
      if (current(turn)) {
        const status = (e as Error & { status?: number }).status;
        inputError.value =
          status === 400
            ? '所选条件无效，请检查区域、船舶和时间范围后重试。'
            : status === 409
              ? '此条件请求已变化或已在其他窗口处理，正在刷新任务状态。'
              : (e as Error).message;
        if (status === 409) await refresh(turn, false);
        else if (status === 401 || status === 403) hideCachedReply((e as Error).message);
      }
      return false;
    } finally {
      if (current(turn)) {
        inputBusy.value = false;
        busy.value = false;
      }
    }
  }
  async function retryTask(id: string) {
    if (!canWrite.value || busy.value || activeTask.value) return;
    const turn = generation;
    heatmapTicket = heatmap?.begin();
    tracksTicket = tracks?.begin();
    busy.value = true;
    operationError.value = '';
    if (!retryKeys.has(id)) retryKeys.set(id, crypto.randomUUID());
    try {
      const response = await api<{ task: AgentTask; message: AgentMessage }>(
        `/agent/tasks/${encodeURIComponent(id)}/retry`,
        {
          method: 'POST',
          body: {
            ...(activeSession.value && bindUi
              ? { uiBinding: await bindUi(activeSession.value.id) }
              : {}),
          },
          idempotencyKey: retryKeys.get(id)!,
        },
      );
      if (!current(turn)) return;
      // Keep this key for the original task while the session is open, including lost refreshes.
      tasks.value = [...tasks.value.filter((item) => item.id !== response.task.id), response.task];
      messages.value = [
        ...messages.value.filter((item) => item.id !== response.message.id),
        response.message,
      ];
      submittedMessageId.value = response.message.id;
      currentRequest.value = {
        question: response.task.goal,
        sessionId: response.task.sessionId,
        taskId: response.task.id,
        userMessageId: response.message.id,
        status: response.task.status,
        error: '',
        createdAt: response.message.createdAt,
      };
      replyDismissed.value = false;
      selectedTaskId.value = response.task.id;
      await refresh(turn);
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
    const epoch = readEpoch;
    polling = true;
    try {
      const response = await api<{ items: AgentEvent[]; nextCursor: string }>(
        `/agent/sessions/${encodeURIComponent(id)}/events?cursor=${encodeURIComponent(cursor)}`,
      );
      if (!current(turn) || epoch !== readEpoch) return;
      if ((response.items.length || !replyReadable.value) && !(await refresh(turn))) return;
      if (current(turn) && epoch === readEpoch) {
        cursor = response.nextCursor;
        pollingError.value = '';
      }
    } catch (e) {
      if (current(turn) && epoch === readEpoch) {
        // Permission can change while a session is open. Hide cached evidence until a fresh read succeeds.
        hideCachedReply((e as Error).message);
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
    sourceOpen,
    sourceBusy,
    sourceError,
    sourceEvidence,
    sourceHealth,
    sourceScopeNote,
    openSource,
    closeSource,
    inputRequests,
    openInput,
    openInputId,
    inputError,
    inputBusy,
    showInput,
    closeInput,
    answerInput,
    retryTask,
    sessions,
    activeSession,
    messages,
    submittedMessageId,
    currentReply,
    dismissCurrentReply,
    showCurrentReply: () => {
      replyDismissed.value = false;
    },
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
