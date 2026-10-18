import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Infrastructure } from './clients';
import {
  createAgentSession,
  submitAgentMessage,
  getAgentTaskContext,
  claimAgentTask,
} from './agent';
import { publishOwnedSkill } from './dynamic-skills';
import {
  createUiCommand,
  registerUiClient,
  updateUiState,
  getUiTaskCommand,
  claimUiCommand,
  receiptUiCommand,
} from './agent-ui';
import { UiStateSchema } from '../contracts/agent-ui';
import { DynamicSkillDefinitionSchema } from '../contracts/dynamic-skills';
import { processAgentTask } from '../../apps/agent';
import { saveLatestBatch } from './storage';

describe('dynamic task host-owned automatic focus admission', () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const infra = { pool } as Infrastructure;
  const owner = randomUUID();
  const mmsi = String(990000000 + Math.floor(Math.random() * 1000000));
  const sourceId = `automatic-focus-${owner}`;
  const flags = [
    'AGENT_ENABLED',
    'AGENT_DYNAMIC_SKILLS_ENABLED',
    'AGENT_UI_ENABLED',
    'AGENT_SPATIAL_FOCUS_ENABLED',
  ] as const;
  const original = Object.fromEntries(flags.map((flag) => [flag, process.env[flag]]));
  beforeAll(async () => {
    for (const flag of flags) process.env[flag] = 'true';
    await pool.query(
      "INSERT INTO users(id,username,password_hash,role) VALUES($1::uuid,$1::text,'unused','operator')",
      [owner],
    );
    await saveLatestBatch(infra, [
      {
        schemaVersion: 1,
        cleaningVersion: 1,
        kind: 'position',
        eventId: sourceId,
        captureId: randomUUID(),
        sourceId,
        sourceKind: 'fixture-http',
        sourcePriority: 100,
        runId: null,
        observedAt: new Date(Date.now() - 1000).toISOString(),
        receivedAt: new Date().toISOString(),
        mmsi,
        lat: 22.0843,
        lon: 113.8751,
        sogKnots: 2,
        cogDegrees: 0,
        headingDegrees: null,
        rotDegPerMinute: null,
        navigationStatus: null,
        receptionType: 'UNKNOWN',
        quality: [],
      },
    ]);
  });
  afterAll(async () => {
    for (const flag of flags) {
      if (original[flag] === undefined) delete process.env[flag];
      else process.env[flag] = original[flag];
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM agent_ui_receipts WHERE command_id IN (SELECT id FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1))',
        [owner],
      );
      await client.query(
        'DELETE FROM agent_ui_commands WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)',
        [owner],
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
        await client.query(`DELETE FROM ${table} WHERE owner_id=$1`, [owner]);
      for (const table of ['agent_input_requests', 'agent_steps', 'agent_results'])
        await client.query(
          `DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE owner_id=$1)`,
          [owner],
        );
      for (const table of ['agent_events', 'agent_messages'])
        await client.query(
          `DELETE FROM ${table} WHERE session_id IN (SELECT id FROM agent_sessions WHERE owner_id=$1)`,
          [owner],
        );
      await client.query('DELETE FROM agent_tasks WHERE owner_id=$1', [owner]);
      await client.query('DELETE FROM agent_sessions WHERE owner_id=$1', [owner]);
      await client.query('DELETE FROM audit WHERE user_id=$1', [owner]);
      await client.query('DELETE FROM positions_latest WHERE mmsi=$1', [mmsi]);
      await client.query('DELETE FROM field_provenance WHERE mmsi=$1', [mmsi]);
      await client.query('DELETE FROM vessels WHERE mmsi=$1', [mmsi]);
      await client.query('DELETE FROM users WHERE id=$1', [owner]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  });

  it('queues, claims and acknowledges automatic focus outside the dynamic definition without granting other undeclared UI steps', async () => {
    const definition = DynamicSkillDefinitionSchema.parse({
      schemaVersion: 1,
      name: `auto-focus-${randomUUID()}`,
      description: '查询本轮区域船舶',
      body: '由宿主执行区域查询。',
      requiredInputs: [],
      toolIds: ['query_vessels'],
      steps: [
        {
          id: 'query',
          toolId: 'query_vessels',
          input: { selection: { $ref: 'input.selection' } },
          artifactKind: 'vessel_list',
        },
      ],
      expectedArtifacts: [{ stepId: 'query', kind: 'vessel_list' }],
      requiredDisplays: [],
    });
    const published = await publishOwnedSkill(infra, owner, {
      operationId: randomUUID(),
      expectedCatalogRevision: 0,
      definition,
    });
    const session = await createAgentSession(infra, owner, 'dynamic automatic focus');
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
      owner,
      await registerUiClient(infra, owner, randomUUID()),
      session.id,
      state,
    );
    const sent = await submitAgentMessage(infra, owner, session.id, randomUUID(), {
      content: '查询当前区域船舶',
      historyHours: 24,
      mapContext: { bbox: [113, 21, 115, 23], capturedAt: new Date().toISOString(), sourceId },
      skillRef: { skillId: published.skill.skillId },
      uiBinding: binding,
    });
    const options = {
      apiKey: 'unused',
      dynamicSkillsEnabled: true,
      fetch: async () => {
        throw new Error('model must not run');
      },
    };
    await processAgentTask(infra, sent.task.id, options, 'automatic-focus-worker');
    const waiting = (await getAgentTaskContext(infra, sent.task.id))!;
    expect(waiting.task.errorCode).toBeNull();
    expect(waiting.task.status).toBe('waiting_ui');
    expect(waiting.dynamicSkill.calls).toMatchObject([{ stepId: 'query', status: 'completed' }]);
    const command = (await getUiTaskCommand(infra, sent.task.id, 0, 'map_map_focus'))!;
    expect(command).not.toBeNull();
    const claimed = await claimUiCommand(infra, owner, command.id, binding);
    expect(claimed.focusPresentation).toMatchObject({
      taskId: sent.task.id,
      sessionId: session.id,
      inputRevision: 0,
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
    await expect(
      receiptUiCommand(infra, owner, command.id, { ...receipt, artifactRef: randomUUID() }),
    ).rejects.toMatchObject({ code: 'conflict' });
    await receiptUiCommand(infra, owner, command.id, receipt);
    state.sequence++;
    state.components[0]!.version++;
    state.components[0]!.focusEvidence = {
      artifactRef: claimed.artifactRef!,
      taskId: sent.task.id,
      inputRevision: 0,
      version: claimed.focusPresentation!.version,
      displayStatus: claimed.focusPresentation!.displayStatus,
    };
    await receiptUiCommand(infra, owner, command.id, {
      ...receipt,
      receiptId: randomUUID(),
      status: 'succeeded',
      state,
    });
    const active = (await claimAgentTask(infra, 'unauthorized-step-check', sent.task.id))!;
    await expect(
      createUiCommand(
        infra,
        sent.task.id,
        'unauthorized-step-check',
        active.generation,
        { componentId: 'chart.focus', action: 'show' },
        { stepId: 'undeclared_display', artifactRef: claimed.artifactRef, inputRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      createUiCommand(
        infra,
        sent.task.id,
        'unauthorized-step-check',
        active.generation,
        { componentId: 'chart.focus', action: 'show' },
        { stepId: 'map_map_focus', artifactRef: randomUUID(), inputRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    const otherSession = await createAgentSession(infra, owner, 'cross-task focus reference');
    const otherTask = await submitAgentMessage(infra, owner, otherSession.id, randomUUID(), {
      content: '查询当前区域船舶',
      bbox: [113, 21, 115, 23],
      historyHours: 24,
    });
    const otherActive = (await claimAgentTask(infra, 'cross-task-worker', otherTask.task.id))!;
    await expect(
      createUiCommand(
        infra,
        otherActive.id,
        'cross-task-worker',
        otherActive.generation,
        { componentId: 'chart.focus', action: 'show' },
        { stepId: 'map_map_focus', artifactRef: claimed.artifactRef, inputRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: 'conflict' });
    await pool.query(
      "UPDATE agent_tasks SET status='queued',worker_id=NULL,lease_until=NULL WHERE id=$1",
      [sent.task.id],
    );
    await processAgentTask(infra, sent.task.id, options, 'after-automatic-focus-receipt');
    const completed = (await getAgentTaskContext(infra, sent.task.id))!;
    expect(completed.task.status).toBe('completed');
    expect(completed.dynamicSkill.calls).toMatchObject([{ stepId: 'query', status: 'completed' }]);
    expect(completed.dynamicSkill.calls).toHaveLength(1);
  });
});
