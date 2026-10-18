import { randomUUID } from 'node:crypto';
import type { AgentQueryResult } from '../../packages/contracts/agent';
import { z } from 'zod';
import {
  AgentVesselHighlightsResultSchema,
  AgentMapCameraResultSchema,
} from '../../packages/contracts/agent-map';
import { requiredAgentInputFields } from '../../packages/domain/agent-intents';
import { bindBusinessCapability, validateRestoredSkill } from './business-capabilities';
import { createBusinessToolRegistry } from './business-tool-registry';
import { abortable, type RuntimeContext, type RuntimePorts, type RuntimeOptions } from './runtime';

const savedSchema = z.strictObject({
  artifactRef: z.uuid(),
  payload: z.union([AgentVesselHighlightsResultSchema, AgentMapCameraResultSchema]),
});
/** Durable builtin map steps use the same artifact/command/evidence pipeline as dynamic skills. */
export async function executeMapSkill(
  context: RuntimeContext,
  ports: RuntimePorts,
  options: RuntimeOptions,
) {
  const selection = context.task.selection ?? {};
  const intent = context.task.intent!;
  const parentSignal = options.signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  if (parentSignal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.runtimeTimeoutMs ?? 180_000);
  options = { ...options, signal: controller.signal };
  let preparedHighlights: z.infer<typeof AgentVesselHighlightsResultSchema> | undefined;
  try {
    const fields = requiredAgentInputFields(selection, intent);
    if (fields.length) {
      if (ports.requestInput)
        await ports.requestInput({ fields, reason: 'missing_vessel_selector' });
      else
        await ports.finish({
          status: 'awaiting_input',
          summary: '请提供船舶 MMSI、名称、船型或镜头目标。',
        });
      return;
    }
    if (!context.task.uiBinding || !ports.mapUi) throw new Error('ui_unavailable');
    const steps =
      intent === 'map_camera'
        ? ['map_camera']
        : selection.highlightAndFocus &&
            !selection.highlightClear &&
            !selection.highlightTaskIndex &&
            !selection.highlightClearUnclear
          ? ['vessel_highlights', 'map_camera']
          : ['vessel_highlights'];
    let missingMmsis: string[] = [];
    for (const kind of steps) {
      const skillId = kind === 'map_camera' ? 'map-camera' : 'vessel-highlight';
      const toolId = kind === 'map_camera' ? 'prepare_map_camera' : 'prepare_vessel_highlights';
      const stepId = `map_${kind}`;
      let saved = savedSchema.safeParse(context.steps.find((s) => s.key === stepId)?.output).data;
      if (saved) await validateRestoredSkill(skillId, context, ports, options);
      else {
        const capability = await bindBusinessCapability(skillId, context, ports, options);
        let vesselSnapshot: AgentQueryResult | undefined;
        const registry = createBusinessToolRegistry(
          context,
          {
            ...ports,
            queryVessels: ports.queryVessels
              ? async (kind, selection) => {
                  const result = await ports.queryVessels!(kind, selection);
                  vesselSnapshot = result;
                  return result;
                }
              : undefined,
          },
          options.signal,
        );
        const execute = capability.executor([registry.get(toolId).tool]);
        const input =
          kind === 'map_camera' && preparedHighlights
            ? {
                vessels: {
                  kind: 'vessel_list',
                  version: 0,
                  inputRevision: context.task.inputRevision ?? 0,
                  total: preparedHighlights.vessels.length,
                  truncated: false,
                  items: preparedHighlights.vessels.map((v) => ({
                    mmsi: v.mmsi,
                    name: v.name,
                    imo: null,
                    shipType: null,
                    latestPosition: {
                      lat: v.lat,
                      lon: v.lon,
                      observedAt: v.observedAt,
                      sogKnots: null,
                      sourceId: 'highlight-snapshot',
                    },
                  })),
                  asOf: new Date().toISOString(),
                  selection,
                },
              }
            : {};
        const result = await abortable(execute(toolId, 'query', input), controller.signal);
        if (
          vesselSnapshot &&
          !(await ports.saveStep('map_vessel_snapshot', '地图对象快照', vesselSnapshot))
        )
          return;
        saved = savedSchema.parse({ artifactRef: randomUUID(), payload: result.local });
        if (!(await ports.active()) || !(await ports.saveStep(stepId, skillId, saved))) return;
      }
      if (saved.payload.kind === 'vessel_highlights') {
        missingMmsis = saved.payload.missingMmsis;
        preparedHighlights = saved.payload;
      }
      const command = await ports.mapUi.command(stepId);
      if (command?.status === 'succeeded') continue;
      if (command && !['queued', 'claimed', 'executing'].includes(command.status))
        throw new Error(`ui_${command.status}`);
      if (!command)
        await ports.mapUi.queue(stepId, saved.artifactRef, {
          componentId: kind === 'map_camera' ? 'chart.viewport' : 'chart.vessel-highlights',
          action:
            kind === 'map_camera'
              ? 'focus'
              : saved.payload.kind === 'vessel_highlights' && saved.payload.operation === 'clear'
                ? 'close'
                : 'show',
        });
      return;
    }
    await ports.finish({
      status: 'completed',
      summary: `${preparedHighlights?.operation === 'clear' ? '已清除指定船舶高亮' : intent === 'map_camera' ? '海图镜头已调整' : selection.highlightAndFocus ? '船舶已高亮并聚焦' : '船舶已高亮，高亮标记将跟随最新 AIS 船位，直到本页主动清除'}。${missingMmsis.length ? `以下船舶缺少有效船位，未高亮：${missingMmsis.join('、')}。` : ''}`,
    });
  } catch (error) {
    const candidate =
      (error as { code?: string }).code ?? (error instanceof Error ? error.message : 'map_failed');
    const code = timedOut ? 'timeout' : /^[a-z_]{1,60}$/.test(candidate) ? candidate : 'map_failed';
    if (code === 'fenced' || (options.signal?.aborted && !timedOut)) return;
    if (
      ['data_limit', 'ambiguous_vessels', 'region_required'].includes(code) &&
      ports.requestInput
    ) {
      await ports.requestInput({
        fields: code === 'region_required' ? ['region'] : ['vessel_selector'],
        reason:
          code === 'data_limit'
            ? 'data_limit'
            : code === 'region_required'
              ? 'missing_region'
              : 'missing_vessel_selector',
      });
      return;
    }
    await ports.finish({
      status: 'failed',
      errorCode: code,
      error:
        code === 'no_positions'
          ? '目标船舶没有最近 30 天内的有效位置，无法高亮或聚焦。'
          : code.startsWith('ui_')
            ? '海图操作未完成：当前页面不可用、状态已改变或人工操作中断，请在当前页面重试。'
            : '船舶高亮或镜头操作未完成，请核对目标和页面状态后重试。',
    });
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}
