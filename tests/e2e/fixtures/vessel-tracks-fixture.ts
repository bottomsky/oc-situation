import type { Page } from '@playwright/test';
import { UiCommandSchema } from '@ais/contracts';
import type {
  UiBinding,
  UiCommand,
  UiReceipt,
  UiState,
  VesselTracksQuery,
  VesselTracksResult,
} from '@ais/contracts';
import { chartFixture } from './chart-fixture';

export function tracksResult(query?: VesselTracksQuery): VesselTracksResult {
  const now = new Date();
  const q = query ?? {
    bbox: [110, 10, 130, 40],
    from: new Date(+now - 86400000).toISOString(),
    to: now.toISOString(),
    selector: { query: '夹具船舶' },
    maxVessels: 20,
    maxPointsPerVessel: 500,
  };
  return {
    query: q,
    asOf: now.toISOString(),
    generatedAt: now.toISOString(),
    shipTypeBasis: 'current_profile',
    selectionBasis: 'historical_observation_in_bbox',
    trackScope: 'full_time_window',
    returnedVessels: 1,
    matchedVesselsLowerBound: 1,
    hasMoreVessels: false,
    tracks: [
      {
        mmsi: '123456789',
        name: '夹具船舶',
        shipType: 70,
        segments: [
          {
            points: [
              { lon: 121, lat: 31, observedAt: q.from },
              { lon: 122, lat: 32, observedAt: new Date(Date.parse(q.from) + 1000).toISOString() },
            ],
          },
        ],
        total: 2,
        returned: 2,
        sampled: false,
        truncated: false,
      },
    ],
  };
}
export async function vesselTracksFixture(page: Page) {
  await chartFixture(page);
  const requests: VesselTracksQuery[] = [];
  const receipts: UiReceipt[] = [];
  let release: (() => void) | undefined;
  let delay = false;
  let created = false;
  let submitted = false;
  let completed = false;
  let state: UiState | undefined;
  let command: UiCommand | undefined;
  const binding: UiBinding = {
    clientId: '00000000-0000-4000-8000-000000000001',
    pageGeneration: 1,
  };
  const snapshot = tracksResult();
  const taskId = '00000000-0000-4000-8000-000000000003';
  const session = {
    id: '00000000-0000-4000-8000-000000000002',
    ownerId: 'fixture-user',
    title: '历史航线会话',
    createdAt: snapshot.generatedAt,
  };
  const task = () => ({
    id: taskId,
    sessionId: session.id,
    goal: '绘制历史航线',
    status: completed ? 'completed' : 'waiting_ui',
    intent: 'vessel_tracks',
    inputRevision: 1,
    resultInputRevision: 1,
    resultVersion: 1,
    historyHours: 24,
    uiBinding: binding,
    createdAt: snapshot.generatedAt,
    updatedAt: snapshot.generatedAt,
  });
  function issue(action: 'show' | 'close', presentation = false) {
    if (!state) throw new Error('UI 尚未上报状态');
    command = UiCommandSchema.parse({
      id: crypto.randomUUID(),
      taskId,
      clientId: binding.clientId,
      pageGeneration: binding.pageGeneration,
      operation: { componentId: 'chart.vessel-tracks', action },
      expectedVersion: state.components.find((c) => c.id === 'chart.vessel-tracks')!.version,
      status: 'queued',
      ...(presentation
        ? {
            tracksPresentation: {
              ...snapshot,
              kind: 'vessel_tracks',
              version: 1,
              inputRevision: 1,
            },
          }
        : {}),
    });
  }
  await page.route('**/api/v1/map/vessel-tracks/query', async (route) => {
    const query = route.request().postDataJSON() as VesselTracksQuery;
    requests.push(query);
    if (delay)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    await route.fulfill({ json: tracksResult(query) }).catch(() => {});
  });
  await page.route('**/api/v1/agent/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown;
    if (path.endsWith('/config'))
      json = {
        enabled: true,
        uiEnabled: true,
        defaultHistoryHours: 24,
        maxHistoryHours: 168,
        maxModelCalls: 12,
        maxToolCalls: 24,
      };
    else if (path.endsWith('/ui/clients')) json = binding;
    else if (path.endsWith('/state')) {
      state = route.request().postDataJSON().state;
      json = binding;
    } else if (path.endsWith('/commands')) json = { items: command ? [command] : [] };
    else if (path.endsWith('/claim')) json = { ...command, claimToken: crypto.randomUUID() };
    else if (path.endsWith('/receipts')) {
      const receipt = route.request().postDataJSON() as UiReceipt;
      receipts.push(receipt);
      state = receipt.state;
      if (receipt.status !== 'executing') {
        command = undefined;
        completed = true;
      }
      json = {};
    } else if (path.endsWith('/sessions')) {
      if (route.request().method() === 'POST') {
        created = true;
        json = session;
      } else json = { items: created ? [session] : [] };
    } else if (path.endsWith('/messages')) {
      submitted = true;
      completed = false;
      issue('show', true);
      json = {
        task: task(),
        message: {
          id: 'tracks-message',
          sessionId: session.id,
          taskId,
          role: 'user',
          content: '绘制历史航线',
          createdAt: snapshot.generatedAt,
        },
      };
    } else if (path.includes('/events'))
      json = { items: [{ id: String(receipts.length) }], nextCursor: String(receipts.length) };
    else if (path.includes('/tasks/'))
      json = {
        task: task(),
        results: [],
        steps: [],
        tracksResult: { ...snapshot, kind: 'vessel_tracks', version: 1, inputRevision: 1 },
      };
    else json = { session, tasks: submitted ? [task()] : [], messages: [], snapshotCursor: '0' };
    await route.fulfill({ json });
  });
  return {
    requests,
    ready: () => !!state,
    receipts,
    issue,
    delay: () => {
      delay = true;
    },
    release: () => release?.(),
  };
}
