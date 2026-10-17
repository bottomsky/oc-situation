import { z } from 'zod';
import {
  AgentVesselTracksResultSchema,
  VesselTracksQuerySchema,
  type AgentVesselTracksResult,
} from '../../packages/contracts/vessel-tracks';
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

export async function executeVesselTracks(
  context: RuntimeContext,
  selection: AgentSelection,
  ports: RuntimePorts,
  options: RuntimeOptions,
  previous?: AgentVesselTracksResult,
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
    let result = context.tracksResult?.inputRevision === revision ? context.tracksResult : null;
    if (result && !previous)
      await validateRestoredSkill('vessel-tracks', context, ports, {
        ...options,
        signal: controller.signal,
      });
    if (!result) {
      if (!ports.saveTracksResult) throw new RuntimeStop('configuration');
      if (previous) result = { ...previous, version: 0, inputRevision: revision };
      else {
        if (!ports.queryVesselTracks) throw new RuntimeStop('configuration');
        const capability = await bindBusinessCapability('vessel-tracks', context, ports, {
          ...options,
          signal: controller.signal,
        });
        await capability.session.readReference('vessel-tracks', 'references/tracks.md');
        const query = VesselTracksQuerySchema.parse({
          bbox: selection.bbox,
          ...selection.timeRange,
          selector: selection.vesselSelector,
          ...(selection.filters?.sourceId ? { sourceId: selection.filters.sourceId } : {}),
        });
        const execute = capability.executor([
          defineTool({
            id: 'query_vessel_tracks',
            description: '查询 AIS 独立船舶历史航线',
            allowedPhases: ['query'],
            inputSchema: z.strictObject({}),
            outputSchema: AgentVesselTracksResultSchema,
            handler: async () => ({
              ...(await ports.queryVesselTracks!(query, controller.signal)),
              kind: 'vessel_tracks' as const,
              version: 0,
              inputRevision: revision,
            }),
            project: (output) => ({
              returnedVessels: output.returnedVessels,
              hasMoreVessels: output.hasMoreVessels,
            }),
          }),
        ]);
        result = (await abortable(execute('query_vessel_tracks', 'query', {}), controller.signal))
          .local as AgentVesselTracksResult;
      }
      await check();
      const version = await ports.saveTracksResult(result);
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
    const sampled = result.tracks.filter((track) => track.sampled).length;
    const truncated = result.tracks.filter((track) => track.truncated).length;
    await ports.finish({
      status: 'completed',
      summaryResultVersion: result.version,
      summary: `${previous ? '以下说明基于已保存的历史航线快照。' : ''}${time(result.query.from)} 至 ${time(result.query.to)}（北京时间），返回 ${result.returnedVessels} 艘船舶的历史航线。${result.hasMoreVessels ? '存在更多符合条件的船舶，可缩小范围继续查询。' : ''}${result.returnedVessels ? '' : '当前条件下没有匹配航线。'}${sampled ? `其中 ${sampled} 条航线已采样。` : ''}${truncated ? `其中 ${truncated} 条航线因点数上限截断，部分航段未展示。` : ''}候选按区域内历史观测选取，按完整时间窗口查询航线；船型按当前档案筛选。`,
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
        fields: code === 'retention' ? ['time'] : ['region', 'time', 'vessel_selector'],
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
              ? '历史航线查询服务繁忙，请稍后重试。'
              : code === 'timeout'
                ? '历史航线查询超时，请稍后重试。'
                : '历史航线查询暂不可用，请检查条件或稍后重试。',
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}
