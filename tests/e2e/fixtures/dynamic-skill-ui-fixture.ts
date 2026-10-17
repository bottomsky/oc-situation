import type { Page } from '@playwright/test';
import { UiCommandSchema, UiReceiptSchema, UiStateSchema } from '@ais/contracts';
import type {
  AgentMapCameraResult,
  AgentVesselHighlightsResult,
  UiCommand,
  UiReceipt,
  UiState,
} from '@ais/contracts';
import { chartFixture } from './chart-fixture';
import { tracksResult } from './vessel-tracks-fixture';

/** Runs the actual browser registry against a server that projects immutable step artifacts. */
export async function dynamicSkillUiFixture(page: Page, options: { clusters?: boolean } = {}) {
  await chartFixture(page, { role: 'operator', ...options });
  const client = { clientId: crypto.randomUUID(), pageGeneration: 1 };
  const session = {
    id: crypto.randomUUID(),
    ownerId: 'fixture-user',
    title: '两步骤海图技能',
    createdAt: new Date().toISOString(),
  };
  const taskId = crypto.randomUUID();
  const task = {
    id: taskId,
    sessionId: session.id,
    goal: '依次展示货船航线和热力图',
    intent: 'skill',
    status: 'waiting_ui',
    inputRevision: 1,
    resultInputRevision: 1,
    resultVersion: 1,
    historyHours: 24,
    uiBinding: client,
    createdAt: session.createdAt,
    updatedAt: session.createdAt,
  };
  const tracks = {
    ...tracksResult(),
    kind: 'vessel_tracks' as const,
    inputRevision: 1,
    version: 1,
  };
  const heatmap = {
    kind: 'ais_heatmap' as const,
    inputRevision: 1,
    version: 1,
    query: { bbox: [110, 10, 130, 40], from: tracks.query.from, to: tracks.query.to } as const,
    grid: { level: 7, cellDegrees: 2.8125 },
    cells: [{ id: '7:107:43', x: 107, y: 43, lon: 122.34375, lat: 32.34375, vesselCount: 3 }],
    totalVessels: 3,
    generatedAt: tracks.generatedAt,
    metric: 'unique_vessels' as const,
    shipTypeBasis: 'current_profile' as const,
  };
  let state: UiState | undefined;
  let boundSession: string | null = null;
  let command: UiCommand | undefined;
  let registrations = 0;
  const receipts: (UiReceipt & { commandId: string })[] = [];
  const claims: string[] = [];
  await page.addInitScript(
    (id) => localStorage.setItem('ais-agent-session:fixture-user', id),
    session.id,
  );
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    if (path.endsWith('/config'))
      json = {
        enabled: true,
        uiEnabled: true,
        dynamicSkillsEnabled: true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/ui/clients')) {
      registrations++;
      json = client;
    } else if (path.endsWith('/state')) {
      const body = route.request().postDataJSON();
      state = UiStateSchema.parse(body.state);
      boundSession = body.sessionId;
      json = client;
    } else if (path.endsWith('/commands')) {
      // Discovery only carries identity; rendering data arrives from the claim projection.
      const {
        tracksPresentation: _tracks,
        presentation: _heatmap,
        highlightsPresentation: _highlights,
        cameraPresentation: _camera,
        ...identity
      } = command ?? {};
      json = { items: command ? [identity] : [] };
    } else if (path.endsWith('/claim')) {
      if (!command) throw new Error('No command to claim');
      claims.push(command.id);
      command = UiCommandSchema.parse({
        ...command,
        status: 'claimed',
        claimToken: crypto.randomUUID(),
      });
      json = command;
    } else if (path.endsWith('/receipts')) {
      const receipt = UiReceiptSchema.parse(route.request().postDataJSON());
      const commandId = path.split('/').at(-2)!;
      receipts.push({ ...receipt, commandId });
      state = receipt.state;
      if (receipt.status !== 'executing') command = undefined;
      json = { status: receipt.status };
    } else if (path.endsWith('/sessions')) json = { items: [session] };
    else if (path.endsWith('/events')) json = { items: [], nextCursor: '0' };
    else if (path.includes('/tasks/'))
      json = {
        task,
        results: [],
        steps: [],
        pendingInputRequests: [],
        heatmapResult: null,
        tracksResult: null,
      };
    else
      json = {
        session,
        tasks: [task],
        messages: [],
        pendingInputRequests: [],
        snapshotCursor: '0',
      };
    await route.fulfill({ json });
  });
  function issue(
    kind: 'vessel_tracks' | 'ais_heatmap',
    stepId: string,
    project = true,
    legacy = false,
  ) {
    if (!state || command) throw new Error('UI not ready or previous command unfinished');
    const componentId = kind === 'vessel_tracks' ? 'chart.vessel-tracks' : 'chart.heatmap';
    command = UiCommandSchema.parse({
      id: crypto.randomUUID(),
      taskId,
      ...client,
      stepId,
      ...(legacy ? {} : { artifactRef: crypto.randomUUID() }),
      operation: { componentId, action: 'show' },
      expectedVersion: state.components.find((component) => component.id === componentId)?.version,
      status: 'queued',
      ...(project
        ? kind === 'vessel_tracks'
          ? { tracksPresentation: tracks }
          : { presentation: heatmap }
        : {}),
    });
    return { id: command.id, taskId, stepId, artifactRef: command.artifactRef };
  }
  return {
    receipts,
    claims,
    issue,
    issueMap(value: AgentVesselHighlightsResult | AgentMapCameraResult) {
      if (!state || command) throw new Error('UI not ready or previous command unfinished');
      const camera = value.kind === 'map_camera';
      const componentId = camera ? 'chart.viewport' : 'chart.vessel-highlights';
      command = UiCommandSchema.parse({
        id: crypto.randomUUID(),
        taskId,
        ...client,
        stepId: camera ? 'camera' : 'highlights',
        artifactRef: crypto.randomUUID(),
        operation: {
          componentId,
          action: camera ? 'focus' : value.operation === 'clear' ? 'close' : 'show',
        },
        expectedVersion: state.components.find((component) => component.id === componentId)
          ?.version,
        status: 'queued',
        ...(camera ? { cameraPresentation: value } : { highlightsPresentation: value }),
      });
      return { ...command };
    },
    state: () => state,
    ready: () =>
      registrations > 0 &&
      boundSession === session.id &&
      !!state?.components.some((component) => component.id === 'chart.heatmap') &&
      !!state.components.some((component) => component.id === 'chart.vessel-tracks') &&
      !!state.components.some(
        (component) =>
          component.id === 'chart.viewport' &&
          component.mounted &&
          (component.revision ?? 0) >= 1 &&
          !component.interacting,
      ),
  };
}
