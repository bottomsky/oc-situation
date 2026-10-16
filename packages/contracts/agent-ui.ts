import { AgentHeatmapResultSchema } from './heatmap';
import { z } from 'zod';

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
  'chart.heatmap': '热力图',
  'chart.heatmap.legend': '热力图统计图例',
  'chart.heatmap.popup': '热力图网格详情',
  'chart.layers.ais': '船位图层',
  'chart.layers.tracks': '轨迹图层',
  'chart.layers.evidence': '证据图层',
  'chart.viewport': '海图视野',
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
  'chat',
  'push',
  'tasks',
]);
export const UiBindingSchema = z.strictObject({
  clientId: z.uuid(),
  pageGeneration: z.number().int().positive(),
  heatmapVersion: z.number().int().positive().optional(),
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
});
export type UiComponent = z.infer<typeof UiComponentSchema>;
export const UiStateSchema = z.strictObject({
  sequence: z.number().int().nonnegative(),
  route: z.enum([
    '/',
    '/intelligence',
    '/topics',
    '/sources',
    '/runs',
    '/replays',
    '/quality',
    '/jobs',
    '/users',
    '/login',
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
  presentation: AgentHeatmapResultSchema.optional(),
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
        ['search', 'intelligence', 'layers', 'playback', 'heatmap'].includes(op.tab ?? ''))
    );
  if (op.componentId === 'workspace.right')
    return (
      ['open', 'close'].includes(op.action) ||
      (op.action === 'tab' && ['chat', 'push', 'tasks'].includes(op.tab ?? ''))
    );
  if (op.componentId.startsWith('chart.layers.')) return ['show', 'hide'].includes(op.action);
  if (op.componentId === 'chart.heatmap') return ['show', 'close'].includes(op.action);
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
  if (op.action === 'close' || op.action === 'hide') return !c.open && !c.visible;
  if (op.action === 'tab') return c.open && c.tab === op.tab;
  if (op.action === 'focus') return c.focused;
  return c.open && c.visible && !c.loading;
}
