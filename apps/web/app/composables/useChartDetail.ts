import { inject, provide, ref, shallowRef, type InjectionKey } from 'vue';
import type { ReplyObjectViewModel } from '../types/agentReply';
import type { AgentFocusResult, MapResponse } from '@ais/contracts';
import { createLiveFocusPresentation } from '../utils/liveFocus';
import { replyObjectKey } from '../utils/replyObjects';
import { focusBounds } from '../../../../packages/domain/agent-focus';

export function replyObjectFocus(
  reply: {
    sessionId: string | null;
    taskId: string | null;
    inputRevision?: number;
    readable?: boolean;
    focus?: AgentFocusResult | null;
  } | null,
  focused: AgentFocusResult | null,
): AgentFocusResult | null {
  if (!reply || reply.readable === false) return null;
  if (reply.focus) return reply.focus;
  return focused?.sessionId === reply.sessionId &&
    focused?.taskId === reply.taskId &&
    focused?.inputRevision === (reply.inputRevision ?? 0)
    ? focused
    : null;
}

export type ChartDetailKind =
  'intelligence' | 'vessel' | 'evidence' | 'sources' | 'task' | 'history';
export type ChartDetailSide = 'left' | 'right';

export function createChartDetailHost() {
  const active = ref<{ kind: ChartDetailKind; side: ChartDetailSide } | null>(null);
  return {
    active,
    open(kind: ChartDetailKind, side: ChartDetailSide) {
      active.value = { kind, side };
    },
    close(kind?: ChartDetailKind) {
      if (!kind || active.value?.kind === kind) active.value = null;
    },
    isOpen(kind: ChartDetailKind) {
      return active.value?.kind === kind;
    },
  };
}

/** A reply scope owns its selection and invalidates every outstanding detail read. */
export function createReplyObjectState(invalidateDetails: () => void = () => {}) {
  const panelOpen = ref(false);
  const selected = shallowRef<ReplyObjectViewModel | null>(null);
  let scope: string | undefined;
  let epoch = 0;
  return {
    panelOpen,
    selected,
    setScope(value: string) {
      if (scope === value) return;
      scope = value;
      epoch++;
      invalidateDetails();
      panelOpen.value = false;
      selected.value = null;
    },
    select(object: ReplyObjectViewModel) {
      const current = ++epoch;
      invalidateDetails();
      selected.value = object;
      return () => current === epoch;
    },
    clearSelection() {
      epoch++;
      selected.value = null;
    },
  };
}

/** Reuse map presentation rules while retaining the reply object's immutable evidence. */
export function createReplyObjectLocation() {
  const present = createLiveFocusPresentation();
  let presentation: ReturnType<typeof present> = null;
  return {
    update(focus: AgentFocusResult | null, items: MapResponse['items']) {
      presentation = present(focus, items);
    },
    bounds(object: ReplyObjectViewModel) {
      const geometries = presentation?.targets
        .filter((target) => replyObjectKey(target.ref) === object.key)
        .map((target) => target.geometry);
      return focusBounds(geometries?.length ? geometries : object.geometries);
    },
  };
}

/** Local detail reads keep their own retry identity and lose authority on a scope change. */
export function createReplyDetailReader() {
  const targetId = ref(''),
    busy = ref(false),
    error = ref('');
  let epoch = 0;
  let load: ((id: string) => Promise<string | void>) | null = null;
  async function read(id: string, reader: (id: string) => Promise<string | void>) {
    const current = ++epoch;
    targetId.value = id;
    load = reader;
    busy.value = true;
    error.value = '';
    try {
      const message = await reader(id);
      if (current === epoch) error.value = message ?? '';
    } catch (failure) {
      if (current === epoch) error.value = (failure as Error).message;
    } finally {
      if (current === epoch) busy.value = false;
    }
  }
  return {
    targetId,
    busy,
    error,
    read,
    retry: () => (load ? read(targetId.value, load) : Promise.resolve()),
    reset() {
      epoch++;
      targetId.value = '';
      busy.value = false;
      error.value = '';
      load = null;
    },
  };
}

type ChartDetailHost = ReturnType<typeof createChartDetailHost>;
const chartDetailHostKey: InjectionKey<ChartDetailHost> = Symbol('chart-detail-host');

export function provideChartDetailHost() {
  const host = createChartDetailHost();
  provide(chartDetailHostKey, host);
  return host;
}

/** Standalone pages retain their existing detail presentation when no chart host is present. */
export function useChartDetailHost() {
  return inject(chartDetailHostKey, null);
}
