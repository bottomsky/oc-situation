import { SkillSession } from './capabilities';
import { getBusinessSkillCatalog } from './business-capabilities';
import { getAgentTaskContext, renewAgentTask } from '../../packages/infrastructure/agent';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import type { AgentTask } from '../../packages/contracts/agent';
import { UI_COMPONENTS, type UiCommand, type UiReceipt } from '../../packages/contracts/agent-ui';
import { resolveUiOperation } from '../../packages/domain/agent-ui-intent';
import {
  readUiState,
  getUiTaskCommand,
  createUiCommand,
  saveUiResult,
} from '../../packages/infrastructure/agent-ui';
import {
  finishAgentTask,
  reserveAgentCall,
  saveAgentStep,
} from '../../packages/infrastructure/agent';

function uiFailureSummary(
  command: Pick<UiCommand, 'status' | 'operation'> & {
    error?: UiReceipt['error'];
  },
) {
  if (command.status === 'unknown')
    return '操作回执未确认，无法判断界面是否已完成变化；请查看当前页面后再操作。';
  if (command.status === 'expired')
    return '界面命令已过期，页面可能离线或已切换。请回到当前海图后重试。';
  if (command.status === 'cancelled') return '界面操作已取消，请在当前页面发起新操作。';
  if (command.error === 'UNAVAILABLE') {
    if (command.operation.componentId === 'chart.heatmap' && command.operation.action === 'show')
      return '当前页面没有可恢复的热力图快照。请生成热力图并确认区域，或从历史结果点击“在海图展示此快照”。';
    if (
      command.operation.componentId === 'chart.vessel-tracks' &&
      command.operation.action === 'show'
    )
      return '当前页面没有可恢复的航线快照。请从历史结果点击“在海图展示”，或重新生成航线。';
    return '当前操作所需的界面数据不可用，请重新打开对应结果后重试。';
  }
  if (command.error === 'STATE_CONFLICT')
    return '页面状态已改变，本次操作已停止。请在当前页面重新发送指令。';
  if (command.error === 'POSTCONDITION_FAILED')
    return command.operation.componentId === 'chart.heatmap' && command.operation.action === 'show'
      ? '热力图展示未完成：地图绘制尚未确认。请检查海图，或从历史结果重新展示。'
      : '界面操作后的显示状态尚未确认，请检查当前页面后重试。';
  if (command.error === 'EXECUTION_FAILED')
    return '界面操作未完成：浏览器执行失败。请检查当前页面后重试。';
  return '界面操作未完成，未收到具体失败原因。请检查当前页面后重试。';
}

/** Local, finite planner. User text and UI state never become external model instructions. */
export async function executeUiTask(
  infra: Infrastructure,
  task: AgentTask,
  worker: string,
  maxCalls: number,
) {
  const fence = [infra, task.id, worker, task.generation] as const;
  try {
    if (process.env.AGENT_UI_ENABLED !== 'true')
      throw new Error('智能体界面控制尚未启用，请启用 AGENT_UI_ENABLED。');
    if (!task.uiBinding) throw new Error('没有可操作的页面，请刷新当前页面后重新发送。');
    const context = await getAgentTaskContext(infra, task.id);
    const skill = new SkillSession(
      await getBusinessSkillCatalog(),
      {
        active: () => renewAgentTask(...fence),
        reserve: (kind, maximum) => reserveAgentCall(...fence, kind, maximum),
        saveStep: (key, name, output) =>
          saveAgentStep(...fence, { key, name, input: null, output }),
      },
      {
        identity: {
          ownerId: task.ownerId,
          taskId: task.id,
          inputRevision: task.inputRevision ?? 0,
          generation: task.generation,
        },
        steps: context?.steps ?? [],
        maxToolCalls: maxCalls,
      },
    );
    await skill.activate('ui-control');
    const saved = await getUiTaskCommand(infra, task.id, task.inputRevision ?? 0);
    if (saved) {
      await saveAgentStep(...fence, {
        key: 'ui_command_receipt',
        name: 'ui.get_command',
        input: null,
        output: {
          commandId: saved.id,
          status: saved.status,
          ...(saved.error ? { error: saved.error } : {}),
        },
      });
      if (saved.status === 'succeeded' && saved.result) {
        await saveUiResult(...fence, saved.id, saved.status, saved.result);
        const verb = ['close', 'hide'].includes(saved.operation.action)
          ? '已关闭'
          : saved.operation.action === 'focus'
            ? '已定位'
            : '已显示';
        const calculation = context?.steps.find((step) => step.key === 'ui_presentation_summary')
          ?.output as { summary?: string } | undefined;
        await finishAgentTask(...fence, {
          status: 'completed',
          summary: `${calculation?.summary ? calculation.summary + ' ' : ''}${verb}${UI_COMPONENTS[saved.operation.componentId]}。${saved.operation.componentId === 'chart.heatmap' && saved.operation.action === 'close' ? '相关图例和网格浮窗已收起，历史结果保留。' : saved.operation.componentId === 'chart.vessel-tracks' && saved.operation.action === 'close' ? '批量航线与在途加载已关闭，历史结果保留。' : ''}`,
        });
      } else
        await finishAgentTask(...fence, {
          status: 'failed',
          errorCode: `ui_${saved.status}`,
          summary: uiFailureSummary(saved),
        });
      return;
    }
    if (!(await reserveAgentCall(...fence, 'tool', maxCalls))) {
      await finishAgentTask(...fence, {
        status: 'failed',
        errorCode: 'budget_exhausted',
        summary: '本次界面操作达到调用预算，请发起新尝试。',
      });
      return;
    }
    const state = await readUiState(infra, task.ownerId, task.uiBinding, task.sessionId);
    await saveAgentStep(...fence, {
      key: 'ui_state',
      name: 'ui.get_state',
      input: null,
      output: state,
    });
    await saveAgentStep(...fence, {
      key: 'ui_capabilities',
      name: 'ui.list_capabilities',
      input: null,
      output: state.components.map((c) => ({ id: c.id, actions: c.actions })),
    });
    const operation = resolveUiOperation(task.goal, state);
    if (operation === 'ambiguous') {
      await finishAgentTask(...fence, {
        status: 'awaiting_input',
        summary: '无法唯一确定要操作的窗口，请明确名称，例如“关闭热力图”或“关闭情报来源详情”。',
      });
      return;
    }
    if (!operation) {
      await saveUiResult(...fence, null, 'observed', state);
      const open = state.components
        .filter((c) => c.id !== 'app.page' && c.mounted && c.open)
        .map(
          (c) =>
            `${UI_COMPONENTS[c.id]}${c.visible ? '' : '（当前被遮挡或收起）'}${c.loading ? '（加载中）' : ''}`,
        );
      await finishAgentTask(...fence, {
        status: 'completed',
        summary: `当前页面：${state.route}。${open.length ? `已打开：${open.join('、')}。` : '没有已登记的打开面板或浮窗。'}仅包含当前页面已接入协议的界面状态。`,
      });
      return;
    }
    if (!(await reserveAgentCall(...fence, 'tool', maxCalls))) {
      await finishAgentTask(...fence, {
        status: 'failed',
        errorCode: 'budget_exhausted',
        summary: '本次界面操作达到调用预算，请发起新尝试。',
      });
      return;
    }
    await saveAgentStep(...fence, {
      key: 'ui_execute',
      name: 'ui.execute',
      input: operation,
      output: { status: 'requested' },
    });
    await createUiCommand(...fence, operation);
  } catch (e) {
    if ((e as { code?: string }).code === 'budget') {
      await finishAgentTask(...fence, {
        status: 'failed',
        errorCode: 'budget_exhausted',
        summary: '本次界面操作达到调用预算，请发起新尝试。',
      });
      return;
    }
    const message =
      e instanceof Error && !('code' in e) ? e.message : '界面状态暂不可用，请刷新当前页面后重试。';
    await finishAgentTask(...fence, {
      status: 'failed',
      errorCode: 'ui_unavailable',
      summary: message.slice(0, 240),
    });
  }
}
