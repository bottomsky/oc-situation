import { z } from 'zod';
import { parseBusinessRequest } from './business-request';
import { bindBusinessCapability } from './business-capabilities';
import { createBusinessToolRegistry } from './business-tool-registry';
import type { RuntimeContext, RuntimePorts, RuntimeOptions } from './runtime';

export async function executeBusinessRequest(
  context: RuntimeContext,
  ports: RuntimePorts,
  options: RuntimeOptions,
): Promise<boolean> {
  const request = parseBusinessRequest(context.task.goal, context.task.selection?.focusTargets);
  if (!request) return false;
  const skillId = request.toolId.includes('event')
    ? /create|update/.test(request.toolId)
      ? 'event-manage'
      : 'event-query'
    : /create|update/.test(request.toolId)
      ? 'route-manage'
      : 'route-plan';
  try {
    if (
      /^(create|update)_/.test(request.toolId) &&
      process.env.AGENT_BUSINESS_WRITE_ENABLED !== 'true'
    )
      throw new Error('业务写入功能尚未启用。');
    const binding = await bindBusinessCapability(skillId, context, ports, options);
    const registry = createBusinessToolRegistry(context, ports, options.signal);
    const saved = context.steps.find((step) => step.key === `business_${request.toolId}`)
      ?.output as { payload?: unknown } | undefined;
    const output = saved?.payload
      ? { local: saved.payload }
      : await binding.executor([registry.get(request.toolId).tool])(request.toolId, 'skill', {});
    if (!(await ports.active())) return true;
    await ports.saveStep(`business_${request.toolId}`, skillId, { payload: output.local });
    const value = z.record(z.string(), z.unknown()).parse(output.local);
    const kind = String(value.kind);
    const objects = value.plan
      ? [value.plan]
      : value.route
        ? [value.route]
        : value.event
          ? [value.event]
          : Array.isArray(value.routes)
            ? value.routes
            : Array.isArray(value.items)
              ? value.items
              : [];
    const refs = objects.map((item) => {
      const object = z
        .object({ id: z.string(), revision: z.number().int().positive().optional() })
        .parse(item);
      return {
        kind: kind === 'route' || kind === 'route_plan' ? ('route' as const) : ('event' as const),
        id: object.id,
        ...(object.revision === undefined ? {} : { revision: object.revision }),
      };
    });
    if (refs && ports.saveFocus && process.env.AGENT_SPATIAL_FOCUS_ENABLED !== 'false') {
      const { prepareTaskFocus } = await import('./focus-runtime');
      await prepareTaskFocus(
        {
          ...context,
          focusOmittedCount: Math.max(0, Number(value.total ?? refs.length) - refs.length),
          task: { ...context.task, selection: { ...context.task.selection, focusTargets: refs } },
        },
        ports,
      );
    }
    const unlocated = value.event && !(value.event as { geometry?: unknown }).geometry;
    await ports.finish({
      status: 'completed',
      summary: /create|update/.test(request.toolId)
        ? `已保存${request.toolId.includes('event') ? '事件' : '航线'}，对象 ID：${refs[0]?.id ?? '见结果'}。${unlocated ? '该事件尚无位置，关注结果标记为未定位。' : ''}`
        : request.toolId === 'plan_route'
          ? '航线规划已完成，结果见本轮产物。'
          : '已完成查询，结果见本轮产物。',
    });
  } catch (error) {
    const databaseError = /^[0-9A-Z]{5}$/.test(String((error as { code?: string }).code ?? ''));
    const message = databaseError
      ? '业务存储暂不可用，请稍后重试。'
      : error instanceof Error
        ? error.message
        : '业务操作失败';
    await ports.finish({
      status: 'failed',
      errorCode: /^[a-z_]+$/.test(message) ? message : 'business_failed',
      error: message,
    });
  }
  return true;
}
