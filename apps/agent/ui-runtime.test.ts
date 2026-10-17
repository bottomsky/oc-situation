import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTask } from '../../packages/contracts/agent';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import { executeUiTask } from './ui-runtime';

const mocks = vi.hoisted(() => ({
  getCommand: vi.fn(),
  finish: vi.fn(),
  saveStep: vi.fn(),
  saveResult: vi.fn(),
}));
vi.mock('./capabilities', () => ({
  SkillSession: class {
    async activate() {}
  },
}));
vi.mock('./business-capabilities', () => ({ getBusinessSkillCatalog: async () => ({}) }));
vi.mock('../../packages/infrastructure/agent', () => ({
  getAgentTaskContext: async () => ({ steps: [] }),
  renewAgentTask: async () => true,
  finishAgentTask: mocks.finish,
  reserveAgentCall: async () => true,
  saveAgentStep: mocks.saveStep,
}));
vi.mock('../../packages/infrastructure/agent-ui', () => ({
  getUiTaskCommand: mocks.getCommand,
  readUiState: vi.fn(),
  createUiCommand: vi.fn(),
  saveUiResult: mocks.saveResult,
}));

const task = {
  id: 'task',
  ownerId: 'owner',
  sessionId: 'session',
  generation: 1,
  inputRevision: 0,
  uiBinding: { clientId: 'client', pageGeneration: 1 },
} as AgentTask;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('AGENT_UI_ENABLED', 'true');
});
afterEach(() => vi.unstubAllEnvs());

describe('界面命令按真实回执说明失败原因', () => {
  it.each([
    ['failed', 'UNAVAILABLE', '可恢复的热力图快照'],
    ['rejected', 'STATE_CONFLICT', '页面状态已改变'],
    ['failed', 'POSTCONDITION_FAILED', '地图绘制尚未确认'],
    ['failed', 'EXECUTION_FAILED', '浏览器执行失败'],
    ['expired', undefined, '过期'],
    ['unknown', undefined, '操作回执未确认'],
    ['cancelled', undefined, '已取消'],
  ])('%s / %s 保留失败且给出准确提示', async (status, error, expected) => {
    mocks.getCommand.mockResolvedValue({
      id: 'command',
      status,
      error,
      result: {},
      operation: { componentId: 'chart.heatmap', action: 'show' },
    });
    await executeUiTask({} as Infrastructure, task, 'worker', 24);
    expect(mocks.finish).toHaveBeenCalledWith(
      {},
      'task',
      'worker',
      1,
      expect.objectContaining({ status: 'failed', summary: expect.stringContaining(expected) }),
    );
    expect(mocks.saveResult).not.toHaveBeenCalled();
  });
  it('缺少快照时提示生成并确认区域，不归咎页面离线', async () => {
    mocks.getCommand.mockResolvedValue({
      id: 'command',
      status: 'failed',
      error: 'UNAVAILABLE',
      result: {},
      operation: { componentId: 'chart.heatmap', action: 'show' },
    });
    await executeUiTask({} as Infrastructure, task, 'worker', 24);
    const outcome = mocks.finish.mock.calls[0]![4];
    expect(outcome.summary).toContain('生成');
    expect(outcome.summary).toContain('区域');
    expect(outcome.summary).not.toContain('离线');
    expect(mocks.saveStep).toHaveBeenCalledWith(
      {},
      'task',
      'worker',
      1,
      expect.objectContaining({ output: expect.objectContaining({ error: 'UNAVAILABLE' }) }),
    );
  });
});
