import { describe, expect, it } from 'vitest';
import type { AgentTask, AgentQueryResult } from '../../packages/contracts/agent';
import type { RuntimePorts } from './runtime';
import { createBusinessToolRegistry } from './business-tool-registry';

const selection = {
  bbox: [120, 30, 122, 32] as [number, number, number, number],
  timeRange: { from: '2026-10-16T00:00:00Z', to: '2026-10-16T01:00:00Z' },
  vesselSelector: { shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79] },
};
const task = {
  id: '11111111-1111-4111-8111-111111111111',
  ownerId: '22222222-2222-4222-8222-222222222222',
  inputRevision: 0,
  generation: 1,
  selection,
} as AgentTask;
const vessels: AgentQueryResult = {
  kind: 'vessel_list',
  version: 0,
  inputRevision: 0,
  total: 1,
  truncated: false,
  asOf: '2026-10-16T01:00:00Z',
  selection,
  items: [{ mmsi: '413123456', name: '秘密名称', imo: null, shipType: 70, latestPosition: null }],
};

describe('trusted reusable business adapters', () => {
  it('persists reusable semantic vessel classes and intersects them with the task scope', async () => {
    let selected: unknown;
    const noClass = { ...selection, vesselSelector: undefined };
    const registry = createBusinessToolRegistry(
      { task: { ...task, selection: noClass }, steps: [], results: [] },
      {
        queryVessels: async (_kind: string, scope: unknown) => {
          selected = scope;
          return { ...vessels, selection: scope };
        },
      } as unknown as RuntimePorts,
    );
    await registry.execute('query_vessels', { vesselClass: 'cargo' });
    expect(selected).toMatchObject({
      vesselSelector: { shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79] },
    });
  });
  it('unions persisted classes for bare reuse and intersects the union with a narrower task', async () => {
    const captured: unknown[] = [];
    const ports = {
      queryVessels: async (_kind: string, scope: unknown) => {
        captured.push(scope);
        return { ...vessels, selection: scope };
      },
    } as unknown as RuntimePorts;
    const bare = createBusinessToolRegistry(
      {
        task: { ...task, selection: { ...selection, vesselSelector: undefined } },
        steps: [],
        results: [],
      },
      ports,
    );
    await bare.execute('query_vessels', { vesselClasses: ['cargo', 'tanker'] });
    expect(captured[0]).toMatchObject({
      vesselSelector: { shipTypes: Array.from({ length: 20 }, (_, index) => 70 + index) },
    });
    const narrowed = createBusinessToolRegistry(
      {
        task: { ...task, selection: { ...selection, vesselSelector: { shipTypes: [72, 82] } } },
        steps: [],
        results: [],
      },
      ports,
    );
    await narrowed.execute('query_vessels', { vesselClasses: ['cargo', 'tanker'] });
    expect(captured[1]).toMatchObject({ vesselSelector: { shipTypes: [72, 82] } });
  });
  it('keeps concrete vessel identifiers local while composing dependent tools', async () => {
    let queried: unknown;
    const ports = {
      queryVessels: async () => vessels,
      queryVesselTracks: async (query: unknown) => {
        queried = query;
        return {
          query,
          asOf: '2026-10-16T01:00:00Z',
          generatedAt: '2026-10-16T01:00:00Z',
          shipTypeBasis: 'current_profile',
          selectionBasis: 'historical_observation_in_bbox',
          trackScope: 'full_time_window',
          returnedVessels: 0,
          matchedVesselsLowerBound: 0,
          hasMoreVessels: false,
          tracks: [],
        };
      },
    } as unknown as RuntimePorts;
    const registry = createBusinessToolRegistry({ task, steps: [], results: [] }, ports);
    const queriedVessels = await registry.execute('query_vessels', { selection });
    const output = await registry.execute('query_vessel_tracks', {
      selection,
      vessels: queriedVessels.local,
    });
    expect(queried).toMatchObject({ selector: { mmsis: ['413123456'] } });
    expect(JSON.stringify(output.model)).not.toMatch(/413123456|秘密名称|120|122/);
    expect(registry.descriptors().find((tool) => tool.id === 'query_vessel_tracks')).toMatchObject({
      artifactKinds: ['vessel_tracks'],
      allowedPhases: ['skill'],
    });
  });
  it('rejects scope changes and truncated predecessor sets before running downstream queries', async () => {
    let calls = 0;
    const registry = createBusinessToolRegistry({ task, steps: [], results: [] }, {
      queryHeatmap: async () => {
        calls++;
      },
    } as unknown as RuntimePorts);
    await expect(
      registry.execute('query_ais_heatmap', {
        selection: { ...selection, bbox: [0, 0, 1, 1] },
      }),
    ).rejects.toThrow('scope');
    await expect(
      registry.execute('query_ais_heatmap', {
        selection,
        vessels: { ...vessels, truncated: true, total: 101 },
      }),
    ).rejects.toThrow('data_limit');
    expect(calls).toBe(0);
  });
  it('does not expand an empty predecessor vessel set into an unfiltered heatmap query', async () => {
    let calls = 0;
    const registry = createBusinessToolRegistry({ task, steps: [], results: [] }, {
      queryHeatmap: async () => {
        calls++;
      },
    } as unknown as RuntimePorts);
    const output = await registry.execute('query_ais_heatmap', {
      selection,
      vessels: { ...vessels, items: [], total: 0 },
    });
    expect(calls).toBe(0);
    expect(output.local).toMatchObject({ kind: 'ais_heatmap', totalVessels: 0, cells: [] });
  });
});
