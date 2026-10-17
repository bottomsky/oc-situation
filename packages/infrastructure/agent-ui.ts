import { isDeepStrictEqual } from 'node:util';
import type { AgentSkillFence } from '../contracts/dynamic-skills';
import { AgentHeatmapResultSchema } from '../contracts/heatmap';
import { AgentVesselTracksResultSchema } from '../contracts/vessel-tracks';
import {
  AgentVesselHighlightsResultSchema,
  AgentMapCameraResultSchema,
} from '../contracts/agent-map';
import type { AgentTask } from '../contracts/agent';
import { assertDynamicSkillUiAvailable } from './dynamic-skills';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  UiStateSchema,
  UiOperationSchema,
  UiReceiptSchema,
  uiOperationAllowed,
  uiCommandPostcondition,
  type UiBinding,
  type UiState,
  type UiOperation,
  type UiReceipt,
  type UiCommand,
} from '../contracts/agent-ui';
import type { Infrastructure } from './clients';
import { transaction, lockTask, fenced, canWrite, event, AgentInputError } from './agent';

const conflict = (message = '当前页面或操作状态已改变，请重试。'): never => {
  throw new AgentInputError('conflict', message);
};
const enabled = () =>
  process.env.AGENT_ENABLED === 'true' && process.env.AGENT_UI_ENABLED === 'true';
export function assertUiEnabled() {
  if (!enabled()) throw new AgentInputError('not_found', '智能体界面控制尚未启用。');
}
export async function registerUiClient(infra: Infrastructure, owner: string, instance: string) {
  assertUiEnabled();
  return transaction(infra, async (c) => {
    if (!(await canWrite(c, owner))) throw new AgentInputError('forbidden', '无界面操作权限');
    const row = (
      await c.query(
        `INSERT INTO agent_ui_clients(id,instance_id,owner_id,lease_until) VALUES($1,$2,$3,now()+interval '30 seconds')
      ON CONFLICT(owner_id,instance_id) DO UPDATE SET lease_until=now()+interval '30 seconds' RETURNING id,page_generation`,
        [randomUUID(), instance, owner],
      )
    ).rows[0];
    return { clientId: row.id as string, pageGeneration: Number(row.page_generation) };
  });
}
export async function updateUiState(
  infra: Infrastructure,
  owner: string,
  binding: UiBinding,
  session: string | null,
  input: UiState,
) {
  assertUiEnabled();
  const state = UiStateSchema.parse(input);
  return transaction(infra, async (c) => {
    if (!(await canWrite(c, owner))) throw new AgentInputError('forbidden', '无界面操作权限');
    if (
      session &&
      !(
        await c.query('SELECT id FROM agent_sessions WHERE id=$1 AND owner_id=$2', [session, owner])
      ).rowCount
    )
      throw new AgentInputError('not_found', '会话不存在');
    const row = (
      await c.query('SELECT * FROM agent_ui_clients WHERE id=$1 AND owner_id=$2 FOR UPDATE', [
        binding.clientId,
        owner,
      ])
    ).rows[0];
    if (!row || Number(row.page_generation) !== binding.pageGeneration) return conflict();
    const changed = row.session_id !== session || (row.state && row.state.route !== state.route);
    if (!changed && Number(row.state_sequence) >= state.sequence) {
      if (Number(row.state_sequence) === state.sequence && isDeepStrictEqual(row.state, state))
        return binding;
      return conflict('界面状态序号已过期。');
    }
    if (!changed && row.state)
      for (const component of state.components) {
        const previous = (row.state as UiState).components.find((x) => x.id === component.id);
        if (
          previous &&
          (component.version < previous.version ||
            (component.version === previous.version && !isDeepStrictEqual(component, previous)))
        )
          return conflict('组件版本已过期。');
      }
    const next = binding.pageGeneration + (changed ? 1 : 0);
    await c.query(
      `UPDATE agent_ui_clients SET page_generation=$2,session_id=$3,state=$4::jsonb,state_sequence=$5,observed_at=now(),lease_until=now()+interval '30 seconds' WHERE id=$1`,
      [binding.clientId, next, session, JSON.stringify(state), state.sequence],
    );
    return { clientId: binding.clientId, pageGeneration: next };
  });
}
export async function readUiState(
  infra: Infrastructure,
  owner: string,
  binding: UiBinding,
  session: string,
) {
  assertUiEnabled();
  const row = (
    await infra.pool.query(
      `SELECT state,observed_at>now()-interval '10 seconds' AS fresh FROM agent_ui_clients WHERE id=$1 AND owner_id=$2 AND page_generation=$3 AND session_id=$4 AND lease_until>now()`,
      [binding.clientId, owner, binding.pageGeneration, session],
    )
  ).rows[0];
  if (!row) return conflict('发送指令的页面已离线或切换，请在当前页面重新发送。');
  if (!row.fresh || !row.state) return conflict('界面状态已过期，正在等待页面同步，请稍后重试。');
  return UiStateSchema.parse(row.state);
}
const commandView = (row: Record<string, unknown>, token = false): UiCommand => ({
  id: String(row.id),
  taskId: String(row.task_id),
  clientId: String(row.client_id),
  pageGeneration: Number(row.page_generation),
  operation: UiOperationSchema.parse(row.operation),
  expectedVersion: Number(row.expected_version),
  status: row.status as UiCommand['status'],
  ...(row.step_id && row.step_id !== 'legacy' ? { stepId: String(row.step_id) } : {}),
  ...(row.artifact_ref ? { artifactRef: String(row.artifact_ref) } : {}),
  ...(token ? { claimToken: String(row.claim_token) } : {}),
});
const isBuiltinMap = (task: Record<string, unknown>) =>
  ['vessel_highlights', 'map_camera'].includes(String(task.intent));
async function mapArtifact(
  c: PoolClient,
  task: Record<string, unknown>,
  stepId: string,
  artifactRef: string,
) {
  const row = (
    await c.query(
      'SELECT output FROM agent_steps WHERE task_id=$1 AND input_revision=$2 AND step_key=$3',
      [task.id, task.input_revision, stepId],
    )
  ).rows[0];
  if (!row || row.output?.artifactRef !== artifactRef) return conflict('地图产物与任务不匹配。');
  const payload = row.output.payload;
  if (stepId === 'map_vessel_highlights' && task.intent === 'vessel_highlights') {
    const result = AgentVesselHighlightsResultSchema.parse(payload);
    if (result.inputRevision !== Number(task.input_revision)) return conflict();
    return {
      payload: result,
      operation: {
        componentId: 'chart.vessel-highlights',
        action: result.operation === 'show' ? 'show' : 'close',
      } as UiOperation,
    };
  }
  if (
    stepId === 'map_map_camera' &&
    (task.intent === 'map_camera' ||
      (task.intent === 'vessel_highlights' &&
        (task.selection as { highlightAndFocus?: boolean })?.highlightAndFocus))
  ) {
    const result = AgentMapCameraResultSchema.parse(payload);
    if (result.inputRevision !== Number(task.input_revision)) return conflict();
    return {
      payload: result,
      operation: { componentId: 'chart.viewport', action: 'focus' } as UiOperation,
    };
  }
  return conflict('地图步骤与任务不匹配。');
}
async function injectArtifact(
  c: PoolClient,
  task: Record<string, unknown>,
  q: Record<string, unknown>,
  view: UiCommand,
) {
  if (isBuiltinMap(task)) {
    const artifact = await mapArtifact(c, task, String(q.step_id), String(q.artifact_ref));
    if (!isDeepStrictEqual(artifact.operation, view.operation)) return conflict();
    if (artifact.payload.kind === 'vessel_highlights')
      view.highlightsPresentation = artifact.payload;
    else view.cameraPresentation = artifact.payload;
  } else if (task.intent === 'skill') {
    const admitted = await assertDynamicSkillUiAvailable(
      c,
      task,
      String(q.step_id),
      String(q.artifact_ref),
    );
    if (admitted.artifact.kind === 'ais_heatmap')
      view.presentation = AgentHeatmapResultSchema.parse(admitted.artifact.payload);
    if (admitted.artifact.kind === 'vessel_tracks')
      view.tracksPresentation = AgentVesselTracksResultSchema.parse(admitted.artifact.payload);
    if (admitted.artifact.kind === 'vessel_highlights')
      view.highlightsPresentation = AgentVesselHighlightsResultSchema.parse(
        admitted.artifact.payload,
      );
    if (admitted.artifact.kind === 'map_camera')
      view.cameraPresentation = AgentMapCameraResultSchema.parse(admitted.artifact.payload);
  }
  if (
    view.highlightsPresentation &&
    (!isDeepStrictEqual(view.operation, {
      componentId: 'chart.vessel-highlights',
      action: view.highlightsPresentation.operation === 'show' ? 'show' : 'close',
    }) ||
      view.highlightsPresentation.inputRevision !== Number(task.input_revision))
  )
    return conflict('高亮操作与已保存产物不一致。');
  if (
    view.cameraPresentation &&
    (!isDeepStrictEqual(view.operation, { componentId: 'chart.viewport', action: 'focus' }) ||
      view.cameraPresentation.inputRevision !== Number(task.input_revision))
  )
    return conflict('镜头操作与已保存产物不一致。');
}

/** Browser group reports only identify groups; persisted commands establish their authority. */
async function validateHighlightGroups(
  c: PoolClient,
  task: Record<string, unknown>,
  binding: UiBinding,
  state: UiState,
  ids?: string[],
) {
  const groups =
    state.components.find((item) => item.id === 'chart.vessel-highlights')?.highlightGroups ?? [];
  const chosen = ids ? groups.filter((g) => ids.includes(g.groupId)) : groups;
  if (ids && chosen.length !== new Set(ids).size)
    return conflict('指定高亮组已清除或不在当前页面。');
  for (const group of chosen) {
    const row = (
      await c.query(
        `SELECT q.* FROM agent_ui_commands q JOIN agent_tasks t ON t.id=q.task_id WHERE q.artifact_ref=$1 AND q.task_id=$2 AND t.owner_id=$3 AND q.client_id=$4 AND q.page_generation<=$5 AND q.status='succeeded' AND q.operation->>'componentId'='chart.vessel-highlights'`,
        [group.groupId, group.taskId, task.owner_id, binding.clientId, binding.pageGeneration],
      )
    ).rows[0];
    if (!row) return conflict('高亮组缺少当前用户与页面的可信来源。');
    const evidence = UiStateSchema.parse(row.result)
      .components.find((item) => item.id === 'chart.vessel-highlights')
      ?.highlightGroups?.find((g) => g.groupId === group.groupId);
    if (!evidence || !isDeepStrictEqual(evidence, group))
      return conflict('高亮组目标与已验证来源不一致。');
  }
}
export async function readTaskHighlightGroups(infra: Infrastructure, task: AgentTask) {
  if (!task.uiBinding) return conflict('消息缺少当前页面绑定。');
  const state = await readUiState(infra, task.ownerId, task.uiBinding, task.sessionId);
  return transaction(infra, async (c) => {
    await validateHighlightGroups(c, { owner_id: task.ownerId }, task.uiBinding!, state);
    return (
      state.components.find((item) => item.id === 'chart.vessel-highlights')?.highlightGroups ?? []
    );
  });
}
export async function getUiTaskCommand(
  infra: Infrastructure,
  taskId: string,
  revision: number,
  stepId = 'legacy',
): Promise<(UiCommand & { result: UiState | null; error?: UiReceipt['error'] }) | null> {
  const row = (
    await infra.pool.query(
      `SELECT q.*,(SELECT r.body->>'error' FROM agent_ui_receipts r
        WHERE r.command_id=q.id AND r.body->>'status' IN ('succeeded','failed','rejected')
        ORDER BY r.created_at DESC,r.receipt_id DESC LIMIT 1) AS receipt_error
       FROM agent_ui_commands q WHERE q.task_id=$1 AND q.input_revision=$2 AND q.step_id=$3`,
      [taskId, revision, stepId],
    )
  ).rows[0];
  if (!row) return null;
  const error = UiReceiptSchema.shape.error.safeParse(row.receipt_error);
  return {
    ...commandView(row),
    result: row.result as UiState | null,
    ...(['failed', 'rejected'].includes(row.status) && error.success && error.data
      ? { error: error.data }
      : {}),
  };
}
export async function createUiCommand(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  operation: UiOperation,
  options: { stepId?: string; artifactRef?: string; inputRevision?: number } = {},
) {
  assertUiEnabled();
  const op = UiOperationSchema.parse(operation);
  if (!uiOperationAllowed(op)) return conflict('该界面操作尚未支持。');
  return transaction(infra, async (c) => {
    const task = await fenced(c, taskId, workerId, generation);
    if (!task) return null;
    if (
      options.inputRevision !== undefined &&
      Number(task.input_revision) !== options.inputRevision
    )
      return null;
    const stepId = options.stepId ?? 'legacy';
    if (task.intent === 'skill') {
      const admitted = await assertDynamicSkillUiAvailable(c, task, stepId, options.artifactRef);
      if (!isDeepStrictEqual(admitted.operation, op)) return conflict('界面操作与技能声明不匹配。');
    } else if (isBuiltinMap(task)) {
      const admitted = await mapArtifact(c, task, stepId, String(options.artifactRef));
      if (!isDeepStrictEqual(admitted.operation, op)) return conflict();
      await c.query(
        `INSERT INTO agent_ui_artifacts(id,task_id,owner_id,input_revision,step_id,kind,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(task_id,input_revision,step_id) DO NOTHING`,
        [
          options.artifactRef,
          task.id,
          task.owner_id,
          task.input_revision,
          stepId,
          admitted.payload.kind,
          JSON.stringify(admitted.payload),
        ],
      );
    } else if (stepId !== 'legacy' || options.artifactRef) return conflict();
    const existing = (
      await c.query(
        'SELECT id,status FROM agent_ui_commands WHERE task_id=$1 AND input_revision=$2 AND step_id=$3',
        [taskId, task.input_revision, stepId],
      )
    ).rows[0];
    if (existing) return String(existing.id);
    const binding = task.ui_binding as UiBinding | null;
    if (!binding) return conflict('消息缺少当前页面绑定，请刷新页面后重试。');
    const row = (
      await c.query(
        `SELECT * FROM agent_ui_clients WHERE id=$1 AND owner_id=$2 AND page_generation=$3 AND session_id=$4 AND lease_until>now() AND observed_at>now()-interval '10 seconds' FOR UPDATE`,
        [binding.clientId, task.owner_id, binding.pageGeneration, task.session_id],
      )
    ).rows[0];
    if (!row) return conflict();
    const state = UiStateSchema.parse(row.state);
    const component = state.components.find((x) => x.id === op.componentId);
    if (
      (task.intent === 'skill' &&
        (op.action === 'show' ||
          op.componentId === 'chart.viewport' ||
          op.componentId === 'chart.vessel-highlights')) ||
      isBuiltinMap(task)
    ) {
      const previous = (
        await c.query(
          "SELECT result FROM agent_ui_commands WHERE task_id=$1 AND input_revision=$2 AND status='succeeded' AND operation->>'componentId'=$3 ORDER BY created_at DESC,id DESC LIMIT 1",
          [taskId, task.input_revision, op.componentId],
        )
      ).rows[0];
      const acknowledged = previous?.result
        ? UiStateSchema.parse(previous.result).components.find((item) => item.id === op.componentId)
            ?.version
        : undefined;
      const baseline =
        acknowledged ??
        (op.componentId === 'chart.heatmap'
          ? binding.heatmapVersion
          : op.componentId === 'chart.vessel-highlights'
            ? binding.highlightsVersion
            : op.componentId === 'chart.viewport'
              ? binding.cameraVersion
              : binding.tracksVersion);
      if (baseline === undefined || baseline !== component?.version)
        return conflict('图层状态已被人工改变；已保存计算产物，请在新任务中确认展示。');
    }
    if (op.componentId === 'chart.vessel-highlights') {
      const view = commandView({
        id: randomUUID(),
        task_id: task.id,
        client_id: binding.clientId,
        page_generation: binding.pageGeneration,
        operation: op,
        expected_version: component?.version,
        status: 'queued',
        step_id: stepId,
        artifact_ref: options.artifactRef,
      });
      await injectArtifact(c, task, { step_id: stepId, artifact_ref: options.artifactRef }, view);
      const presentation = view.highlightsPresentation;
      if (!presentation) return conflict();
      if (presentation.operation === 'clear')
        await validateHighlightGroups(
          c,
          task,
          binding,
          state,
          presentation.clear?.mode === 'groups' ? presentation.clear.groupIds : undefined,
        );
      else {
        if ((component?.highlightGroups?.length ?? 0) >= 100)
          return conflict('本页高亮组超过上限，请先清除部分高亮组。');
        const mmsis = new Set([
          ...(component?.highlightGroups ?? []).flatMap((g) => g.mmsis),
          ...presentation.vessels.map((v) => v.mmsi),
        ]);
        if (mmsis.size > 100) return conflict('本页高亮船舶超过 100 艘，请先清除部分高亮组。');
      }
    }
    if (
      task.intent === 'vessel_tracks' &&
      op.componentId === 'chart.vessel-tracks' &&
      binding.tracksVersion !== component?.version
    )
      return conflict('航线展示状态已改变；计算结果已保留，请手动重新展示。');
    if (
      task.intent === 'ais_heatmap' &&
      op.componentId === 'chart.heatmap' &&
      binding.heatmapVersion !== component?.version
    )
      return conflict('热图展示状态已改变；计算结果已保留，请手动重新展示。');
    if (
      state.route !== '/' ||
      !component?.mounted ||
      !component.actions.includes(op.action) ||
      component.blocked
    )
      return conflict('该组件当前不可操作，或存在人工交互，请先完成当前操作。');
    const id = randomUUID();
    await c.query(
      `INSERT INTO agent_ui_commands(id,task_id,input_revision,task_generation,client_id,page_generation,operation,expected_version,status,step_id,artifact_ref)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,'queued',$9,$10) ON CONFLICT(task_id,input_revision,step_id) DO NOTHING`,
      [
        id,
        taskId,
        task.input_revision,
        generation,
        binding.clientId,
        binding.pageGeneration,
        JSON.stringify(op),
        component.version,
        stepId,
        options.artifactRef ?? null,
      ],
    );
    await c.query(
      "UPDATE agent_tasks SET status='waiting_ui',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
      [taskId],
    );
    await event(c, String(task.session_id), taskId, 'task.waiting_ui', {
      componentId: op.componentId,
      action: op.action,
      stepId,
      artifactRef: options.artifactRef ?? null,
    });
    return id;
  });
}
export async function listUiCommands(infra: Infrastructure, owner: string, binding: UiBinding) {
  assertUiEnabled();
  const rows = await infra.pool.query(
    `SELECT q.* FROM agent_ui_commands q JOIN agent_ui_clients c ON c.id=q.client_id JOIN agent_tasks t ON t.id=q.task_id
    WHERE c.id=$1 AND c.owner_id=$2 AND c.page_generation=$3 AND q.page_generation=c.page_generation AND c.lease_until>now()
    AND t.status='waiting_ui' AND t.generation=q.task_generation AND t.input_revision=q.input_revision AND q.status IN ('queued','claimed','executing') ORDER BY q.created_at LIMIT 100`,
    [binding.clientId, owner, binding.pageGeneration],
  );
  return rows.rows.map((row) => commandView(row));
}
async function commandLocks(c: PoolClient, owner: string, id: string, binding: UiBinding) {
  if (!(await canWrite(c, owner))) throw new AgentInputError('forbidden', '无界面操作权限');
  const initial = (
    await c.query(
      'SELECT q.task_id FROM agent_ui_commands q JOIN agent_tasks t ON t.id=q.task_id WHERE q.id=$1 AND t.owner_id=$2',
      [id, owner],
    )
  ).rows[0];
  if (!initial) throw new AgentInputError('not_found', '命令不存在');
  const task = await lockTask(c, initial.task_id);
  const client = (
    await c.query(
      'SELECT *,lease_until>now() AS live FROM agent_ui_clients WHERE id=$1 AND owner_id=$2 FOR UPDATE',
      [binding.clientId, owner],
    )
  ).rows[0];
  const q = (
    await c.query(
      'SELECT *,expires_at>now() AS live,claim_until>now() AS claimed_live FROM agent_ui_commands WHERE id=$1 FOR UPDATE',
      [id],
    )
  ).rows[0];
  if (
    !task ||
    !client ||
    q.client_id !== client.id ||
    q.page_generation !== binding.pageGeneration ||
    client.page_generation !== binding.pageGeneration ||
    task.session_id !== client.session_id ||
    !client.live
  )
    return conflict();
  if (Number(task.input_revision) !== Number(q.input_revision)) return conflict();
  return { task, client, q };
}
export async function claimUiCommand(
  infra: Infrastructure,
  owner: string,
  id: string,
  binding: UiBinding,
) {
  assertUiEnabled();
  return transaction(infra, async (c) => {
    const { task, q } = await commandLocks(c, owner, id, binding);
    if (
      task.status !== 'waiting_ui' ||
      task.generation !== q.task_generation ||
      !q.live ||
      !['queued', 'claimed'].includes(q.status) ||
      (q.status === 'claimed' && q.claimed_live)
    )
      return conflict();
    const row = (
      await c.query(
        "UPDATE agent_ui_commands SET status='claimed',claim_token=$2,claim_until=now()+interval '30 seconds' WHERE id=$1 RETURNING *",
        [id, randomUUID()],
      )
    ).rows[0];
    const view = commandView(row, true);
    await injectArtifact(c, task, q, view);
    if (
      task.intent === 'ais_heatmap' &&
      view.operation.componentId === 'chart.heatmap' &&
      view.operation.action === 'show'
    ) {
      const result = (
        await c.query(
          'SELECT heatmap_result FROM agent_results WHERE task_id=$1 AND version=$2 AND input_revision=$3',
          [task.id, task.result_version, task.input_revision],
        )
      ).rows[0];
      if (result?.heatmap_result) view.presentation = result.heatmap_result;
    }
    if (
      task.intent === 'vessel_tracks' &&
      view.operation.componentId === 'chart.vessel-tracks' &&
      view.operation.action === 'show'
    ) {
      const result = (
        await c.query(
          'SELECT tracks_result FROM agent_results WHERE task_id=$1 AND version=$2 AND input_revision=$3',
          [task.id, task.result_version, task.input_revision],
        )
      ).rows[0];
      if (result?.tracks_result) view.tracksPresentation = result.tracks_result;
    }
    return view;
  });
}
export async function receiptUiCommand(
  infra: Infrastructure,
  owner: string,
  id: string,
  receipt: UiReceipt,
) {
  assertUiEnabled();
  return transaction(infra, async (c) => {
    const { task, client, q } = await commandLocks(c, owner, id, receipt);
    if (
      (task.intent === 'skill' || isBuiltinMap(task)) &&
      (receipt.stepId !== q.step_id || receipt.artifactRef !== q.artifact_ref)
    )
      return conflict();
    const old = (
      await c.query('SELECT body FROM agent_ui_receipts WHERE receipt_id=$1 AND command_id=$2', [
        receipt.receiptId,
        id,
      ])
    ).rows[0];
    if (old) {
      // JSONB ordering is not significant.
      if (
        !(
          await c.query('SELECT 1 FROM agent_ui_receipts WHERE receipt_id=$1 AND body=$2::jsonb', [
            receipt.receiptId,
            JSON.stringify(receipt),
          ])
        ).rowCount
      )
        return conflict();
      return { status: q.status };
    }
    if (task.intent === 'skill')
      await assertDynamicSkillUiAvailable(c, task, String(q.step_id), String(q.artifact_ref));
    if (
      task.status !== 'waiting_ui' ||
      task.generation !== q.task_generation ||
      q.claim_token !== receipt.claimToken ||
      !q.claimed_live ||
      !q.live
    )
      return conflict();
    const state = UiStateSchema.parse(receipt.state);
    const op = UiOperationSchema.parse(q.operation);
    const component = state.components.find((x) => x.id === op.componentId);
    if (state.route !== '/' || !component || !uiOperationAllowed(op)) return conflict();
    if (receipt.status === 'executing') {
      if (
        q.status !== 'claimed' ||
        component.version !== q.expected_version ||
        !component.actions.includes(op.action) ||
        component.blocked
      )
        return conflict();
    } else if (
      q.status !== 'executing' &&
      !(q.status === 'claimed' && receipt.status === 'rejected')
    )
      return conflict();
    const view = commandView(q);
    let postcondition = true;
    if (receipt.status === 'succeeded') {
      await injectArtifact(c, task, q, view);
      const previous = (
        await c.query(
          "SELECT body->'state' AS state FROM agent_ui_receipts WHERE command_id=$1 AND body->>'status'='executing' ORDER BY created_at DESC LIMIT 1",
          [id],
        )
      ).rows[0]?.state;
      postcondition = uiCommandPostcondition(
        view,
        state,
        previous ? UiStateSchema.parse(previous) : undefined,
      );
    }
    const status = receipt.status === 'succeeded' && !postcondition ? 'failed' : receipt.status;
    await c.query(
      'INSERT INTO agent_ui_receipts(receipt_id,command_id,body) VALUES($1,$2,$3::jsonb)',
      [receipt.receiptId, id, JSON.stringify(receipt)],
    );
    await c.query('UPDATE agent_ui_commands SET status=$2,result=$3::jsonb WHERE id=$1', [
      id,
      status,
      JSON.stringify(state),
    ]);
    if (state.sequence > Number(client.state_sequence))
      await c.query(
        'UPDATE agent_ui_clients SET state=$2::jsonb,state_sequence=$3,observed_at=now() WHERE id=$1',
        [client.id, JSON.stringify(state), state.sequence],
      );
    await event(c, String(task.session_id), String(task.id), `ui.${status}`, {
      commandId: id,
      componentId: op.componentId,
    });
    if (status !== 'executing') {
      if (task.intent === 'skill')
        await c.query(
          "UPDATE agent_skill_calls SET status=$4,error_code=$5,updated_at=now() WHERE task_id=$1 AND input_revision=$2 AND step_id=$3 AND status='waiting_ui'",
          [
            task.id,
            task.input_revision,
            q.step_id,
            status === 'succeeded' ? 'completed' : 'failed',
            status === 'succeeded' ? null : `ui_${status}`,
          ],
        );
      await c.query(
        "UPDATE agent_tasks SET status='queued',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
        [task.id],
      );
      await event(c, String(task.session_id), String(task.id), 'task.queued');
    }
    return { status };
  });
}
/** Reconcile abandoned pages without replaying a command that might already have acted. */
export async function expireUiCommands(infra: Infrastructure) {
  const rows = (
    await infra.pool
      .query(`SELECT q.id,q.task_id FROM agent_ui_commands q JOIN agent_ui_clients c ON c.id=q.client_id JOIN agent_tasks t ON t.id=q.task_id
    WHERE q.status IN ('queued','claimed','executing') AND (q.expires_at<now() OR c.lease_until<now() OR c.page_generation<>q.page_generation OR t.status<>'waiting_ui') LIMIT 100`)
  ).rows;
  for (const item of rows)
    await transaction(infra, async (c) => {
      const task = await lockTask(c, item.task_id);
      if (!task) return;
      const result = await c.query(
        `UPDATE agent_ui_commands q SET status=CASE WHEN q.status='executing' THEN 'unknown' ELSE 'expired' END FROM agent_ui_clients u
      WHERE q.id=$1 AND u.id=q.client_id AND q.status IN ('queued','claimed','executing') AND (q.expires_at<now() OR u.lease_until<now() OR u.page_generation<>q.page_generation OR $2<>'waiting_ui') RETURNING q.id`,
        [item.id, task.status],
      );
      if (result.rowCount && task.status === 'waiting_ui') {
        if (task.intent === 'skill')
          await c.query(
            "UPDATE agent_skill_calls s SET status=CASE WHEN q.status='unknown' THEN 'unknown' ELSE 'failed' END,error_code='ui_outcome_unknown',updated_at=now() FROM agent_ui_commands q WHERE q.id=$1 AND s.task_id=q.task_id AND s.input_revision=q.input_revision AND s.step_id=q.step_id AND s.status='waiting_ui'",
            [item.id],
          );
        await c.query(
          "UPDATE agent_tasks SET status='queued',worker_id=NULL,lease_until=NULL,updated_at=now() WHERE id=$1",
          [item.task_id],
        );
        await event(c, String(task.session_id), item.task_id, 'task.queued');
      }
    });
}

export async function queueDynamicSkillUi(
  infra: Infrastructure,
  fence: AgentSkillFence,
  stepId: string,
  artifactRef: string,
  operation: UiOperation,
) {
  return createUiCommand(infra, fence.taskId, fence.workerId, fence.generation, operation, {
    stepId,
    artifactRef,
    inputRevision: fence.inputRevision,
  });
}
export async function saveUiResult(
  infra: Infrastructure,
  taskId: string,
  workerId: string,
  generation: number,
  commandId: string | null,
  status: string,
  state: UiState,
) {
  return transaction(infra, async (c) => {
    if (!(await fenced(c, taskId, workerId, generation))) return false;
    await c.query('UPDATE agent_tasks SET ui_result=$2::jsonb WHERE id=$1', [
      taskId,
      JSON.stringify({ kind: 'ui_control', commandId, status, components: state.components }),
    ]);
    return true;
  });
}
