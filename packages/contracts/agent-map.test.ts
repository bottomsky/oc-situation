import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UiCommandSchema, UiStateSchema, uiCommandPostcondition, type UiState } from './agent-ui';
import type { HighlightGroup } from './agent-map';

const group = (mmsi = '123456789'): HighlightGroup => ({
  groupId: randomUUID(),
  taskId: randomUUID(),
  mmsis: [mmsi],
});
const state = (groups: HighlightGroup[], artifactRef: string) =>
  UiStateSchema.parse({
    sequence: 1,
    route: '/',
    components: [
      {
        id: 'chart.vessel-highlights',
        version: 1,
        mounted: true,
        open: groups.length > 0,
        visible: groups.length > 0,
        actions: ['show', 'close'],
        highlightGroups: groups,
        highlightEvidence: { artifactRef, groups },
      },
    ],
  });
const command = () =>
  UiCommandSchema.parse({
    id: randomUUID(),
    taskId: randomUUID(),
    clientId: randomUUID(),
    pageGeneration: 1,
    artifactRef: randomUUID(),
    operation: { componentId: 'chart.vessel-highlights', action: 'show' },
    expectedVersion: 1,
    status: 'executing',
    highlightsPresentation: {
      kind: 'vessel_highlights',
      version: 0,
      inputRevision: 0,
      operation: 'show',
      vessels: [
        { mmsi: '123456789', name: null, lon: 120, lat: 30, observedAt: new Date().toISOString() },
      ],
      missingMmsis: [],
    },
  });
describe('command-specific map evidence', () => {
  it('requires artifact identity, exact targets and preservation of other groups', () => {
    const c = command(),
      old = group('987654321'),
      added = { groupId: c.artifactRef!, taskId: c.taskId, mmsis: ['123456789'] };
    const before = state([old], old.groupId);
    expect(uiCommandPostcondition(c, state([old, added], c.artifactRef!), before)).toBe(true);
    expect(uiCommandPostcondition(c, state([added], c.artifactRef!), before)).toBe(false);
    expect(
      uiCommandPostcondition(
        c,
        state([old, { ...added, mmsis: ['111111111'] }], c.artifactRef!),
        before,
      ),
    ).toBe(false);
    expect(uiCommandPostcondition(c, state([old, added], randomUUID()), before)).toBe(false);
  });
  it('clears one group while requiring all unrelated groups to remain', () => {
    const c = command(),
      old = group(),
      keep = group('987654321');
    c.operation.action = 'close';
    c.highlightsPresentation = {
      kind: 'vessel_highlights',
      version: 0,
      inputRevision: 0,
      operation: 'clear',
      vessels: [],
      missingMmsis: [],
      clear: { mode: 'groups', groupIds: [old.groupId] },
    };
    const before = state([old, keep], old.groupId);
    expect(uiCommandPostcondition(c, state([keep], c.artifactRef!), before)).toBe(true);
    expect(uiCommandPostcondition(c, state([], c.artifactRef!), before)).toBe(false);
  });
  it('validates camera actual position and command id, with before-state relative zoom', () => {
    const c = command();
    c.operation = { componentId: 'chart.viewport', action: 'focus' };
    c.highlightsPresentation = undefined;
    c.cameraPresentation = {
      kind: 'map_camera',
      version: 0,
      inputRevision: 0,
      request: { mode: 'current', zoomDelta: 2 },
    };
    const before = UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'chart.viewport',
          version: 1,
          mounted: true,
          open: true,
          visible: true,
          actions: ['focus'],
          cameraState: { center: [120, 30], zoom: 7, bbox: [119, 29, 121, 31] },
        },
      ],
    });
    const after: UiState = structuredClone(before);
    after.components[0]!.cameraEvidence = {
      commandId: c.id,
      center: [120, 30],
      zoom: 9,
      bbox: [119, 29, 121, 31],
    };
    expect(uiCommandPostcondition(c, after, before)).toBe(true);
    expect(uiCommandPostcondition(c, after)).toBe(false);
    after.components[0]!.cameraEvidence!.commandId = randomUUID();
    expect(uiCommandPostcondition(c, after, before)).toBe(false);
  });
  it('handles wrapped bounds and rejects insufficient visible area', () => {
    const c = command();
    c.operation = { componentId: 'chart.viewport', action: 'focus' };
    c.cameraPresentation = {
      kind: 'map_camera',
      version: 0,
      inputRevision: 0,
      request: { mode: 'bounds', bbox: [179, -1, -179, 1], maxZoom: 10 },
    };
    const after = UiStateSchema.parse({
      sequence: 2,
      route: '/',
      components: [
        {
          id: 'chart.viewport',
          version: 2,
          mounted: true,
          open: true,
          visible: true,
          actions: ['focus'],
          cameraEvidence: { commandId: c.id, center: [180, 0], zoom: 8, bbox: [178, -2, -178, 2] },
        },
      ],
    });
    expect(uiCommandPostcondition(c, after)).toBe(true);
    after.components[0]!.cameraEvidence!.bbox = [179.5, -2, -179.5, 2];
    expect(uiCommandPostcondition(c, after)).toBe(false);
  });
});
