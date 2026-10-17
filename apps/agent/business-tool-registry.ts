import { isDeepStrictEqual } from 'node:util';
import {
  AgentVesselHighlightsResultSchema,
  AgentMapCameraResultSchema,
} from '../../packages/contracts/agent-map';
import { highlightsFromVessels, cameraFromVessels } from '../../packages/domain/agent-map';
import { z } from 'zod';
import { AgentQueryResultSchema, AgentSelectionSchema } from '../../packages/contracts/agent';
import { AgentHeatmapResultSchema, HeatmapQuerySchema } from '../../packages/contracts/heatmap';
import {
  AgentVesselTracksResultSchema,
  VesselTracksQuerySchema,
} from '../../packages/contracts/vessel-tracks';
import { AgentIntelligenceResultSchema } from '../../packages/contracts/intelligence-search';
import type {
  DynamicSkillArtifactKind,
  DynamicSkillToolDescriptor,
} from '../../packages/contracts/dynamic-skills';
import type { RuntimeContext, RuntimePorts } from './runtime';
import { defineTool, type RegisteredTool, type ToolExecutionContext } from './capabilities';

const vesselClassSchema = z.enum(['cargo', 'tanker', 'passenger', 'fishing']);
const inputSchema = z
  .strictObject({
    selection: AgentSelectionSchema.optional(),
    vessels: AgentQueryResultSchema.optional(),
    vesselClass: vesselClassSchema.optional(),
    vesselClasses: z
      .array(vesselClassSchema)
      .min(1)
      .max(4)
      .refine((classes) => new Set(classes).size === classes.length)
      .optional(),
    kind: z.enum(['vessel_list', 'vessel_detail']).optional(),
  })
  .refine(
    (input) => !(input.vesselClass && input.vesselClasses),
    'vessel class forms are mutually exclusive',
  );

export interface BusinessToolAdapter {
  readonly tool: RegisteredTool;
  readonly artifactKind: DynamicSkillArtifactKind;
  readonly artifactKinds: readonly DynamicSkillArtifactKind[];
  readonly recoverableRead: true;
}

/** A single host registry owns validation, implementation and model projection. */
export class BusinessToolRegistry {
  readonly #adapters: ReadonlyMap<string, BusinessToolAdapter>;
  constructor(
    adapters: readonly BusinessToolAdapter[],
    readonly context: ToolExecutionContext,
  ) {
    this.#adapters = new Map(adapters.map((adapter) => [adapter.tool.id, adapter]));
  }
  get(id: string): BusinessToolAdapter {
    const adapter = this.#adapters.get(id);
    if (!adapter) throw new Error('unregistered_tool');
    return adapter;
  }
  descriptors(): DynamicSkillToolDescriptor[] {
    return [...this.#adapters.values()].map(({ tool, artifactKinds }) => ({
      id: tool.id,
      artifactKinds,
      allowedPhases: ['skill'],
    }));
  }
  async execute(id: string, input: unknown): Promise<{ local: unknown; model: unknown }> {
    const { tool } = this.get(id);
    const parsed = tool.inputSchema.parse(input);
    // The adapter closure carries the actual host identity; callers cannot supply one.
    const output = tool.outputSchema.parse(await tool.handler(parsed, this.context));
    return { local: output, model: tool.project(output) };
  }
}

export function createBusinessToolRegistry(
  context: RuntimeContext,
  ports: RuntimePorts,
  signal?: AbortSignal,
): BusinessToolRegistry {
  const selection = context.task.selection ?? {};
  const revision = context.task.inputRevision ?? 0;
  const adapters: BusinessToolAdapter[] = [];
  const scoped = (input: z.infer<typeof inputSchema>) => {
    if (input.selection && !isDeepStrictEqual(input.selection, selection))
      throw new Error('task_scope_mismatch');
    if (input.vessels?.truncated) throw new Error('data_limit');
    return selection;
  };
  const add = (artifactKind: DynamicSkillArtifactKind, tool: RegisteredTool) =>
    adapters.push({
      tool,
      artifactKind,
      artifactKinds:
        tool.id === 'query_vessels' ? ['vessel_list', 'vessel_detail'] : [artifactKind],
      recoverableRead: true,
    });
  const detailQuery =
    context.task.intent === 'vessel_detail' || selection.purpose === 'vessel_detail';
  const mapVessels = async (input: z.infer<typeof inputSchema>) => {
    const scope = scoped(input);
    if (input.vessels) return input.vessels;
    if (!ports.queryVessels) throw new Error('configuration');
    const explicit =
      scope.mmsis?.length ||
      scope.vesselSelector?.mmsis?.length ||
      scope.vesselSelector?.query ||
      scope.vesselSelector?.model;
    if (!explicit && !scope.bbox) throw new Error('region_required');
    const effective = {
      ...scope,
      ...(explicit ? { bbox: undefined } : {}),
      filters: { ...scope.filters, hours: 720 },
    };
    const result = await ports.queryVessels(explicit ? 'vessel_detail' : 'vessel_list', effective);
    if (
      scope.vesselSelector?.query &&
      result.items.length > 1 &&
      !/全部|所有|这些|多艘/.test(context.task.goal)
    )
      throw new Error('ambiguous_vessels');
    return result;
  };
  add(
    'vessel_highlights',
    defineTool({
      id: 'prepare_vessel_highlights',
      description: '准备任务船舶高亮或清除当前页面的高亮组',
      allowedPhases: ['query', 'skill'],
      inputSchema,
      outputSchema: AgentVesselHighlightsResultSchema,
      handler: async (input) => {
        const scope = scoped(input);
        if (scope.highlightClear)
          return {
            kind: 'vessel_highlights' as const,
            version: 0,
            inputRevision: revision,
            operation: 'clear' as const,
            vessels: [],
            missingMmsis: [],
            clear: scope.highlightClear,
          };
        if (scope.highlightTaskIndex || scope.highlightClearUnclear) {
          const groups = await ports.readHighlightGroups?.();
          if (!groups) throw new Error('configuration');
          let groupIds: string[];
          if (scope.highlightTaskIndex) {
            const group = groups[scope.highlightTaskIndex - 1];
            if (!group) throw new Error('ambiguous_vessels');
            groupIds = [group.groupId];
          } else {
            const query = await mapVessels(input);
            if (query.truncated || query.total > 100) throw new Error('data_limit');
            const selected = new Set(query.items.map((v) => v.mmsi));
            const matching = groups.filter((g) => g.mmsis.some((id) => selected.has(id)));
            if (!matching.length || matching.some((g) => g.mmsis.some((id) => !selected.has(id))))
              throw new Error('ambiguous_vessels');
            groupIds = matching.map((g) => g.groupId);
          }
          return {
            kind: 'vessel_highlights' as const,
            version: 0,
            inputRevision: revision,
            operation: 'clear' as const,
            vessels: [],
            missingMmsis: [],
            clear: { mode: 'groups' as const, groupIds },
          };
        }
        return highlightsFromVessels(await mapVessels(input), revision);
      },
      project: (output) => ({
        operation: output.operation,
        targetCount: output.vessels.length,
        missingCount: output.missingMmsis.length,
      }),
    }),
  );
  add(
    'map_camera',
    defineTool({
      id: 'prepare_map_camera',
      description: '准备点位、区域、多船或当前海图的镜头聚焦与缩放',
      allowedPhases: ['query', 'skill'],
      inputSchema,
      outputSchema: AgentMapCameraResultSchema,
      handler: async (input) => {
        const scope = scoped(input);
        let request = scope.mapCamera ?? cameraFromVessels(await mapVessels(input));
        if (scope.mapTargetZoom !== undefined)
          request =
            request.mode === 'point'
              ? { ...request, zoom: scope.mapTargetZoom }
              : request.mode === 'bounds'
                ? { ...request, maxZoom: scope.mapTargetZoom }
                : request;
        return { kind: 'map_camera' as const, version: 0, inputRevision: revision, request };
      },
      project: (output) => ({ mode: output.request.mode }),
    }),
  );
  if (ports.queryVessels)
    add(
      detailQuery ? 'vessel_detail' : 'vessel_list',
      defineTool({
        id: 'query_vessels',
        description: '查询任务范围内船舶快照',
        allowedPhases: ['query', 'skill'],
        inputSchema,
        outputSchema: AgentQueryResultSchema,
        handler: async (input) => {
          let scope = scoped(input);
          const queryKind = input.kind ?? (detailQuery ? 'vessel_detail' : 'vessel_list');
          if (input.vessels)
            scope = { ...scope, mmsis: input.vessels.items.map((vessel) => vessel.mmsi) };
          const classes = input.vesselClasses ?? (input.vesselClass ? [input.vesselClass] : []);
          if (classes.length) {
            const ranges = {
              cargo: [70, 79],
              tanker: [80, 89],
              passenger: [60, 69],
              fishing: [30, 30],
            } as const;
            const types = classes
              .flatMap((vesselClass) => {
                const [first, last] = ranges[vesselClass];
                return Array.from({ length: last - first + 1 }, (_, index) => first + index);
              })
              .sort((a, b) => a - b);
            const intersection = scope.vesselSelector?.shipTypes
              ? types.filter((type) => scope.vesselSelector!.shipTypes!.includes(type))
              : types;
            if (!intersection.length)
              return {
                kind: queryKind,
                version: 0,
                inputRevision: revision,
                total: 0,
                truncated: false,
                items: [],
                asOf: new Date().toISOString(),
                selection: scope,
              };
            scope = {
              ...scope,
              vesselSelector: { ...scope.vesselSelector, shipTypes: intersection },
            };
          }
          if (input.vessels && !input.vessels.items.length)
            return {
              kind: queryKind,
              version: 0,
              inputRevision: revision,
              total: 0,
              truncated: false,
              items: [],
              asOf: input.vessels.asOf,
              selection: scope,
            };
          return ports.queryVessels!(queryKind, scope);
        },
        project: (output) => ({ total: output.total, truncated: output.truncated }),
      }),
    );
  if (ports.queryVesselTracks)
    add(
      'vessel_tracks',
      defineTool({
        id: 'query_vessel_tracks',
        description: '查询任务范围内船舶历史航线',
        allowedPhases: ['query', 'skill'],
        inputSchema,
        outputSchema: AgentVesselTracksResultSchema,
        handler: async (input) => {
          const scope = scoped(input);
          const mmsis = input.vessels?.items.map((vessel) => vessel.mmsi);
          const query = VesselTracksQuerySchema.parse({
            bbox: scope.bbox,
            ...scope.timeRange,
            selector: mmsis?.length ? { mmsis } : scope.vesselSelector,
            ...(scope.filters?.sourceId ? { sourceId: scope.filters.sourceId } : {}),
          });
          const result =
            mmsis && !mmsis.length
              ? {
                  query,
                  asOf: input.vessels!.asOf,
                  generatedAt: input.vessels!.asOf,
                  shipTypeBasis: 'current_profile' as const,
                  selectionBasis: 'historical_observation_in_bbox' as const,
                  trackScope: 'full_time_window' as const,
                  returnedVessels: 0,
                  matchedVesselsLowerBound: 0,
                  hasMoreVessels: false,
                  tracks: [],
                }
              : await ports.queryVesselTracks!(query, signal);
          return { ...result, kind: 'vessel_tracks' as const, version: 0, inputRevision: revision };
        },
        project: (output) => ({
          returnedVessels: output.returnedVessels,
          hasMoreVessels: output.hasMoreVessels,
        }),
      }),
    );
  if (ports.queryHeatmap)
    add(
      'ais_heatmap',
      defineTool({
        id: 'query_ais_heatmap',
        description: '查询任务范围内船舶热力图',
        allowedPhases: ['query', 'skill'],
        inputSchema,
        outputSchema: AgentHeatmapResultSchema,
        handler: async (input) => {
          const scope = scoped(input);
          const mmsis = input.vessels?.items.map((vessel) => vessel.mmsi) ?? scope.mmsis;
          const query = HeatmapQuerySchema.parse({
            bbox: scope.bbox,
            ...scope.timeRange,
            ...(mmsis ? { mmsis } : {}),
            ...(scope.filters?.sourceId ? { sourceId: scope.filters.sourceId } : {}),
            ...(scope.filters?.shipType !== undefined ? { shipType: scope.filters.shipType } : {}),
          });
          const result =
            mmsis && !mmsis.length
              ? {
                  query,
                  grid: { level: 0, cellDegrees: 360 },
                  cells: [],
                  totalVessels: 0,
                  generatedAt: input.vessels!.asOf,
                  metric: 'unique_vessels' as const,
                  shipTypeBasis: 'current_profile' as const,
                }
              : await ports.queryHeatmap!(query, signal);
          return { ...result, kind: 'ais_heatmap' as const, version: 0, inputRevision: revision };
        },
        project: (output) => ({
          totalVessels: output.totalVessels,
          cellCount: output.cells.length,
          metric: output.metric,
        }),
      }),
    );
  if (ports.searchIntelligence)
    add(
      'intelligence_search',
      defineTool({
        id: 'search_intelligence',
        description: '检索任务范围内本地情报',
        allowedPhases: ['query', 'skill'],
        inputSchema,
        outputSchema: AgentIntelligenceResultSchema,
        handler: (input) => ports.searchIntelligence!(scoped(input)),
        project: (output) => ({ total: output.total, truncated: output.truncated }),
      }),
    );
  return new BusinessToolRegistry(adapters, {
    identity: {
      ownerId: context.task.ownerId,
      taskId: context.task.id,
      inputRevision: revision,
      generation: context.task.generation,
    },
    phase: 'skill',
    signal,
  });
}
