import type { AgentConfig } from './useAgentConversation';
import { commandReceiptIdentity } from '../utils/agentArtifacts';
import { nextTick, onScopeDispose } from 'vue';
import {
  UiStateSchema,
  uiOperationAllowed,
  uiCommandPostcondition,
  type UiBinding,
  type UiCommand,
  type UiComponent,
  type UiComponentId,
  type UiOperation,
  type UiReceipt,
  type UiState,
  type MapCameraResult,
} from '@ais/contracts';

type Projection = Omit<UiComponent, 'id' | 'version'>;
type Adapter = {
  read(): Projection;
  execute?(operation: UiOperation, command: UiCommand): void | Promise<void>;
};
const registries = new WeakMap<object, ReturnType<typeof createUiRegistry>>();
function createUiRegistry() {
  const { api, session } = usePlatform();
  const route = useRoute();
  const adapters = new Map<UiComponentId, Adapter>();
  const versions = new Map<UiComponentId, { json: string; version: number }>();
  let binding: UiBinding | undefined;
  let instanceId = '';
  let sessionId: string | null = null;
  let sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = true;
  let epoch = 0;
  let enabled = false;
  let queue: Promise<unknown> = Promise.resolve();
  const receipts = new Map<string, UiReceipt>();
  const executing = new Set<string>();
  const error = ref('');
  let configuration: Promise<AgentConfig> | undefined;
  let configurationOwner: string | undefined;
  function readConfig() {
    const owner = session.value?.user.id;
    if (!configuration || configurationOwner !== owner) {
      configurationOwner = owner;
      configuration = api<AgentConfig>('/agent/config').catch((error) => {
        configuration = undefined;
        throw error;
      });
    }
    return configuration;
  }
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work, work);
    queue = result.catch(() => undefined);
    return result;
  }
  function snapshot(): UiState {
    const components: UiComponent[] = [];
    for (const [id, adapter] of adapters) {
      const value = adapter.read();
      const json = JSON.stringify(value);
      const before = versions.get(id);
      const version = (before?.version ?? 0) + (before?.json === json ? 0 : 1);
      versions.set(id, { json, version });
      components.push({ ...value, id, version });
    }
    return UiStateSchema.parse({ sequence: ++sequence, route: route.path, components });
  }
  async function sync() {
    if (!enabled || stopped) return;
    const turn = epoch;
    if (!binding)
      binding = await api<UiBinding>('/agent/ui/clients', { method: 'POST', body: { instanceId } });
    if (turn !== epoch) return;
    const result = await api<UiBinding>(`/agent/ui/clients/${binding.clientId}/state`, {
      method: 'PUT',
      body: { ...binding, sessionId, state: snapshot() },
    }).catch((failure: unknown) => {
      // A lost binding response can leave the server one generation ahead. Re-register the
      // same live instance to discover its generation; never reuse another page's identity.
      if ((failure as { status?: number }).status === 409 && turn === epoch) binding = undefined;
      throw failure;
    });
    if (turn === epoch) binding = result;
  }
  async function sendReceipt(id: string, value: UiReceipt) {
    await api(`/agent/ui/commands/${id}/receipts`, { method: 'POST', body: value });
  }
  async function execute(command: UiCommand) {
    if (!binding || executing.has(command.id) || command.status === 'executing') return;
    const bound = { ...binding };
    const targetSession = sessionId;
    const turn = epoch;
    let claimed: UiCommand;
    try {
      claimed = await api<UiCommand>(`/agent/ui/commands/${command.id}/claim`, {
        method: 'POST',
        body: bound,
      });
    } catch {
      return;
    }
    if (turn !== epoch || !claimed.claimToken) return;
    const current = snapshot();
    const component = current.components.find((c) => c.id === claimed.operation.componentId);
    const adapter = adapters.get(claimed.operation.componentId);
    const valid = () => {
      const actual = snapshot().components.find((c) => c.id === claimed.operation.componentId);
      return (
        turn === epoch &&
        sessionId === targetSession &&
        binding?.pageGeneration === bound.pageGeneration &&
        actual?.version === claimed.expectedVersion &&
        actual.mounted &&
        !actual.blocked &&
        actual.actions.includes(claimed.operation.action) &&
        uiOperationAllowed(claimed.operation)
      );
    };
    const base = {
      ...bound,
      claimToken: claimed.claimToken,
      ...commandReceiptIdentity(claimed),
    };
    if (!component || !adapter?.execute || !valid()) {
      const rejected: UiReceipt = {
        ...base,
        receiptId: crypto.randomUUID(),
        status: 'rejected',
        state: current,
        error: 'STATE_CONFLICT',
      };
      receipts.set(claimed.id, rejected);
      await sendReceipt(claimed.id, rejected);
      receipts.delete(claimed.id);
      return;
    }
    executing.add(claimed.id);
    const started: UiReceipt = {
      ...base,
      receiptId: crypto.randomUUID(),
      status: 'executing',
      state: current,
    };
    // If the response is lost, do not perform the effect. The server will reconcile unknown.
    await sendReceipt(claimed.id, started);
    let status: UiReceipt['status'] = 'succeeded';
    let failure: UiReceipt['error'];
    if (!valid()) {
      status = 'rejected';
      failure = 'STATE_CONFLICT';
    } else {
      try {
        await adapter.execute(claimed.operation, claimed);
        await nextTick();
      } catch (error) {
        status = 'failed';
        const code = (error as { code?: string })?.code;
        failure =
          code === 'UNAVAILABLE' || code === 'STATE_CONFLICT' || code === 'POSTCONDITION_FAILED'
            ? code
            : 'EXECUTION_FAILED';
      }
    }
    const after = snapshot();
    if (status === 'succeeded' && !uiCommandPostcondition(claimed, after, current)) {
      status = 'failed';
      failure = 'POSTCONDITION_FAILED';
    }
    const receipt: UiReceipt = {
      ...base,
      receiptId: crypto.randomUUID(),
      status,
      state: after,
      ...(failure ? { error: failure } : {}),
    };
    receipts.set(claimed.id, receipt);
    await sendReceipt(claimed.id, receipt);
    receipts.delete(claimed.id);
  }
  async function tick() {
    if (stopped) return;
    try {
      await serial(async () => {
        await sync();
        if (!binding || !enabled || stopped) return;
        for (const [id, receipt] of receipts) {
          try {
            await sendReceipt(id, receipt);
            receipts.delete(id);
          } catch (e) {
            if ([403, 404, 409].includes((e as { status: number }).status)) receipts.delete(id);
            else throw e;
          }
        }
        const result = await api<{ items: UiCommand[] }>(
          `/agent/ui/clients/${binding.clientId}/commands?pageGeneration=${binding.pageGeneration}`,
        );
        for (const command of result.items) await execute(command);
      });
      error.value = '';
    } catch {
      error.value = '界面控制连接暂不可用';
    }
    if (!stopped) timer = setTimeout(() => void tick(), error.value ? 5000 : 1500);
  }
  function stop() {
    stopped = true;
    epoch++;
    clearTimeout(timer);
    binding = undefined;
    sessionId = null;
    receipts.clear();
    executing.clear();
  }
  async function start() {
    stop();
    if (!session.value || session.value.user.role === 'viewer') return;
    instanceId = crypto.randomUUID();
    stopped = false;
    const turn = epoch;
    try {
      const config = await readConfig();
      if (turn !== epoch) return;
      enabled = config.enabled && config.uiEnabled === true;
      if (enabled) void tick();
    } catch {
      error.value = '界面控制连接暂不可用';
      if (turn === epoch && !stopped) timer = setTimeout(() => void start(), 5000);
    }
  }
  return {
    error,
    readConfig,
    readComponent: (id: UiComponentId) => adapters.get(id)?.read(),
    start,
    stop,
    snapshot,
    register(id: UiComponentId, adapter: Adapter) {
      adapters.set(id, adapter);
      const previous = versions.get(id);
      if (previous) versions.set(id, { json: '', version: previous.version });
      return () => {
        if (adapters.get(id) === adapter) adapters.delete(id);
      };
    },
    async bind(id: string) {
      return serial(async () => {
        sessionId = id;
        await sync();
        return enabled && binding
          ? {
              ...binding,
              heatmapVersion: snapshot().components.find((c) => c.id === 'chart.heatmap')?.version,
              tracksVersion: snapshot().components.find((c) => c.id === 'chart.vessel-tracks')
                ?.version,
              highlightsVersion: snapshot().components.find(
                (c) => c.id === 'chart.vessel-highlights',
              )?.version,
              cameraVersion: snapshot().components.find((c) => c.id === 'chart.viewport')?.version,
            }
          : undefined;
      });
    },
    changed() {
      if (!stopped && enabled)
        void serial(sync).catch(() => {
          error.value = '界面状态同步失败';
        });
    },
    setSession(id: string | null) {
      if (sessionId === id) return;
      sessionId = id;
      if (!stopped && enabled)
        void serial(sync).catch(() => {
          error.value = '页面绑定更新失败';
        });
    },
  };
}
export function useAgentUi() {
  const app = useNuxtApp();
  let registry = registries.get(app);
  if (!registry) {
    registry = createUiRegistry();
    registries.set(app, registry);
  }
  return registry;
}
export function useUiComponent(id: UiComponentId, adapter: Adapter) {
  const ui = useAgentUi();
  const remove = ui.register(id, adapter);
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  watch(
    adapter.read,
    () => {
      clearTimeout(scheduled);
      scheduled = setTimeout(() => ui.changed(), 100);
    },
    { deep: true },
  );
  onScopeDispose(() => {
    clearTimeout(scheduled);
    remove();
    ui.changed();
  });
}
export function uiProjection(
  open: boolean,
  actions: UiComponent['actions'],
  extra: Partial<Projection> = {},
): Projection {
  return {
    mounted: true,
    open,
    visible: open,
    focused: false,
    order: 0,
    loading: false,
    dirty: false,
    interacting: false,
    actions,
    ...extra,
  };
}

/** Unsaved geometry keeps the viewport protected after its drawing gesture ends. */
export function uiViewportProjection(
  actions: UiComponent['actions'],
  extra: Partial<Projection>,
): Projection {
  return uiProjection(true, actions, {
    ...extra,
    ...(extra.interacting
      ? { blocked: 'drawing' as const }
      : extra.dirty
        ? { blocked: 'editing' as const }
        : {}),
  });
}

/** MapLibre owns camera truth; deferred data-query bounds are deliberately excluded. */
export function chartViewportSnapshot(input: {
  map?: { ready: boolean; moving: boolean; drawing: boolean };
  cameraState?: Omit<MapCameraResult, 'commandId'>;
  cameraEvidence?: MapCameraResult;
  target?: { lon: number; lat: number } | null;
  selecting: boolean;
  dirty: boolean;
  revision: number;
}): Projection {
  const { map, cameraState, cameraEvidence, target } = input;
  const bounds = cameraState?.bbox;
  const within =
    !!target &&
    !!bounds &&
    target.lat >= bounds[1] &&
    target.lat <= bounds[3] &&
    (bounds[0] <= bounds[2]
      ? target.lon >= bounds[0] && target.lon <= bounds[2]
      : target.lon >= bounds[0] || target.lon <= bounds[2]);
  return uiViewportProjection(map?.ready ? ['focus'] : [], {
    mounted: !!map?.ready,
    focused: within || !!cameraEvidence,
    dirty: input.dirty,
    interacting: input.selecting || !!map?.moving || !!map?.drawing,
    revision: input.revision,
    ...(cameraState ? { cameraState } : {}),
    ...(cameraEvidence ? { cameraEvidence } : {}),
  });
}

/** Form values are compared locally only; the registry receives a dirty boolean, never values. */
export function useUiReadOnlyEditor(
  open: () => boolean,
  value: () => unknown,
  loading: () => boolean,
) {
  let baseline = JSON.stringify(value());
  watch(
    open,
    (active) => {
      if (active) baseline = JSON.stringify(value());
    },
    { flush: 'sync' },
  );
  useUiComponent('page.editor', {
    read: () =>
      uiProjection(open(), [], {
        loading: loading(),
        dirty: open() && JSON.stringify(value()) !== baseline,
      }),
  });
}
