import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import {
  createAgentSession,
  submitAgentMessage,
  claimAgentTask,
  getAgentTaskContext,
  retryAgentTask,
  requestAgentInput,
  respondAgentInput,
} from '../../packages/infrastructure/agent';
import { createBusinessHost } from './business-host';
import { processAgentTask } from './index';
import {
  publishOwnedSkill,
  listOwnedSkills,
  bindTaskDynamicSkill,
  beginDynamicSkillCall,
  getDynamicSkillExecution,
} from '../../packages/infrastructure/dynamic-skills';
import { DynamicSkillDefinitionSchema } from '../../packages/contracts/dynamic-skills';
import {
  registerUiClient,
  updateUiState,
  getUiTaskCommand,
  claimUiCommand,
  receiptUiCommand,
} from '../../packages/infrastructure/agent-ui';
import { UiStateSchema } from '../../packages/contracts/agent-ui';
import { createFocusResolver } from './focus-host';
import { VesselTracksQuerySchema } from '../../packages/contracts/vessel-tracks';
import { createRoute, updateRoute, listRoutes } from '../../packages/infrastructure/routes';
import {
  createOperationalEvent,
  updateOperationalEvent,
  mergeOperationalEvents,
  listOperationalEvents,
} from '../../packages/infrastructure/operational-event-store';
import { CreateOperationalEventSchema } from '../../packages/contracts/operational-events';
import type { AgentFocusResult } from '../../packages/contracts/agent-focus';
import type { RuntimePorts } from './runtime';
import { executeBusinessRequest } from './business-runtime';
import { AgentSelectionSchema, type AgentSelection } from '../../packages/contracts/agent';

describe('trusted business host PostgreSQL recovery', () => {
  const ownerId = randomUUID();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const infra = { pool } as Infrastructure;
  const original = {
    enabled: process.env.AGENT_ENABLED,
    write: process.env.AGENT_BUSINESS_WRITE_ENABLED,
    dynamic: process.env.AGENT_DYNAMIC_SKILLS_ENABLED,
    ui: process.env.AGENT_UI_ENABLED,
  };
  beforeAll(async () => {
    process.env.AGENT_ENABLED = 'true';
    process.env.AGENT_BUSINESS_WRITE_ENABLED = 'true';
    await pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
      [ownerId],
    );
  });
  it('rejects conflicting circle scope in structured input while keeping resolved result selections compatible', async () => {
    const region = {
      kind: 'circle' as const,
      center: [113, 22] as [number, number],
      radiusMeters: 100000,
    };
    const vesselCircle = { mmsi: '257288000', radiusMeters: 100000 };
    // Result selections legitimately retain both the reference and its resolved geometry.
    expect(AgentSelectionSchema.parse({ region, vesselCircle })).toEqual({ region, vesselCircle });
    const cases: { goal: string; conflicts: AgentSelection[]; accepted: AgentSelection }[] = [
      {
        goal: '查询113,22方圆100公里内有哪些船',
        conflicts: [
          { vesselCircle },
          { region: { ...region, center: [114, 23] } },
          { region: { ...region, radiusMeters: 200000 } },
          { bbox: [-180, -80, 180, 80] },
          {
            purpose: 'intelligence_search',
            intelligenceQuery: { bbox: [-180, -80, 180, 80] },
          },
        ],
        accepted: { filters: { hours: 48 } },
      },
      {
        goal: '以船舶257288000为中心半径100公里内多少船',
        conflicts: [
          { region },
          { vesselCircle: { ...vesselCircle, mmsi: '257288001' } },
          { vesselCircle: { ...vesselCircle, radiusMeters: 200000 } },
          { bbox: [-180, -80, 180, 80] },
          {
            purpose: 'intelligence_search',
            intelligenceQuery: { bbox: [-180, -80, 180, 80] },
          },
        ],
        accepted: { filters: { hours: 48 } },
      },
      {
        goal: '查询区域内有哪些船舶',
        conflicts: [
          { region, vesselCircle },
          { bbox: [-180, -80, 180, 80], vesselCircle },
        ],
        accepted: { vesselCircle },
      },
    ];
    for (const entry of cases) {
      const session = await createAgentSession(infra, ownerId, 'circle input authority');
      const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: entry.goal,
        historyHours: 24,
      });
      if (submitted.task.status !== 'awaiting_input') {
        const claimed = (await claimAgentTask(infra, 'circle-input-worker', submitted.task.id))!;
        expect(
          await requestAgentInput(infra, claimed.id, 'circle-input-worker', claimed.generation, {
            fields: ['time'],
            reason: 'missing_time',
          }),
        ).toBe(true);
      }
      const request = (
        await pool.query(
          "SELECT id,input_revision FROM agent_input_requests WHERE task_id=$1 AND status='pending'",
          [submitted.task.id],
        )
      ).rows[0];
      for (const values of entry.conflicts) {
        await expect(
          respondAgentInput(infra, ownerId, submitted.task.id, request.id, randomUUID(), {
            action: 'accept',
            inputRevision: request.input_revision,
            values,
          }),
        ).rejects.toMatchObject({ code: 'invalid_input' });
        const unchanged = (await getAgentTaskContext(infra, submitted.task.id))!.task;
        expect(unchanged.inputRevision).toBe(0);
        expect(unchanged.status).toBe('awaiting_input');
        expect(unchanged.selection).toEqual(submitted.task.selection);
      }
      const accepted = await respondAgentInput(
        infra,
        ownerId,
        submitted.task.id,
        request.id,
        randomUUID(),
        {
          action: 'accept',
          inputRevision: request.input_revision,
          values: entry.accepted,
        },
      );
      expect(accepted.task.status).toBe('queued');
      expect(accepted.task.inputRevision).toBe(1);
    }
  });
  it('repairs coordinate query retries by removing conflicting vessel centers and stale snapshots', async () => {
    const region = { kind: 'circle', center: [113, 22], radiusMeters: 100000 };
    for (const changed of [false, true]) {
      const session = await createAgentSession(infra, ownerId, 'coordinate retry authority');
      const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '查询113,22方圆100公里内有哪些船',
        historyHours: 24,
      });
      await pool.query("UPDATE agent_tasks SET status='failed',selection=$2::jsonb WHERE id=$1", [
        submitted.task.id,
        JSON.stringify({
          ...submitted.task.selection,
          region: changed ? { ...region, radiusMeters: 200000 } : region,
          vesselCircle: { mmsi: '257288000', radiusMeters: 100000 },
        }),
      ]);
      await pool.query(
        "INSERT INTO agent_steps(task_id,input_revision,step_key,name,input,output) VALUES($1,0,'input_snapshot','conflicting scope','null'::jsonb,'{}'::jsonb)",
        [submitted.task.id],
      );
      const retry = await retryAgentTask(infra, ownerId, submitted.task.id, randomUUID());
      expect(retry.task.selection?.region).toEqual(region);
      expect(retry.task.selection?.vesselCircle).toBeUndefined();
      expect((await getAgentTaskContext(infra, retry.task.id))?.steps).toEqual([]);
    }
  });
  it('persists a vessel-centered circle request and retries its own scope without narrowing results to the anchor MMSI', async () => {
    const priorDynamic = process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    try {
      const session = await createAgentSession(infra, ownerId, 'vessel circle input');
      const goal = '船舶257288000 中心及半径 100 公里的圆形区域多少 传船舶';
      const input = {
        content: goal,
        historyHours: 24,
        mapContext: {
          bbox: [-180, -80, 180, 80] as [number, number, number, number],
          capturedAt: new Date().toISOString(),
          selectedMmsis: ['257288000'],
        },
      };
      const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), input);
      const expected = { mmsi: '257288000', radiusMeters: 100000 };
      expect(submitted.task.intent).toBe('vessel_list');
      expect(submitted.pendingInputRequests).toEqual([]);
      expect(submitted.task.selection?.vesselCircle).toEqual(expected);
      expect(submitted.task.selection?.region).toBeUndefined();
      expect(submitted.task.selection?.bbox).toBeUndefined();
      expect(submitted.task.selection?.mmsis).toBeUndefined();
      expect(submitted.task.selection?.vesselSelector?.mmsis).toBeUndefined();
      expect(submitted.task.bbox).toBeNull();
      await pool.query(
        "UPDATE agent_tasks SET status='failed',intent='skill',selection=$2::jsonb,bbox=$3::jsonb WHERE id=$1",
        [
          submitted.task.id,
          JSON.stringify({
            bbox: input.mapContext.bbox,
            purpose: 'vessel_detail',
            mmsis: ['257288000'],
          }),
          JSON.stringify(input.mapContext.bbox),
        ],
      );
      const retry = await retryAgentTask(infra, ownerId, submitted.task.id, randomUUID());
      expect(retry.task.intent).toBe('vessel_list');
      expect(retry.task.selection).toMatchObject({
        vesselCircle: expected,
        purpose: 'vessel_list',
      });
      expect(retry.task.selection?.bbox).toBeUndefined();
      expect(retry.task.selection?.mmsis).toBeUndefined();
      expect(retry.task.selection?.region).toBeUndefined();
      expect(retry.task.bbox).toBeNull();
      expect((await getAgentTaskContext(infra, retry.task.id))?.queryResult).toBeNull();
      for (const content of [
        '船舶257288000和257288001为中心半径100公里内多少船',
        '船舶25728800中心半径100公里内多少船',
        '船舶257288000中心半径一百公里内多少船',
      ])
        await expect(
          submitAgentMessage(infra, ownerId, session.id, randomUUID(), { ...input, content }),
        ).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      if (priorDynamic === undefined) delete process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
      else process.env.AGENT_DYNAMIC_SKILLS_ENABLED = priorDynamic;
    }
  });
  it('binds bare coordinate focus locally and repairs legacy global-query retries without old results', async () => {
    const previousDynamic = process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    const previousUi = process.env.AGENT_UI_ENABLED;
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'false';
    try {
      const session = await createAgentSession(infra, ownerId, 'coordinate focus repair');
      const goal = '聚集 113.8751, 22.0843 方圆 100公里';
      const input = {
        content: goal,
        historyHours: 24,
        mapContext: {
          bbox: [-180, -80, 180, 80] as [number, number, number, number],
          capturedAt: new Date().toISOString(),
        },
      };
      const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), input);
      const circle = { kind: 'circle', center: [113.8751, 22.0843], radiusMeters: 100000 };
      expect(submitted.task.intent).toBe('map_focus');
      expect(submitted.task.selection?.region).toEqual(circle);
      expect(submitted.task.selection?.bbox).toBeUndefined();
      expect(submitted.pendingInputRequests).toEqual([]);
      const precise = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        ...input,
        content: '聚焦113.875112345,22.084312345方圆100公里',
      });
      expect(precise.task.selection?.focusTargets).toBeUndefined();
      expect(precise.task.selection?.mmsis).toBeUndefined();
      expect(precise.task.selection?.region).toMatchObject({
        center: [113.875112345, 22.084312345],
      });
      await processAgentTask(infra, submitted.task.id, { apiKey: 'unused' }, 'circle-worker');
      const completed = (await getAgentTaskContext(infra, submitted.task.id))!;
      expect(completed.task.status).toBe('completed');
      expect(completed.task.modelCalls).toBe(0);
      expect(completed.focusResult?.targets).toHaveLength(1);
      expect(completed.focusResult?.targets[0]?.region).toEqual(circle);
      await pool.query(
        "UPDATE agent_tasks SET intent='skill',status='failed',input_revision=1,selection=$2::jsonb,bbox=$3::jsonb WHERE id=$1",
        [
          submitted.task.id,
          JSON.stringify({ bbox: input.mapContext.bbox, purpose: 'vessel_list' }),
          JSON.stringify(input.mapContext.bbox),
        ],
      );
      await pool.query(
        "INSERT INTO agent_steps(task_id,input_revision,step_key,name,input,output) VALUES($1,1,'input_snapshot','old global input','null'::jsonb,$2::jsonb)",
        [submitted.task.id, JSON.stringify({ bbox: input.mapContext.bbox })],
      );
      // The corrected builtin retry must also work when dynamic composition has been disabled.
      process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'false';
      const retry = await retryAgentTask(infra, ownerId, submitted.task.id, randomUUID());
      expect(retry.task.intent).toBe('map_focus');
      expect(retry.task.selection).toMatchObject({ region: circle });
      expect(retry.task.selection?.bbox).toBeUndefined();
      expect(retry.task.selection?.purpose).toBeUndefined();
      expect(retry.task.bbox).toBeNull();
      const fresh = (await getAgentTaskContext(infra, retry.task.id))!;
      expect(fresh.steps).toEqual([]);
      expect(fresh.queryResult).toBeNull();
      expect(fresh.focusResult).toBeNull();
      await processAgentTask(infra, retry.task.id, { apiKey: 'unused' }, 'circle-retry-worker');
      const recovered = (await getAgentTaskContext(infra, retry.task.id))!;
      expect(recovered.task.status).toBe('completed');
      expect(recovered.focusResult?.targets).toHaveLength(1);
      expect(recovered.focusResult?.targets[0]?.region).toEqual(circle);
      for (const content of [
        '聚焦181,22方圆100公里',
        '聚焦113,22和114,23方圆100公里',
        '定位113,方圆100公里',
        '查询113,22方圆一百公里内有哪些船',
        '查询坐标113,22半径abc公里内有哪些船',
      ]) {
        await expect(
          submitAgentMessage(infra, ownerId, session.id, randomUUID(), { ...input, content }),
        ).rejects.toMatchObject({ code: 'invalid_input' });
      }
      await pool.query('UPDATE agent_tasks SET goal=$2 WHERE id=$1', [
        submitted.task.id,
        '聚集181,22方圆100公里',
      ]);
      await expect(
        retryAgentTask(infra, ownerId, submitted.task.id, randomUUID()),
      ).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      for (const [key, value] of [
        ['AGENT_DYNAMIC_SKILLS_ENABLED', previousDynamic],
        ['AGENT_UI_ENABLED', previousUi],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  afterAll(async () => {
    for (const [key, value] of Object.entries({
      AGENT_ENABLED: original.enabled,
      AGENT_BUSINESS_WRITE_ENABLED: original.write,
      AGENT_DYNAMIC_SKILLS_ENABLED: original.dynamic,
      AGENT_UI_ENABLED: original.ui,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const cleanup = await pool.connect();
    try {
      await cleanup.query('BEGIN');
      await cleanup.query(
        'DELETE FROM agent_ui_receipts WHERE command_id IN (SELECT id FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1))',
        [ownerId],
      );
      await cleanup.query(
        'DELETE FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)',
        [ownerId],
      );
      for (const table of [
        'agent_skill_artifacts',
        'agent_ui_artifacts',
        'agent_skill_calls',
        'agent_task_skill_bindings',
        'agent_dynamic_skill_versions',
        'agent_dynamic_skills',
        'agent_dynamic_skill_operations',
        'agent_dynamic_skill_catalogs',
        'agent_input_responses',
        'agent_ui_clients',
      ])
        await cleanup.query(`DELETE FROM ${table} WHERE owner_id=$1`, [ownerId]);
      for (const table of ['agent_input_requests', 'agent_steps', 'agent_results'])
        await cleanup.query(
          `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)`,
          [ownerId],
        );
      for (const table of ['agent_events', 'agent_messages'])
        await cleanup.query(
          `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)`,
          [ownerId],
        );
      await cleanup.query('DELETE FROM agent_tasks WHERE owner_id=$1', [ownerId]);
      await cleanup.query('DELETE FROM agent_sessions WHERE owner_id=$1', [ownerId]);
      await cleanup.query(
        "DELETE FROM operational_event_sources WHERE event_id IN (SELECT (result->>'id')::uuid FROM operational_event_operations WHERE actor_id=$1)",
        [ownerId],
      );
      await cleanup.query(
        "DELETE FROM operational_event_revisions WHERE event_id IN (SELECT (result->>'id')::uuid FROM operational_event_operations WHERE actor_id=$1)",
        [ownerId],
      );
      await cleanup.query(
        "DELETE FROM operational_events WHERE id IN (SELECT (result->>'id')::uuid FROM operational_event_operations WHERE actor_id=$1)",
        [ownerId],
      );
      await cleanup.query('DELETE FROM operational_event_operations WHERE actor_id=$1', [ownerId]);
      await cleanup.query('DELETE FROM route_revisions WHERE user_id=$1', [ownerId]);
      await cleanup.query(
        "DELETE FROM routes WHERE id IN (SELECT (result->>'id')::uuid FROM route_operation_receipts WHERE user_id=$1)",
        [ownerId],
      );
      await cleanup.query('DELETE FROM route_operation_receipts WHERE user_id=$1', [ownerId]);
      await cleanup.query('DELETE FROM audit WHERE user_id=$1', [ownerId]);
      await cleanup.query('DELETE FROM users WHERE id=$1', [ownerId]);
      await cleanup.query('COMMIT');
    } catch (error) {
      await cleanup.query('ROLLBACK');
      throw error;
    } finally {
      cleanup.release();
    }
    await pool.end();
  });
  it('keeps queried route and event revisions through concurrent edits and an event merge', async () => {
    const actor = { id: ownerId, role: 'operator' };
    const name = `snapshot-${randomUUID()}`;
    const line = {
      type: 'LineString' as const,
      coordinates: [
        [121, 30],
        [122, 31],
      ],
    };
    const route = await createRoute(infra, actor, {
      operationId: randomUUID(),
      name,
      geometry: line,
      waypoints: line.coordinates,
    });
    const event = await createOperationalEvent(
      infra,
      CreateOperationalEventSchema.parse({
        operationId: randomUUID(),
        title: name,
        geometry: { type: 'Point', coordinates: [121, 30] },
      }),
      actor,
    );
    const session = await createAgentSession(infra, ownerId, 'historic focus snapshots');
    const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '查询航线',
      historyHours: 24,
    });
    const context = (await getAgentTaskContext(infra, submitted.task.id))!;
    const resolve = createFocusResolver(infra);
    for (const kind of ['route', 'event'] as const) {
      let focus: AgentFocusResult | undefined;
      const finish: unknown[] = [];
      const ports = {
        active: async () => true,
        reserve: async () => true,
        saveStep: async () => true,
        setDefinition: async () => {
          throw new Error('Unexpected topic definition');
        },
        reusePrevious: async () => {
          throw new Error('Unexpected previous task');
        },
        query: async () => {
          throw new Error('Unexpected topic query');
        },
        saveResults: async () => {
          throw new Error('Unexpected analysis results');
        },
        finish: async (outcome: unknown) => {
          finish.push(outcome);
          return true;
        },
        saveFocus: async (result: AgentFocusResult) => {
          focus = result;
        },
        resolveFocus: resolve,
        businessTool: async () => {
          if (kind === 'route') {
            const result = await listRoutes(infra, { search: name });
            const next = {
              type: 'LineString',
              coordinates: [
                [130, 20],
                [131, 21],
              ],
            };
            await updateRoute(infra, actor, route.id, {
              operationId: randomUUID(),
              expectedRevision: 1,
              name: '航线第二版',
              geometry: next,
              waypoints: next.coordinates,
            });
            return { kind: 'route', routes: result.items, total: result.total };
          }
          const result = await listOperationalEvents(infra, {
            keyword: name,
            limit: 100,
            offset: 0,
          });
          await updateOperationalEvent(
            infra,
            event.id,
            {
              operationId: randomUUID(),
              expectedRevision: 1,
              fields: { title: '事件第二版', geometry: { type: 'Point', coordinates: [130, 20] } },
              releaseOverrides: [],
            },
            actor,
          );
          return { kind: 'operational_events', ...result };
        },
      } satisfies RuntimePorts;
      await executeBusinessRequest(
        {
          ...context,
          task: { ...context.task, goal: kind === 'route' ? '查询航线' : '查询事件' },
        },
        ports,
        { apiKey: 'unused' },
      );
      expect(finish).toEqual([expect.objectContaining({ status: 'completed' })]);
      expect(focus?.targets).toEqual([
        expect.objectContaining({
          ref: { kind, id: kind === 'route' ? route.id : event.id, revision: 1 },
          label: name,
          geometry: kind === 'route' ? route.geometry : event.geometry,
        }),
      ]);
      expect(
        await resolve({ kind, id: kind === 'route' ? route.id : event.id, revision: 999 }, context),
      ).toBeNull();
      expect(
        await resolve({ kind, id: kind === 'route' ? route.id : event.id }, context),
      ).toMatchObject({
        ref: { revision: 2 },
        label: kind === 'route' ? '航线第二版' : '事件第二版',
      });
    }
    const target = await createOperationalEvent(
      infra,
      CreateOperationalEventSchema.parse({
        operationId: randomUUID(),
        title: '合并目标',
        geometry: { type: 'Point', coordinates: [140, 20] },
      }),
      actor,
    );
    const sourceKey = randomUUID();
    await pool.query(
      'INSERT INTO operational_event_sources(source_key,event_id,revision,data) VALUES($1,$2,1,$3)',
      [
        sourceKey,
        event.id,
        JSON.stringify({ key: sourceKey, eventId: event.id, fields: event.sourceSuggestions }),
      ],
    );
    await mergeOperationalEvents(
      infra,
      event.id,
      {
        operationId: randomUUID(),
        expectedRevision: 2,
        targetId: target.id,
        targetExpectedRevision: 1,
        primarySourceKey: sourceKey,
      },
      actor,
    );
    expect(await resolve({ kind: 'event', id: event.id, revision: 1 }, context)).toMatchObject({
      ref: { id: event.id, revision: 1 },
      label: name,
      geometry: event.geometry,
    });
    expect(await resolve({ kind: 'event', id: event.id, revision: 2 }, context)).toMatchObject({
      ref: { id: event.id, revision: 2 },
      label: '事件第二版',
      geometry: { type: 'Point', coordinates: [130, 20] },
    });
  });
  it('recovers a committed event after response loss in a new worker generation without another audit or mutation', async () => {
    const session = await createAgentSession(infra, ownerId, 'business recovery');
    const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '创建事件 标题：恢复验证 坐标：121.5,30.2',
      historyHours: 24,
    });
    const task = await claimAgentTask(infra, 'worker-before-crash', submitted.task.id);
    expect(task).not.toBeNull();
    const context = (await getAgentTaskContext(infra, task!.id))!;
    const fence = {
      ownerId,
      taskId: task!.id,
      generation: task!.generation,
      inputRevision: task!.inputRevision ?? 0,
      workerId: 'worker-before-crash',
    };
    const first = (await createBusinessHost(
      infra,
      fence,
      context,
    )('create_event', 'event_write')) as { event: { id: string; revision: number } };
    await pool.query(
      "UPDATE agent_tasks SET status='queued',worker_id=NULL,lease_until=NULL WHERE id=$1",
      [task!.id],
    );
    const resumed = (await claimAgentTask(infra, 'worker-after-crash', task!.id))!;
    expect(resumed.generation).toBeGreaterThan(task!.generation);
    const restored = await createBusinessHost(
      infra,
      { ...fence, generation: resumed.generation, workerId: 'worker-after-crash' },
      context,
    )('create_event', 'event_write');
    expect(restored).toEqual(first);
    const changedInput = {
      ...context,
      task: { ...context.task, goal: '创建事件 标题：同键不同输入 坐标：120,30' },
    };
    await expect(
      createBusinessHost(
        infra,
        { ...fence, generation: resumed.generation, workerId: 'worker-after-crash' },
        changedInput,
      )('create_event', 'event_write'),
    ).rejects.toThrow('operation_conflict');
    expect(
      Number(
        (
          await pool.query(
            "SELECT count(*) FROM audit WHERE user_id=$1 AND action='event.create' AND resource_id=$2",
            [ownerId, first.event.id],
          )
        ).rows[0].count,
      ),
    ).toBe(1);
    await expect(
      createBusinessHost(infra, fence, context)('create_event', 'event_write'),
    ).rejects.toThrow('fenced');
    const changed = {
      ...context,
      task: { ...context.task, goal: '创建事件 标题：越权 坐标：120,30' },
    };
    await expect(
      createBusinessHost(infra, fence, changed)('create_event', 'new_write'),
    ).rejects.toThrow('fenced');
  });
  it('blocks write capabilities independently of model arguments and rejects query-to-write escalation', async () => {
    const session = await createAgentSession(infra, ownerId, 'business ceiling');
    const submitted = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '查询事件',
      historyHours: 24,
    });
    const task = (await claimAgentTask(infra, 'query-worker', submitted.task.id))!;
    const context = (await getAgentTaskContext(infra, task.id))!;
    await expect(
      createBusinessHost(
        infra,
        {
          ownerId,
          taskId: task.id,
          generation: task.generation,
          inputRevision: 0,
          workerId: 'query-worker',
        },
        context,
      )('create_event', 'injected'),
    ).rejects.toThrow('tool_ceiling');
  });
  it('executes an unwritten retry once across sibling attempts and preserves inherited request identity', async () => {
    const session = await createAgentSession(infra, ownerId, 'retry before write');
    const original = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '创建事件 标题：执行前失败重试',
      historyHours: 24,
    });
    await pool.query("UPDATE agent_tasks SET status='failed' WHERE id=$1", [original.task.id]);
    const first = await retryAgentTask(infra, ownerId, original.task.id, randomUUID());
    const second = await retryAgentTask(infra, ownerId, original.task.id, randomUUID());
    await processAgentTask(infra, first.task.id, { apiKey: 'unused' }, 'first-unwritten-retry');
    const saved = (await getAgentTaskContext(infra, first.task.id))!.artifacts.find(
      (a) => a.kind === 'operational_event',
    )!.payload;
    const claimed = (await claimAgentTask(infra, 'second-unwritten-retry', second.task.id))!;
    const context = (await getAgentTaskContext(infra, second.task.id))!;
    const fence = {
      ownerId,
      taskId: second.task.id,
      generation: claimed.generation,
      inputRevision: 0,
      workerId: 'second-unwritten-retry',
    };
    await expect(
      createBusinessHost(infra, fence, {
        ...context,
        task: { ...context.task, goal: '创建事件 标题：篡改继承输入' },
      })('create_event', 'business_create_event'),
    ).rejects.toThrow('operation_conflict');
    expect(await createBusinessHost(infra, fence, context)('create_event', 'renamed_step')).toEqual(
      saved,
    );
  });
  it('keeps current retry cancellation, role and input revision fences while new input gets a new operation', async () => {
    const session = await createAgentSession(infra, ownerId, 'retry fences');
    const original = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '创建事件 标题：重试执行栅栏',
      historyHours: 24,
    });
    await processAgentTask(infra, original.task.id, { apiKey: 'unused' }, 'fence-original');
    const saved = (await getAgentTaskContext(infra, original.task.id))!.artifacts.find(
      (a) => a.kind === 'operational_event',
    )!.payload as { event: { id: string } };
    const retry = await retryAgentTask(infra, ownerId, original.task.id, randomUUID());
    const claimed = (await claimAgentTask(infra, 'retry-fence-worker', retry.task.id))!;
    const context = (await getAgentTaskContext(infra, retry.task.id))!;
    const fence = {
      ownerId,
      taskId: retry.task.id,
      generation: claimed.generation,
      inputRevision: 0,
      workerId: 'retry-fence-worker',
    };
    const host = createBusinessHost(infra, fence, context);
    await pool.query("UPDATE agent_tasks SET status='cancelled' WHERE id=$1", [retry.task.id]);
    await expect(host('create_event', 'business_create_event')).rejects.toThrow('fenced');
    await pool.query("UPDATE agent_tasks SET status='running' WHERE id=$1", [retry.task.id]);
    await pool.query("UPDATE users SET role='viewer' WHERE id=$1", [ownerId]);
    try {
      await expect(host('create_event', 'business_create_event')).rejects.toThrow('fenced');
    } finally {
      await pool.query("UPDATE users SET role='operator' WHERE id=$1", [ownerId]);
    }
    await pool.query('UPDATE agent_tasks SET input_revision=1 WHERE id=$1', [retry.task.id]);
    await expect(host('create_event', 'business_create_event')).rejects.toThrow('fenced');
    const revised = (await getAgentTaskContext(infra, retry.task.id))!;
    const newResult = (await createBusinessHost(
      infra,
      { ...fence, inputRevision: 1 },
      revised,
    )('create_event', 'business_create_event')) as { event: { id: string } };
    expect(newResult.event.id).not.toBe(saved.event.id);
  });
  it.each(['unknown', 'failed', 'running'])(
    'resumes %s durable dynamic writes after a crash through the real worker',
    async (status) => {
      process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
      const definition = DynamicSkillDefinitionSchema.parse({
        schemaVersion: 1,
        name: `recover-${randomUUID()}`,
        description: '保存明确创建的事件',
        body: '执行宿主绑定的业务写入。',
        requiredInputs: [],
        toolIds: ['create_event'],
        steps: [
          {
            id: 'save_event',
            toolId: 'create_event',
            input: { selection: { $ref: 'input.selection' } },
            artifactKind: 'operational_event',
          },
        ],
        expectedArtifacts: [{ stepId: 'save_event', kind: 'operational_event' }],
        requiredDisplays: [],
      });
      const published = await publishOwnedSkill(infra, ownerId, {
        operationId: randomUUID(),
        expectedCatalogRevision: (await listOwnedSkills(infra, ownerId)).catalogRevision,
        definition,
      });
      const session = await createAgentSession(infra, ownerId, 'dynamic write recovery');
      const sent = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: `创建事件 标题：恢复${status} 坐标：121,30`,
        historyHours: 24,
        skillRef: { skillId: published.skill.skillId },
      });
      const task = (await claimAgentTask(infra, 'crashed-worker', sent.task.id))!;
      const context = (await getAgentTaskContext(infra, task.id))!;
      const fence = {
        ownerId,
        taskId: task.id,
        inputRevision: 0,
        generation: task.generation,
        workerId: 'crashed-worker',
      };
      await bindTaskDynamicSkill(infra, fence, { skillId: published.skill.skillId }, [
        'create_event',
      ]);
      await beginDynamicSkillCall(infra, fence, {
        stepId: 'save_event',
        toolId: 'create_event',
        input: { selection: context.task.selection ?? {} },
        maxToolCalls: 24,
        execution: 'idempotent_write',
      });
      const saved = await createBusinessHost(infra, fence, context)('create_event', 'save_event');
      await pool.query('UPDATE agent_skill_calls SET status=$2 WHERE task_id=$1', [
        task.id,
        status,
      ]);
      await pool.query(
        "UPDATE agent_tasks SET status='queued',worker_id=NULL,lease_until=NULL WHERE id=$1",
        [task.id],
      );
      await processAgentTask(
        infra,
        task.id,
        {
          apiKey: 'unused',
          dynamicSkillsEnabled: true,
          fetch: async () => {
            throw new Error('model must not run');
          },
        },
        'recovery-worker',
      );
      const execution = (await getDynamicSkillExecution(infra, ownerId, task.id))!;
      expect(execution.calls[0]?.status).toBe('completed');
      expect(execution.calls[0]?.localResult).toEqual(saved);
      expect((await getAgentTaskContext(infra, task.id))?.task.status).toBe('completed');
      const retry = await retryAgentTask(infra, ownerId, task.id, randomUUID());
      await processAgentTask(
        infra,
        retry.task.id,
        { apiKey: 'unused', dynamicSkillsEnabled: true },
        'dynamic-retry-worker',
      );
      const retried = (await getDynamicSkillExecution(infra, ownerId, retry.task.id))!;
      expect(retried.calls[0]?.localResult).toEqual(saved);
      expect((await getAgentTaskContext(infra, retry.task.id))?.task.status).toBe('completed');
      expect(
        Number(
          (
            await pool.query(
              "SELECT count(*) FROM audit WHERE user_id=$1 AND action='event.create' AND resource_id=$2",
              [ownerId, (saved as { event: { id: string } }).event.id],
            )
          ).rows[0].count,
        ),
      ).toBe(1);
    },
  );
  it.each(['succeeded', 'rejected'] as const)(
    'retains the committed event and handles a %s task-scoped focus receipt',
    async (receiptStatus) => {
      process.env.AGENT_UI_ENABLED = 'true';
      const session = await createAgentSession(infra, ownerId, 'focus receipt');
      const state = UiStateSchema.parse({
        sequence: 1,
        route: '/',
        components: [
          {
            id: 'chart.focus',
            version: 1,
            mounted: true,
            open: false,
            visible: false,
            actions: ['show', 'close', 'focus'],
          },
        ],
      });
      const binding = await updateUiState(
        infra,
        ownerId,
        await registerUiClient(infra, ownerId, randomUUID()),
        session.id,
        state,
      );
      const sent = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '创建事件 标题：尚未定位的业务事件',
        historyHours: 24,
        uiBinding: binding,
      });
      const options = {
        apiKey: 'unused',
        fetch: async () => {
          throw new Error('model must not run');
        },
      };
      await processAgentTask(infra, sent.task.id, options, 'focus-worker');
      const waiting = (await getAgentTaskContext(infra, sent.task.id))!;
      expect(waiting.task.status).toBe('waiting_ui');
      expect(waiting.focusResult).toMatchObject({
        kind: 'map_focus',
        displayStatus: 'unlocated',
        missing: [{ kind: 'event' }],
      });
      expect(waiting.artifacts.some((a) => a.kind === 'operational_event')).toBe(true);
      const command = (await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_focus'))!;
      const claimed = await claimUiCommand(infra, ownerId, command.id, binding);
      expect(claimed.focusPresentation).toMatchObject({
        taskId: sent.task.id,
        inputRevision: 0,
        displayStatus: 'unlocated',
      });
      const receipt = {
        ...binding,
        claimToken: claimed.claimToken!,
        receiptId: randomUUID(),
        stepId: 'map_map_focus',
        artifactRef: claimed.artifactRef,
        status: 'executing' as const,
        state: structuredClone(state),
      };
      if (receiptStatus === 'rejected') {
        await receiptUiCommand(infra, ownerId, claimed.id, {
          ...receipt,
          status: 'rejected',
        });
        await processAgentTask(infra, sent.task.id, options, 'after-rejected-focus');
        const failed = (await getAgentTaskContext(infra, sent.task.id))!;
        expect(failed.task.status).toBe('failed');
        expect(failed.task.errorCode).toBe('ui_rejected');
        expect(failed.task.summary).toContain('已保存事件');
        expect(failed.task.error).toContain('已保存');
        expect(
          failed.artifacts.filter((artifact) => artifact.kind === 'operational_event'),
        ).toHaveLength(1);
        const originalEvent = failed.artifacts.find(
          (artifact) => artifact.kind === 'operational_event',
        )!.payload as { event: { id: string } };
        let sourceTaskId = sent.task.id;
        for (let attempt = 0; attempt < 2; attempt++) {
          const retry = await retryAgentTask(infra, ownerId, sourceTaskId, randomUUID(), binding);
          await processAgentTask(infra, retry.task.id, options, `retry-focus-${attempt}`);
          const retried = (await getAgentTaskContext(infra, retry.task.id))!;
          expect(retried.task.status, JSON.stringify(retried.task)).toBe('waiting_ui');
          expect(
            retried.artifacts.find((artifact) => artifact.kind === 'operational_event')?.payload,
          ).toEqual(originalEvent);
          const nextCommand = (await getUiTaskCommand(infra, retry.task.id, 0, 'map_map_focus'))!;
          const nextClaim = await claimUiCommand(infra, ownerId, nextCommand.id, binding);
          expect(nextClaim.artifactRef).not.toBe(claimed.artifactRef);
          const nextReceipt = {
            ...receipt,
            claimToken: nextClaim.claimToken!,
            receiptId: randomUUID(),
            artifactRef: nextClaim.artifactRef,
          };
          await receiptUiCommand(infra, ownerId, nextClaim.id, {
            ...nextReceipt,
            status: attempt === 0 ? 'rejected' : 'executing',
          });
          if (attempt === 1) {
            state.sequence++;
            state.components[0]!.version++;
            state.components[0]!.focusEvidence = {
              artifactRef: nextClaim.artifactRef!,
              taskId: retry.task.id,
              version: 0,
              inputRevision: 0,
              displayStatus: 'unlocated',
            };
            await receiptUiCommand(infra, ownerId, nextClaim.id, {
              ...nextReceipt,
              receiptId: randomUUID(),
              status: 'succeeded',
              state,
            });
          }
          await processAgentTask(infra, retry.task.id, options, `rejected-retry-${attempt}`);
          expect((await getAgentTaskContext(infra, retry.task.id))?.task.status).toBe(
            attempt === 0 ? 'failed' : 'completed',
          );
          sourceTaskId = retry.task.id;
        }
        expect(
          Number(
            (
              await pool.query(
                "SELECT count(*) FROM audit WHERE user_id=$1 AND action='event.create' AND resource_id=$2",
                [ownerId, originalEvent.event.id],
              )
            ).rows[0].count,
          ),
        ).toBe(1);
        const fresh = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
          content: sent.task.goal,
          historyHours: 24,
        });
        await processAgentTask(infra, fresh.task.id, options, 'explicit-new-create');
        const freshResult = (await getAgentTaskContext(infra, fresh.task.id))!;
        const freshEvent = freshResult.artifacts.find(
          (artifact) => artifact.kind === 'operational_event',
        )!.payload as { event: { id: string } };
        expect(freshResult.task.status).toBe('completed');
        expect(freshEvent.event.id).not.toBe(originalEvent.event.id);
        return;
      }
      await receiptUiCommand(infra, ownerId, claimed.id, receipt);
      state.sequence++;
      state.components[0]!.version++;
      state.components[0]!.focusEvidence = {
        artifactRef: claimed.artifactRef!,
        taskId: sent.task.id,
        version: 0,
        inputRevision: 0,
        displayStatus: 'unlocated',
      };
      await receiptUiCommand(infra, ownerId, claimed.id, {
        ...receipt,
        receiptId: randomUUID(),
        status: 'succeeded',
        state,
      });
      await processAgentTask(infra, sent.task.id, options, 'after-focus-receipt');
      const completed = (await getAgentTaskContext(infra, sent.task.id))!;
      expect(completed.task.status).toBe('completed');
      expect(completed.task.summary).toContain('尚无位置');
    },
  );
  it('preserves a located business focus through the real worker completed hook', async () => {
    const priorUi = process.env.AGENT_UI_ENABLED;
    process.env.AGENT_UI_ENABLED = 'false';
    try {
      const session = await createAgentSession(infra, ownerId, 'located business focus');
      const sent = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '创建事件 标题：有位置的回复关联 坐标：121,30',
        historyHours: 24,
      });
      await processAgentTask(infra, sent.task.id, { apiKey: 'unused' }, 'located-business-worker');
      const result = (await getAgentTaskContext(infra, sent.task.id))!;
      expect(result.task.status).toBe('completed');
      const business = result.artifacts.find((artifact) => artifact.kind === 'operational_event')!
        .payload as { event: { id: string; revision: number } };
      const focus = result.artifacts.find((artifact) => artifact.kind === 'map_focus')!.payload;
      expect(result.focusResult).toEqual(focus);
      expect(result.focusResult).toMatchObject({
        displayStatus: 'complete',
        targets: [
          {
            ref: { kind: 'event', id: business.event.id, revision: business.event.revision },
            geometry: { type: 'Point', coordinates: [121, 30] },
          },
        ],
      });
    } finally {
      if (priorUi === undefined) delete process.env.AGENT_UI_ENABLED;
      else process.env.AGENT_UI_ENABLED = priorUi;
    }
  });
  it('reuses the successful dynamic focus receipt without queueing a second focus display', async () => {
    const priorDynamic = process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    const priorUi = process.env.AGENT_UI_ENABLED;
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'true';
    process.env.AGENT_UI_ENABLED = 'true';
    try {
      const event = await createOperationalEvent(
        infra,
        CreateOperationalEventSchema.parse({
          operationId: randomUUID(),
          title: '动态关注回复',
          geometry: { type: 'Point', coordinates: [121, 30] },
        }),
        { id: ownerId, role: 'operator' },
      );
      const definition = DynamicSkillDefinitionSchema.parse({
        schemaVersion: 1,
        name: `focus-once-${randomUUID()}`,
        description: '展示本轮对象关注',
        body: '使用宿主可信对象并等待真实绘制回执。',
        requiredInputs: [],
        toolIds: ['prepare_map_focus'],
        steps: [
          {
            id: 'object_focus',
            toolId: 'prepare_map_focus',
            input: { selection: { $ref: 'input.selection' } },
            artifactKind: 'map_focus',
            ui: { componentId: 'chart.focus', action: 'show' },
          },
        ],
        expectedArtifacts: [{ stepId: 'object_focus', kind: 'map_focus' }],
        requiredDisplays: ['object_focus'],
      });
      const published = await publishOwnedSkill(infra, ownerId, {
        operationId: randomUUID(),
        expectedCatalogRevision: (await listOwnedSkills(infra, ownerId)).catalogRevision,
        definition,
      });
      const session = await createAgentSession(infra, ownerId, 'dynamic focus once');
      const state = UiStateSchema.parse({
        sequence: 1,
        route: '/',
        components: [
          {
            id: 'chart.focus',
            version: 1,
            mounted: true,
            open: false,
            visible: false,
            actions: ['show', 'close', 'focus'],
          },
        ],
      });
      const binding = await updateUiState(
        infra,
        ownerId,
        await registerUiClient(infra, ownerId, randomUUID()),
        session.id,
        state,
      );
      const noReference = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '执行空间关注',
        historyHours: 24,
        skillRef: { skillId: published.skill.skillId },
        mapContext: {
          bbox: [120, 29, 122, 31],
          capturedAt: new Date().toISOString(),
          selectedTargets: [{ kind: 'event', id: event.id, revision: event.revision }],
        },
      });
      expect(noReference.task.selection?.focusTargets).toBeUndefined();
      const sent = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '关注选中事件',
        historyHours: 24,
        skillRef: { skillId: published.skill.skillId },
        uiBinding: binding,
        mapContext: {
          bbox: [120, 29, 122, 31],
          capturedAt: new Date().toISOString(),
          selectedTargets: [{ kind: 'event', id: event.id, revision: event.revision }],
        },
      });
      const options = { apiKey: 'unused', dynamicSkillsEnabled: true };
      await processAgentTask(infra, sent.task.id, options, 'dynamic-focus-first');
      const command = (await getUiTaskCommand(infra, sent.task.id, 0, 'object_focus'))!;
      expect(command).not.toBeNull();
      const claimed = await claimUiCommand(infra, ownerId, command.id, binding);
      const common = {
        ...binding,
        stepId: 'object_focus',
        artifactRef: claimed.artifactRef,
        claimToken: claimed.claimToken!,
      };
      await receiptUiCommand(infra, ownerId, command.id, {
        ...common,
        receiptId: randomUUID(),
        status: 'executing',
        state,
      });
      state.sequence++;
      Object.assign(state.components[0]!, {
        version: 2,
        open: true,
        visible: true,
        focusEvidence: {
          artifactRef: claimed.artifactRef,
          taskId: sent.task.id,
          version: 0,
          inputRevision: 0,
          displayStatus: 'complete',
        },
      });
      await receiptUiCommand(infra, ownerId, command.id, {
        ...common,
        receiptId: randomUUID(),
        status: 'succeeded',
        state,
      });
      await processAgentTask(infra, sent.task.id, options, 'dynamic-focus-resume');
      const result = (await getAgentTaskContext(infra, sent.task.id))!;
      expect(result.task.status, JSON.stringify(result.task)).toBe('completed');
      expect(result.focusResult?.targets[0]?.ref).toMatchObject({
        kind: 'event',
        id: event.id,
        revision: event.revision,
      });
      expect(await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_focus')).toBeNull();
      expect(
        Number(
          (
            await pool.query('SELECT count(*) FROM agent_ui_commands WHERE task_id=$1', [
              sent.task.id,
            ])
          ).rows[0].count,
        ),
      ).toBe(1);
    } finally {
      for (const [key, value] of [
        ['AGENT_DYNAMIC_SKILLS_ENABLED', priorDynamic],
        ['AGENT_UI_ENABLED', priorUi],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  it('completes business writes without queueing invisible focus commands when spatial focus is disabled', async () => {
    const prior = process.env.AGENT_SPATIAL_FOCUS_ENABLED;
    process.env.AGENT_SPATIAL_FOCUS_ENABLED = 'false';
    try {
      const session = await createAgentSession(infra, ownerId, 'focus disabled');
      const state = UiStateSchema.parse({
        sequence: 1,
        route: '/',
        components: [
          {
            id: 'chart.focus',
            version: 1,
            mounted: true,
            open: false,
            visible: false,
            actions: ['show'],
          },
        ],
      });
      const binding = await updateUiState(
        infra,
        ownerId,
        await registerUiClient(infra, ownerId, randomUUID()),
        session.id,
        state,
      );
      const sent = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
        content: '创建事件 标题：关闭空间关注验证',
        historyHours: 24,
        uiBinding: binding,
      });
      await processAgentTask(infra, sent.task.id, { apiKey: 'unused' }, 'disabled-focus-worker');
      const result = (await getAgentTaskContext(infra, sent.task.id))!;
      expect(result.task.status).toBe('completed');
      expect(result.focusResult).toBeNull();
      expect(await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_focus')).toBeNull();
    } finally {
      if (prior === undefined) delete process.env.AGENT_SPATIAL_FOCUS_ENABLED;
      else process.env.AGENT_SPATIAL_FOCUS_ENABLED = prior;
    }
  });
  it('resolves the exact saved track task and version and rejects another session or a missing version', async () => {
    const session = await createAgentSession(infra, ownerId, 'saved track scope');
    const source = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '查询事件',
      historyHours: 24,
    });
    const current = await submitAgentMessage(infra, ownerId, session.id, randomUUID(), {
      content: '查询事件',
      historyHours: 24,
    });
    const query = VesselTracksQuerySchema.parse({
      bbox: [0, 0, 10, 10],
      from: '2026-10-17T00:00:00Z',
      to: '2026-10-17T02:00:00Z',
      selector: { mmsis: ['413123456'] },
    });
    const saved = (offset: number) => ({
      kind: 'vessel_tracks',
      version: offset + 1,
      inputRevision: 0,
      query,
      asOf: '2026-10-18T00:00:00Z',
      generatedAt: '2026-10-18T00:00:00Z',
      shipTypeBasis: 'current_profile',
      selectionBasis: 'historical_observation_in_bbox',
      trackScope: 'full_time_window',
      returnedVessels: 1,
      matchedVesselsLowerBound: 1,
      hasMoreVessels: false,
      tracks: [
        {
          mmsi: '413123456',
          name: '历史船舶',
          shipType: 70,
          segments: [
            {
              points: [
                { lon: 1 + offset, lat: 1, observedAt: '2026-10-17T00:30:00Z' },
                { lon: 2 + offset, lat: 2, observedAt: '2026-10-17T01:00:00Z' },
              ],
            },
          ],
          total: 2,
          returned: 2,
          sampled: false,
          truncated: false,
        },
      ],
    });
    for (const offset of [0, 1])
      await pool.query(
        "INSERT INTO agent_results(task_id,version,results,tracks_result,input_revision,kind) VALUES($1,$2,'[]'::jsonb,$3::jsonb,$4,'vessel_tracks')",
        [source.task.id, offset + 1, JSON.stringify(saved(offset)), offset],
      );
    const context = (await getAgentTaskContext(infra, current.task.id))!;
    const resolver = createFocusResolver(infra);
    const ref = {
      kind: 'track' as const,
      id: '413123456',
      sourceTaskId: source.task.id,
      revision: 1,
    };
    expect(await resolver(ref, context)).toMatchObject({
      geometry: {
        type: 'MultiLineString',
        coordinates: [
          [
            [1, 1],
            [2, 2],
          ],
        ],
      },
    });
    expect(await resolver({ ...ref, revision: 99 }, context)).toBeNull();
    const other = await createAgentSession(infra, ownerId, 'other session');
    expect(
      await resolver(ref, { ...context, task: { ...context.task, sessionId: other.id } }),
    ).toBeNull();
    expect(
      await resolver(ref, { ...context, task: { ...context.task, ownerId: randomUUID() } }),
    ).toBeNull();
  });
});
