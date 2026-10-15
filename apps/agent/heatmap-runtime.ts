import { z } from 'zod';
import {
  AgentHeatmapResultSchema,
  HeatmapQuerySchema,
  type AgentHeatmapResult,
} from '../../packages/contracts/heatmap';
import type { AgentSelection, AgentInputSpec } from '../../packages/contracts/agent';
import { CapabilityError, defineTool } from './capabilities';
import { bindBusinessCapability, validateRestoredSkill } from './business-capabilities';
import {
  abortable,
  RuntimeStop,
  type RuntimeContext,
  type RuntimePorts,
  type RuntimeOptions,
} from './runtime';

export async function executeHeatmap(
  context: RuntimeContext,
  selection: AgentSelection,
  ports: RuntimePorts,
  options: RuntimeOptions,
  previous?: AgentHeatmapResult,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, options.runtimeTimeoutMs ?? 180_000);
  const check = async () => {
    if (controller.signal.aborted || !(await ports.active())) throw new RuntimeStop('fenced');
  };
  try {
    const revision = context.task.inputRevision ?? 0;
    let result = context.heatmapResult?.inputRevision === revision ? context.heatmapResult : null;
    if (result && !previous)
      await validateRestoredSkill('ais-heatmap', context, ports, {
        ...options,
        signal: controller.signal,
      });
    if (!result) {
      if (!ports.saveHeatmapResult) throw new RuntimeStop('configuration');
      if (previous) result = { ...previous, version: 0, inputRevision: revision };
      else {
        if (!ports.queryHeatmap) throw new RuntimeStop('configuration');
        const capability = await bindBusinessCapability('ais-heatmap', context, ports, {
          ...options,
          signal: controller.signal,
        });
        await capability.session.readReference('ais-heatmap', 'references/heatmap.md');
        const query = HeatmapQuerySchema.parse({
          bbox: selection.bbox,
          ...selection.timeRange,
          ...(selection.mmsis?.length ? { mmsis: selection.mmsis } : {}),
          ...(selection.filters?.sourceId ? { sourceId: selection.filters.sourceId } : {}),
          ...(selection.filters?.shipType !== undefined
            ? { shipType: selection.filters.shipType }
            : {}),
        });
        const execute = capability.executor([
          defineTool({
            id: 'query_ais_heatmap',
            description: '查询 AIS 独立船舶热力图',
            allowedPhases: ['query'],
            inputSchema: z.strictObject({}),
            outputSchema: AgentHeatmapResultSchema,
            handler: async () => ({
              ...(await ports.queryHeatmap!(query, controller.signal)),
              kind: 'ais_heatmap' as const,
              version: 0,
              inputRevision: revision,
            }),
            project: (output) => ({
              totalVessels: output.totalVessels,
              cellCount: output.cells.length,
              metric: output.metric,
            }),
          }),
        ]);
        result = (await abortable(execute('query_ais_heatmap', 'query', {}), controller.signal))
          .local as AgentHeatmapResult;
      }
      await check();
      const version = await ports.saveHeatmapResult(result);
      if (version === null) throw new RuntimeStop('fenced');
      result = { ...result, version };
    }
    await check();
    const time = (value: string) =>
      new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'short',
        timeStyle: 'short',
      }).format(new Date(value));
    await ports.finish({
      status: 'completed',
      summaryResultVersion: result.version,
      summary: `${previous ? '以下说明基于已保存的热力图快照。' : ''}${time(result.query.from)} 至 ${time(result.query.to)}（北京时间），所选范围共 ${result.totalVessels} 艘独立船舶，形成 ${result.cells.length} 个有数据网格。每格按独立船舶计数，同一船跨格时可出现在多个网格，全域总数单独去重。${result.totalVessels ? '' : '当前条件下没有 AIS 数据。'}船型按当前船舶档案筛选。`,
    });
  } catch (error) {
    const category = (error as { category?: string })?.category;
    const code = timedOut
      ? 'timeout'
      : error instanceof RuntimeStop || error instanceof CapabilityError
        ? error.code
        : (category ?? 'provider');
    if (code === 'fenced' || code === 'cancelled' || (controller.signal.aborted && !timedOut))
      return;
    if (code === 'data_limit' || code === 'retention') {
      const spec: AgentInputSpec = {
        fields: code === 'retention' ? ['time'] : ['region', 'time', 'vessels'],
        reason: code,
      };
      if (ports.requestInput) await ports.requestInput(spec);
      else
        await ports.finish({
          status: 'awaiting_input',
          summary: '请缩小区域或调整时间范围后继续。',
        });
      return;
    }
    await ports.finish({
      status: 'failed',
      errorCode: code === 'budget' ? 'budget_exhausted' : code,
      error:
        code === 'skill_changed'
          ? '本次任务绑定的技能内容已更新，请创建新的尝试；已保存结果仍可查看。'
          : code === 'budget'
            ? '本任务调用预算已用尽，请重试为新任务。'
            : code === 'busy'
              ? '热力图查询服务繁忙，请稍后重试。'
              : code === 'timeout'
                ? '热力图查询超时，请稍后重试。'
                : '热力图查询暂不可用，请检查条件或稍后重试。',
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
