import { AgentFocusResultSchema } from './agent-focus';
import { AgentVesselTracksResultSchema } from './vessel-tracks';
import { AgentHeatmapResultSchema } from './heatmap';
import { z } from 'zod';
import {
  AgentVesselHighlightsResultSchema,
  AgentMapCameraResultSchema,
  HighlightEvidenceSchema,
  MapCameraResultSchema,
  MapCameraStateSchema,
  HighlightGroupSchema,
} from './agent-map';

/** Semantic IDs only: never accept selectors, scripts, URLs or arbitrary component properties. */
export const UI_COMPONENTS = {
  'app.page': '当前页面',
  'page.list': '当前业务列表',
  'page.editor': '当前业务编辑区',
  'page.detail': '当前业务详情',
  'page.archive': '原文归档预览',
  'intelligence.draft': '人工情报关系草稿',
  'workspace.left': '人工操控面板',
  'workspace.right': '智能协同面板',
  'chart.vessel-tracks': '历史航线',
  'chart.heatmap': '热力图',
  'chart.heatmap.legend': '热力图统计图例',
  'chart.heatmap.popup': '热力图网格详情',
  'chart.layers.ais': '船位图层',
  'chart.layers.tracks': '轨迹图层',
  'chart.layers.evidence': '证据图层',
  'chart.focus': '空间关注',
  'chart.viewport': '海图视野',
  'chart.vessel-highlights': '船舶高亮',
  'agent.reply': 'AI 回复浮卡',
  'agent.input': '补充任务条件',
  'agent.sources': '情报来源详情',
  'chart.evidence': '研判证据详情',
  'chart.choices': '重叠情报选择',
} as const;
export const UiComponentIdSchema = z.enum(
  Object.keys(UI_COMPONENTS) as [keyof typeof UI_COMPONENTS, ...(keyof typeof UI_COMPONENTS)[]],
);
export type UiComponentId = z.infer<typeof UiComponentIdSchema>;
export const UiActionSchema = z.enum(['open', 'close', 'show', 'hide', 'focus', 'tab']);
export type UiAction = z.infer<typeof UiActionSchema>;
export const UiTabSchema = z.enum([
  'search',
  'intelligence',
  'layers',
  'playback',
  'heatmap',
  'history-tracks',
  'prediction',
  'chat',
  'push',
  'tasks',
]);
export const UiBindingSchema = z.strictObject({
  clientId: z.uuid(),
  pageGeneration: z.number().int().positive(),
  tracksVersion: z.number().int().positive().optional(),
  heatmapVersion: z.number().int().positive().optional(),
  highlightsVersion: z.number().int().positive().optional(),
  cameraVersion: z.number().int().positive().optional(),
  focusVersion: z.number().int().positive().optional(),
});
export type UiBinding = z.infer<typeof UiBindingSchema>;
export const UiComponentSchema = z.strictObject({
  id: UiComponentIdSchema,
  version: z.number().int().positive(),
  revision: z.number().int().nonnegative().optional(),
  mounted: z.boolean(),
  open: z.boolean(),
  visible: z.boolean(),
  focused: z.boolean().default(false),
  order: z.number().int().min(0).max(100).default(0),
  loading: z.boolean().default(false),
  dirty: z.boolean().default(false),
  interacting: z.boolean().default(false),
  actions: z.array(UiActionSchema).max(6),
  tab: UiTabSchema.optional(),
  blocked: z.enum(['editing', 'drawing', 'loading', 'unavailable']).optional(),
  highlightEvidence: HighlightEvidenceSchema.optional(),
  highlightGroups: z.array(HighlightGroupSchema).max(100).optional(),
  focusEvidence: z
    .strictObject({
      artifactRef: z.uuid(),
      taskId: z.string(),
      version: z.number().int().nonnegative(),
      inputRevision: z.number().int().nonnegative(),
      displayStatus: z.enum(['complete', 'partial', 'unlocated']),
    })
    .optional(),
  cameraEvidence: MapCameraResultSchema.optional(),
  cameraState: MapCameraStateSchema.optional(),
});
export type UiComponent = z.infer<typeof UiComponentSchema>;
export const UiStateSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  route: z.enum([
    '/',
    '/intelligence',
    '/topics',
    '/routes',
    '/events',
    '/sources',
    '/runs',
    '/replays',
    '/quality',
    '/jobs',
    '/users',
    '/login',
    '/skills',
    'unknown',
  ]),
  components: z
    .array(UiComponentSchema)
    .max(30)
    .refine((a) => new Set(a.map((c) => c.id)).size === a.length, 'Duplicate component'),
});
export type UiState = z.infer<typeof UiStateSchema>;
export const UiRegisterSchema = z.strictObject({ instanceId: z.uuid() });
export const UiUpdateSchema = UiBindingSchema.extend({
  sessionId: z.uuid().nullable(),
  state: UiStateSchema,
});
export const UiOperationSchema = z.strictObject({
  componentId: UiComponentIdSchema,
  action: UiActionSchema,
  tab: UiTabSchema.optional(),
});
export type UiOperation = z.infer<typeof UiOperationSchema>;
export const UiCommandSchema = z.object({
  stepId: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .optional(),
  artifactRef: z.uuid().optional(),
  presentation: AgentHeatmapResultSchema.optional(),
  tracksPresentation: AgentVesselTracksResultSchema.optional(),
  highlightsPresentation: AgentVesselHighlightsResultSchema.optional(),
  cameraPresentation: AgentMapCameraResultSchema.optional(),
  focusPresentation: AgentFocusResultSchema.optional(),
  id: z.uuid(),
  taskId: z.uuid(),
  clientId: z.uuid(),
  pageGeneration: z.number().int().positive(),
  operation: UiOperationSchema,
  expectedVersion: z.number().int().positive(),
  status: z.enum([
    'queued',
    'claimed',
    'executing',
    'succeeded',
    'failed',
    'rejected',
    'cancelled',
    'expired',
    'unknown',
  ]),
  claimToken: z.uuid().optional(),
});
export type UiCommand = z.infer<typeof UiCommandSchema>;
export const UiReceiptSchema = UiBindingSchema.extend({
  stepId: z
    .string()
    .regex(/^[a-z][a-z0-9_-]{0,63}$/)
    .optional(),
  artifactRef: z.uuid().optional(),
  receiptId: z.uuid(),
  claimToken: z.uuid(),
  status: z.enum(['executing', 'succeeded', 'failed', 'rejected']),
  state: UiStateSchema,
  error: z
    .enum(['STATE_CONFLICT', 'POSTCONDITION_FAILED', 'UNAVAILABLE', 'EXECUTION_FAILED'])
    .optional(),
});
export type UiReceipt = z.infer<typeof UiReceiptSchema>;
export const UiResultSchema = z.strictObject({
  kind: z.literal('ui_control'),
  commandId: z.uuid().nullable(),
  status: z.string(),
  components: z.array(UiComponentSchema).max(30),
});

export function uiOperationAllowed(op: UiOperation): boolean {
  if (op.tab && op.action !== 'tab') return false;
  if (op.componentId === 'workspace.left')
    return (
      ['open', 'close'].includes(op.action) ||
      (op.action === 'tab' &&
        [
          'search',
          'intelligence',
          'layers',
          'playback',
          'heatmap',
          'history-tracks',
          'prediction',
        ].includes(op.tab ?? ''))
    );
  if (op.componentId === 'workspace.right')
    return (
      ['open', 'close'].includes(op.action) ||
      (op.action === 'tab' && ['chat', 'push', 'tasks'].includes(op.tab ?? ''))
    );
  if (op.componentId.startsWith('chart.layers.')) return ['show', 'hide'].includes(op.action);
  if (
    op.componentId === 'chart.heatmap' ||
    op.componentId === 'chart.vessel-tracks' ||
    op.componentId === 'chart.vessel-highlights'
  )
    return ['show', 'close'].includes(op.action);
  if (op.componentId === 'chart.focus') return ['show', 'close', 'focus'].includes(op.action);
  if (op.componentId === 'chart.viewport') return op.action === 'focus';
  if (op.componentId === 'agent.input' || op.componentId === 'agent.reply')
    return ['open', 'close'].includes(op.action);
  return (
    ['agent.sources', 'chart.evidence', 'chart.choices', 'chart.heatmap.popup'].includes(
      op.componentId,
    ) && op.action === 'close'
  );
}
export function uiPostcondition(op: UiOperation, state: UiState): boolean {
  const c = state.components.find((c) => c.id === op.componentId);
  if (!c?.mounted) return false;
  if (op.componentId === 'chart.heatmap' && op.action === 'close')
    return (
      !c.open &&
      !c.loading &&
      !c.interacting &&
      ['chart.heatmap.legend', 'chart.heatmap.popup'].every((id) =>
        state.components.some((x) => x.id === id && !x.open),
      )
    );
  if (op.componentId === 'chart.vessel-tracks' && op.action === 'close')
    return !c.open && !c.visible && !c.loading && !c.interacting;
  if (op.action === 'close' || op.action === 'hide') return !c.open && !c.visible;
  if (op.action === 'tab') return c.open && c.tab === op.tab;
  if (op.action === 'focus') return c.focused;
  return c.open && c.visible && !c.loading;
}

/** Verifies command-specific rendered evidence instead of a generic open/focused flag. */
export function uiCommandPostcondition(
  command: UiCommand,
  state: UiState,
  previousState?: UiState,
): boolean {
  const component = state.components.find((item) => item.id === command.operation.componentId);
  if (!component?.mounted || component.loading || component.interacting) return false;
  if (command.operation.componentId === 'chart.focus' && command.operation.action !== 'close') {
    const result = command.focusPresentation,
      evidence = component.focusEvidence;
    return (
      !!result &&
      !!evidence &&
      !!command.artifactRef &&
      evidence.artifactRef === command.artifactRef &&
      evidence.taskId === command.taskId &&
      evidence.version === result.version &&
      evidence.inputRevision === result.inputRevision &&
      (evidence.displayStatus === result.displayStatus ||
        (evidence.displayStatus === 'partial' && result.targets.length > 0))
    );
  }
  if (command.operation.componentId === 'chart.vessel-highlights') {
    const presentation = command.highlightsPresentation,
      evidence = component.highlightEvidence;
    if (!presentation || !command.artifactRef || evidence?.artifactRef !== command.artifactRef)
      return false;
    if (JSON.stringify(component.highlightGroups) !== JSON.stringify(evidence.groups)) return false;
    const unique = new Set(evidence.groups.flatMap((g) => g.mmsis));
    if (
      unique.size > 100 ||
      new Set(evidence.groups.map((g) => g.groupId)).size !== evidence.groups.length
    )
      return false;
    const before =
      previousState?.components.find((item) => item.id === 'chart.vessel-highlights')
        ?.highlightGroups ?? [];
    const normalize = (groups: typeof before) =>
      JSON.stringify(
        groups
          .map((g) => ({ ...g, mmsis: [...g.mmsis].sort() }))
          .sort((a, b) => a.groupId.localeCompare(b.groupId)),
      );
    if (presentation.operation === 'show') {
      const group = evidence.groups.find(
        (g) => g.groupId === command.artifactRef && g.taskId === command.taskId,
      );
      return (
        !!group &&
        JSON.stringify([...group.mmsis].sort()) ===
          JSON.stringify(presentation.vessels.map((v) => v.mmsi).sort()) &&
        normalize(evidence.groups.filter((g) => g.groupId !== command.artifactRef)) ===
          normalize(before.filter((g) => g.groupId !== command.artifactRef))
      );
    }
    return presentation.clear?.mode === 'all'
      ? evidence.groups.length === 0
      : !!presentation.clear &&
          normalize(evidence.groups) ===
            normalize(
              before.filter(
                (g) =>
                  presentation.clear?.mode === 'groups' &&
                  !presentation.clear.groupIds.includes(g.groupId),
              ),
            );
  }
  if (command.operation.componentId === 'chart.viewport' && command.cameraPresentation) {
    const evidence = component.cameraEvidence;
    if (evidence?.commandId !== command.id) return false;
    const request = command.cameraPresentation.request;
    const delta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
    if (request.mode === 'point')
      return (
        delta(evidence.center[0], request.center[0]) < 0.0001 &&
        Math.abs(evidence.center[1] - request.center[1]) < 0.0001 &&
        Math.abs(evidence.zoom - request.zoom) < 0.01
      );
    if (request.mode === 'current') {
      const before = previousState?.components.find((c) => c.id === 'chart.viewport')?.cameraState;
      const zoom =
        request.zoom ??
        (before ? Math.min(22, Math.max(0, before.zoom + request.zoomDelta!)) : undefined);
      return zoom !== undefined && Math.abs(evidence.zoom - zoom) < 0.01;
    }
    const [w, s, e, n] = evidence.bbox,
      [rw, rs, re, rn] = request.bbox;
    const contains = (lon: number) =>
      w <= e ? lon >= w - 0.0001 && lon <= e + 0.0001 : lon >= w - 0.0001 || lon <= e + 0.0001;
    return (
      evidence.zoom <= request.maxZoom + 0.01 &&
      s <= rs + 0.0001 &&
      n >= rn - 0.0001 &&
      contains(rw) &&
      contains(re)
    );
  }
  if (command.operation.componentId === 'chart.viewport' && command.operation.action === 'focus')
    return component.cameraEvidence?.commandId === command.id;
  return uiPostcondition(command.operation, state);
}
