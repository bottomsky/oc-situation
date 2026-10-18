import { loadSkillCatalog, type SkillCatalog, type SkillToolBinding } from './catalog';
import { CapabilityError } from './errors';
import type { CapabilityDirectoryEntry, CapabilityRoutingMetadata } from './metadata';

const ROUTING: Readonly<Record<string, CapabilityRoutingMetadata>> = Object.freeze({
  'map-focus': {
    intents: ['map_focus'],
    requiredInputs: { map_focus: [] },
    executionMode: 'local',
    available: true,
  },
  'route-plan': {
    intents: ['route_plan'],
    requiredInputs: { route_plan: [] },
    executionMode: 'local',
    available: true,
  },
  'route-manage': {
    intents: ['route_manage'],
    requiredInputs: { route_manage: [] },
    executionMode: 'local',
    available: true,
  },
  'event-query': {
    intents: ['event_query'],
    requiredInputs: { event_query: [] },
    executionMode: 'local',
    available: true,
  },
  'event-manage': {
    intents: ['event_manage'],
    requiredInputs: { event_manage: [] },
    executionMode: 'local',
    available: true,
  },

  'vessel-highlight': Object.freeze({
    intents: Object.freeze(['vessel_highlights'] as const),
    requiredInputs: Object.freeze({ vessel_highlights: Object.freeze([]) }),
    executionMode: 'local',
    available: true,
  }),
  'map-camera': Object.freeze({
    intents: Object.freeze(['map_camera'] as const),
    requiredInputs: Object.freeze({ map_camera: Object.freeze([]) }),
    executionMode: 'local',
    available: true,
  }),
  'ui-control': Object.freeze({
    intents: Object.freeze(['ui_control'] as const),
    requiredInputs: Object.freeze({ ui_control: Object.freeze([]) }),
    executionMode: 'local',
    available: true,
  }),
  'ais-heatmap': Object.freeze({
    intents: Object.freeze(['ais_heatmap'] as const),
    requiredInputs: Object.freeze({ ais_heatmap: Object.freeze(['region', 'time'] as const) }),
    executionMode: 'local',
    available: true,
  }),
  'vessel-tracks': Object.freeze({
    intents: Object.freeze(['vessel_tracks'] as const),
    requiredInputs: Object.freeze({
      vessel_tracks: Object.freeze(['region', 'time', 'vessel_selector'] as const),
    }),
    executionMode: 'local',
    available: true,
  }),
  'vessel-query': Object.freeze({
    intents: Object.freeze(['vessel_list', 'vessel_detail'] as const),
    requiredInputs: Object.freeze({
      vessel_list: Object.freeze(['region'] as const),
      vessel_detail: Object.freeze(['vessels'] as const),
    }),
    executionMode: 'local',
    available: true,
  }),
  'intelligence-search': Object.freeze({
    intents: Object.freeze(['intelligence_search'] as const),
    requiredInputs: Object.freeze({ intelligence_search: Object.freeze(['topic'] as const) }),
    executionMode: 'model',
    available: true,
  }),
  'region-analysis': Object.freeze({
    intents: Object.freeze(['analysis'] as const),
    requiredInputs: Object.freeze({ analysis: Object.freeze(['goal', 'region', 'time'] as const) }),
    executionMode: 'legacy',
    available: true,
  }),
});

export function getBuiltinCapabilityMetadata(capabilityId: string): CapabilityRoutingMetadata {
  const metadata = ROUTING[capabilityId];
  if (!metadata) throw new CapabilityError('configuration', 'unknown capability metadata');
  return metadata;
}

export const BUILTIN_SKILL_BINDINGS: readonly SkillToolBinding[] = Object.freeze([
  {
    skillId: 'map-focus',
    version: '1.0.1',
    adapterVersion: '1',
    toolIds: ['prepare_map_focus'],
    referencePaths: [],
  },
  {
    skillId: 'route-plan',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: ['query_routes', 'read_route', 'plan_route'],
    referencePaths: [],
  },
  {
    skillId: 'route-manage',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: ['create_route', 'update_route'],
    referencePaths: [],
  },
  {
    skillId: 'event-query',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: ['query_events', 'read_event'],
    referencePaths: [],
  },
  {
    skillId: 'event-manage',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: ['create_event', 'update_event'],
    referencePaths: [],
  },

  Object.freeze({
    skillId: 'vessel-highlight',
    version: '1.0.1',
    adapterVersion: '1',
    toolIds: Object.freeze(['prepare_vessel_highlights']),
    referencePaths: Object.freeze([]),
  }),
  Object.freeze({
    skillId: 'map-camera',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze(['prepare_map_camera']),
    referencePaths: Object.freeze([]),
  }),
  Object.freeze({
    skillId: 'ui-control',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze([
      'ui.list_capabilities',
      'ui.get_state',
      'ui.execute',
      'ui.get_command',
    ]),
    referencePaths: Object.freeze([]),
  }),
  Object.freeze({
    skillId: 'ais-heatmap',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze(['query_ais_heatmap']),
    referencePaths: Object.freeze(['references/heatmap.md']),
  }),
  Object.freeze({
    skillId: 'vessel-tracks',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze(['query_vessel_tracks']),
    referencePaths: Object.freeze(['references/tracks.md']),
  }),
  Object.freeze({
    skillId: 'vessel-query',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze(['query_vessels']),
    referencePaths: Object.freeze(['references/vessels.md']),
  }),
  Object.freeze({
    skillId: 'intelligence-search',
    version: '1.0.0',
    adapterVersion: '1',
    toolIds: Object.freeze([
      'search_intelligence',
      'read_intelligence',
      'read_marine_forecast',
      'get_intelligence_source_status',
    ]),
    referencePaths: Object.freeze(['references/intelligence.md']),
  }),
]);

/** Public discovery metadata also keeps the pre-skill regional workflow visible. */
export function buildCapabilityDirectory(
  catalog: SkillCatalog,
): readonly CapabilityDirectoryEntry[] {
  return Object.freeze([
    ...catalog.list().map((metadata) =>
      Object.freeze({
        id: metadata.skillId,
        ...getBuiltinCapabilityMetadata(metadata.skillId),
        skillId: metadata.skillId,
        description: metadata.description,
        legacy: false,
      }),
    ),
    Object.freeze({
      id: 'region-analysis',
      ...getBuiltinCapabilityMetadata('region-analysis'),
      description: '沿用现有区域研判流程，综合区域 AIS 与专题规则形成研判结果。',
      legacy: true,
    }),
  ]);
}

export function loadBuiltinSkillCatalog(root?: string) {
  return loadSkillCatalog({ root, bindings: BUILTIN_SKILL_BINDINGS });
}
