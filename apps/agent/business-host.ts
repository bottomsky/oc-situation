import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { logger, type Infrastructure } from '../../packages/infrastructure/clients';
import { fenced, transaction } from '../../packages/infrastructure/agent';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  createRoute,
  updateRoute,
  listRoutes,
  getRoute,
  createRoutePlan,
  getRoutePlan,
  cancelRoutePlan,
} from '../../packages/infrastructure/routes';
import {
  createOperationalEvent,
  updateOperationalEvent,
  listOperationalEvents,
  getOperationalEvent,
} from '../../packages/infrastructure/operational-event-store';
import {
  CreateOperationalEventSchema,
  UpdateOperationalEventSchema,
} from '../../packages/contracts/operational-events';
import type { AgentSkillFence } from '../../packages/contracts/dynamic-skills';
import type { RuntimeContext } from './runtime';
import { businessOperationId, parseBusinessRequest, type BusinessToolId } from './business-request';

export async function persistBuiltinArtifact(
  infra: Infrastructure,
  fence: AgentSkillFence,
  stepId: string,
  payload: unknown,
  id: string = randomUUID(),
) {
  return transaction(infra, async (client) => {
    const task = await fenced(client, fence.taskId, fence.workerId, fence.generation);
    if (
      !task ||
      task.owner_id !== fence.ownerId ||
      Number(task.input_revision) !== fence.inputRevision
    )
      throw new Error('fenced');
    const kind = (payload as { kind: string }).kind;
    if (
      !['map_focus', 'route_plan', 'route', 'operational_events', 'operational_event'].includes(
        kind,
      )
    )
      throw new Error('invalid_artifact');
    const existing = await client.query(
      'SELECT id FROM agent_ui_artifacts WHERE task_id=$1 AND input_revision=$2 AND step_id=$3',
      [fence.taskId, fence.inputRevision, stepId],
    );
    if (existing.rowCount) return String(existing.rows[0].id);
    await client.query(
      'INSERT INTO agent_ui_artifacts(id,task_id,owner_id,input_revision,step_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [id, fence.taskId, fence.ownerId, fence.inputRevision, stepId, kind, JSON.stringify(payload)],
    );
    return id;
  });
}

export function createBusinessHost(
  infra: Infrastructure,
  fence: AgentSkillFence,
  context: RuntimeContext,
  signal?: AbortSignal,
) {
  const guard = async (client: PoolClient) => {
    if (process.env.AGENT_ENABLED !== 'true') throw new Error('agent_disabled');
    const row = await fenced(client, fence.taskId, fence.workerId, fence.generation);
    if (
      !row ||
      row.owner_id !== fence.ownerId ||
      Number(row.input_revision) !== fence.inputRevision
    )
      throw new Error('fenced');
  };
  const actor = { id: fence.ownerId, role: 'operator' };
  return async (toolId: BusinessToolId, stepId: string): Promise<unknown> => {
    const request = parseBusinessRequest(context.task.goal, context.task.selection?.focusTargets);
    if (!request || request.toolId !== toolId) throw new Error('tool_ceiling');
    const write = /^(create|update)_/.test(toolId);
    if (write && process.env.AGENT_BUSINESS_WRITE_ENABLED !== 'true')
      throw new Error('business_write_disabled');
    const currentFence = async (client: PoolClient) => {
      if (write && process.env.AGENT_BUSINESS_WRITE_ENABLED !== 'true')
        throw new Error('business_write_disabled');
      await guard(client);
    };
    if (signal?.aborted) throw new Error('cancelled');
    let operationTaskId = fence.taskId;
    let operationRevision = fence.inputRevision;
    let operationStepId = stepId;
    let operationId = businessOperationId(
      operationTaskId,
      operationRevision,
      operationStepId,
      toolId,
    );
    // Read committed receipts before resolving mutable business versions. This preserves the original write after a crash.
    if (write) {
      const c = await infra.pool.connect();
      try {
        await c.query('BEGIN');
        await currentFence(c);
        const origin = (
          await c.query<{ output: { taskId: string; inputRevision: number } }>(
            "SELECT output FROM agent_steps WHERE task_id=$1 AND input_revision=$2 AND step_key='business_retry_origin'",
            [fence.taskId, fence.inputRevision],
          )
        ).rows[0]?.output;
        if (origin) {
          const source = await c.query(
            'SELECT id FROM agent_tasks WHERE id=$1 AND owner_id=$2 AND session_id=$3',
            [origin.taskId, fence.ownerId, context.task.sessionId],
          );
          if (!source.rowCount) throw new Error('operation_source_missing');
          operationTaskId = origin.taskId;
          operationRevision = origin.inputRevision;
        }
        const prepared = (
          await c.query(
            `SELECT step_key,output FROM agent_steps WHERE task_id=$1 AND input_revision=$2
             AND starts_with(step_key,'business_operation_') AND output->'request'->>'toolId'=$3
             ORDER BY created_at,step_key LIMIT 1`,
            [operationTaskId, operationRevision, toolId],
          )
        ).rows[0];
        const requestIdentity = { request, targets: context.task.selection?.focusTargets ?? [] };
        if (prepared && !isDeepStrictEqual(prepared.output, requestIdentity))
          throw new Error('operation_conflict');
        if (prepared)
          operationStepId = String(prepared.step_key).slice('business_operation_'.length);
        operationId = businessOperationId(
          operationTaskId,
          operationRevision,
          operationStepId,
          toolId,
        );
        if (!prepared)
          await c.query(
            "INSERT INTO agent_steps(task_id,step_key,name,input,output,input_revision) VALUES($1,$2,$3,'null'::jsonb,$4::jsonb,$5)",
            [
              operationTaskId,
              `business_operation_${operationStepId}`,
              '业务操作输入绑定',
              JSON.stringify(requestIdentity),
              operationRevision,
            ],
          );
        const receipt = await c.query<{ result: unknown }>(
          toolId.includes('event')
            ? 'SELECT result FROM operational_event_operations WHERE actor_id=$1 AND operation_id=$2'
            : 'SELECT result FROM route_operation_receipts WHERE user_id=$1 AND operation_id=$2',
          [fence.ownerId, operationId],
        );
        await c.query('COMMIT');
        if (receipt.rows[0]) {
          logger.info(
            { toolName: toolId, event: 'idempotent_hit' },
            'Recovered committed business operation',
          );
          return toolId.includes('event')
            ? { kind: 'operational_event', event: receipt.rows[0].result }
            : { kind: 'route', route: receipt.rows[0].result };
        }
      } catch (error) {
        await c.query('ROLLBACK');
        throw error;
      } finally {
        c.release();
      }
    }
    const circle =
      context.task.selection?.region?.kind === 'circle' ? context.task.selection.region : undefined;
    if (toolId === 'query_routes') {
      const result = await listRoutes(infra, {
        ...(request.search ? { search: request.search } : {}),
        ...(circle
          ? {
              longitude: circle.center[0],
              latitude: circle.center[1],
              radiusMeters: circle.radiusMeters,
            }
          : {}),
      });
      return {
        kind: 'route',
        routes: result.items,
        total: result.total,
        truncated: result.total > result.items.length,
      };
    }
    if (toolId === 'read_route') {
      const route = request.id && (await getRoute(infra, request.id));
      if (!route) throw new Error('route_not_found');
      return { kind: 'route', route };
    }
    if (toolId === 'query_events')
      return {
        kind: 'operational_events',
        ...(await listOperationalEvents(infra, {
          ...(request.search ? { keyword: request.search } : {}),
          ...(circle ? { circle } : {}),
          limit: 100,
          offset: 0,
        })),
      };
    if (toolId === 'read_event') {
      const event = request.id && (await getOperationalEvent(infra, request.id));
      if (!event) throw new Error('event_not_found');
      return { kind: 'operational_event', event };
    }
    if (toolId === 'create_event') {
      if (!request.title)
        throw new Error('请补充事件标题，例如：创建事件 标题：异常聚集 坐标：121,30');
      return {
        kind: 'operational_event',
        event: await createOperationalEvent(
          infra,
          CreateOperationalEventSchema.parse({
            operationId,
            title: request.title,
            geometry: request.coordinate
              ? { type: 'Point', coordinates: request.coordinate }
              : null,
            ...(request.summary ? { summary: request.summary } : {}),
            ...(request.category ? { category: request.category } : {}),
            ...(request.severity ? { severity: request.severity } : {}),
            ...(request.linkedMmsis ? { linkedMmsis: request.linkedMmsis } : {}),
          }),
          actor,
          { beforeWrite: currentFence },
        ),
      };
    }
    if (toolId === 'update_event') {
      if (!request.id) throw new Error('请提供事件 ID 或选中一个事件');
      const current = await getOperationalEvent(infra, request.id);
      if (!current) throw new Error('event_not_found');
      const fields = {
        ...(request.title ? { title: request.title } : {}),
        ...(request.coordinate
          ? { geometry: { type: 'Point', coordinates: request.coordinate } }
          : {}),
        ...(request.summary ? { summary: request.summary } : {}),
        ...(request.category ? { category: request.category } : {}),
        ...(request.severity ? { severity: request.severity } : {}),
        ...(request.linkedMmsis ? { linkedMmsis: request.linkedMmsis } : {}),
      };
      if (!request.status && !Object.keys(fields).length)
        throw new Error('请提供可识别的事件状态、标题、摘要、分类、级别、坐标或关联船舶');
      const expectedRevision =
        context.task.selection?.focusTargets?.find((r) => r.kind === 'event' && r.id === request.id)
          ?.revision ?? current.revision;
      return {
        kind: 'operational_event',
        event: await updateOperationalEvent(
          infra,
          request.id,
          UpdateOperationalEventSchema.parse({
            operationId,
            expectedRevision,
            fields,
            ...(request.status ? { status: request.status } : {}),
          }),
          actor,
          { beforeWrite: currentFence },
        ),
      };
    }
    if (toolId === 'update_route') {
      if (!request.id) throw new Error('请提供航线 ID 或选中一条航线');
      const current = await getRoute(infra, request.id);
      if (!current) throw new Error('route_not_found');
      if (!request.name && !request.status) throw new Error('请提供航线名称或状态');
      const expectedRevision =
        context.task.selection?.focusTargets?.find((r) => r.kind === 'route' && r.id === request.id)
          ?.revision ?? current.revision;
      return {
        kind: 'route',
        route: await updateRoute(
          infra,
          actor,
          request.id,
          {
            operationId,
            expectedRevision,
            ...(request.name ? { name: request.name } : {}),
            ...(request.status ? { status: request.status } : {}),
          },
          currentFence,
        ),
      };
    }
    if (!request.waypoints || request.waypoints.length < 2)
      throw new Error('请提供起终点坐标，例如：规划从坐标120,30到坐标121,31的航线');
    if (toolId === 'create_route' && !request.name)
      throw new Error('请提供保存航线名称，例如：规划并保存为：巡逻线');
    const planId = businessOperationId(
      operationTaskId,
      operationRevision,
      operationStepId,
      'plan_route',
    );
    let plan = await createRoutePlan(
      infra,
      actor,
      { operationId: planId, waypoints: request.waypoints },
      currentFence,
    );
    const deadline = Date.now() + 120_000;
    try {
      while (['queued', 'running'].includes(plan.status)) {
        if (Date.now() >= deadline) throw new Error('route_plan_timeout');
        await delay(250, undefined, { signal });
        const next = await getRoutePlan(infra, plan.id);
        if (!next) throw new Error('route_plan_not_found');
        plan = next;
      }
    } catch (error) {
      if (signal?.aborted)
        await cancelRoutePlan(infra, actor, plan.id, {
          operationId: businessOperationId(
            fence.taskId,
            fence.inputRevision,
            stepId,
            'cancel_route_plan',
          ),
        }).catch(() => undefined);
      throw error;
    }
    if (plan.status !== 'completed' || !plan.result)
      throw new Error(plan.error ?? `route_plan_${plan.status}`);
    if (toolId === 'plan_route') return { kind: 'route_plan', plan };
    return {
      kind: 'route',
      route: await createRoute(
        infra,
        actor,
        { operationId, name: request.name, planId: plan.id },
        currentFence,
      ),
    };
  };
}
