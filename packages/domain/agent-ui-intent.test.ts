import { describe, expect, it } from 'vitest';
import { deriveAgentIntent } from './agent-intents';
import { isUiIntent, resolveUiOperation } from './agent-ui-intent';
import {
  UiStateSchema,
  UiOperationSchema,
  uiOperationAllowed,
  uiPostcondition,
} from '../contracts/agent-ui';

const state = UiStateSchema.parse({
  sequence: 1,
  route: '/',
  components: [
    {
      id: 'chart.heatmap',
      version: 1,
      mounted: true,
      open: false,
      visible: false,
      actions: ['close'],
    },
    {
      id: 'chart.heatmap.legend',
      version: 1,
      mounted: true,
      open: false,
      visible: false,
      actions: [],
    },
    {
      id: 'chart.heatmap.popup',
      version: 1,
      mounted: true,
      open: false,
      visible: false,
      actions: ['close'],
    },
  ],
});
describe('semantic UI intent and postconditions', () => {
  it.each(['关闭热力图', '隐藏热度图', '收起左侧面板', '关闭这个窗口', '当前界面打开了哪些窗口'])(
    'routes %s to UI control without a data query',
    (goal) => {
      expect(deriveAgentIntent(goal).intent).toBe('ui_control');
    },
  );
  it('keeps generation and explanation in the original workflows', () => {
    expect(deriveAgentIntent('生成当前视野热力图').intent).toBe('ais_heatmap');
    expect(deriveAgentIntent('解释上次热力图').intent).toBe('explain');
  });
  it.each([
    '显示热力图',
    '打开热力图',
    '请显示 AIS 热力图',
    '展开热度图',
    '展示热力图',
    '显示当前视野过去24小时AIS热力图',
    '打开最近2小时的热力图',
    '显示之前24小时的热力图',
    '显示重新生成的热力图',
  ])('%s 查询生成热图，首次使用不依赖页面缓存', (goal) => {
    expect(deriveAgentIntent(goal).intent).toBe('ais_heatmap');
  });
  it.each([
    '恢复热力图',
    '显示上次热力图',
    '打开已有的AIS热力图',
    '展示刚才的热力图',
    '恢复刚才生成的热力图',
    '显示上次生成的热力图',
    '打开刚才计算的热力图',
  ])('%s 恢复已有快照，保持 UI 控制', (goal) => {
    expect(deriveAgentIntent(goal).intent).toBe('ui_control');
    expect(resolveUiOperation(goal, state)).toEqual({
      componentId: 'chart.heatmap',
      action: 'show',
    });
  });
  it('打开热图操作面板只切换功能栏，关闭热图仍操作图层', () => {
    expect(deriveAgentIntent('打开AIS热力图操作面板').intent).toBe('ui_control');
    expect(resolveUiOperation('打开AIS热力图操作面板', state)).toEqual({
      componentId: 'workspace.left',
      action: 'tab',
      tab: 'heatmap',
    });
    expect(resolveUiOperation('关闭热力图', state)).toEqual({
      componentId: 'chart.heatmap',
      action: 'close',
    });
  });
  it('requires all heatmap surfaces and in-flight work to be closed', () => {
    const op = resolveUiOperation('关闭热力图', state);
    expect(op).toEqual({ componentId: 'chart.heatmap', action: 'close' });
    expect(uiPostcondition(op as { componentId: 'chart.heatmap'; action: 'close' }, state)).toBe(
      true,
    );
    const late = structuredClone(state);
    late.components[0]!.loading = true;
    expect(uiPostcondition(op as { componentId: 'chart.heatmap'; action: 'close' }, late)).toBe(
      false,
    );
  });
  it('does not guess an absent or ambiguous window', () => {
    expect(resolveUiOperation('关闭这个窗口', state)).toBe('ambiguous');
    const popup = structuredClone(state);
    popup.components[2]!.open = true;
    expect(resolveUiOperation('关闭这个窗口', popup)).toEqual({
      componentId: 'chart.heatmap.popup',
      action: 'close',
    });
  });
  it('does not reverse a negative instruction or guess an unnamed layer', () => {
    expect(resolveUiOperation('不要关闭热力图', state)).toBeNull();
    expect(resolveUiOperation('关闭图层', state)).toBe('ambiguous');
    expect(resolveUiOperation('打开情报来源详情', state)).toBe('ambiguous');
    expect(resolveUiOperation('关闭聊天面板', state)).toEqual({
      componentId: 'workspace.right',
      action: 'close',
    });
  });
  it('允许海洋态势页签状态与切换，同时保持左右面板和动作白名单独立', () => {
    const operation = UiOperationSchema.parse({
      componentId: 'workspace.left',
      action: 'tab',
      tab: 'situation',
    });
    const current = UiStateSchema.parse({
      sequence: 1,
      route: '/',
      components: [
        {
          id: 'workspace.left',
          version: 1,
          mounted: true,
          open: true,
          visible: true,
          actions: ['open', 'close', 'tab'],
          tab: 'situation',
        },
      ],
    });
    expect(uiOperationAllowed(operation)).toBe(true);
    expect(uiPostcondition(operation, current)).toBe(true);
    expect(uiOperationAllowed({ ...operation, componentId: 'workspace.right' })).toBe(false);
    expect(uiOperationAllowed({ ...operation, action: 'show' })).toBe(false);
  });
  it.each(['打开海洋态势', '展开海洋态势', '切换到海洋态势'])(
    '显式指令%s切换已有人工页签',
    (text) => {
      expect(isUiIntent(text)).toBe(true);
      expect(deriveAgentIntent(text).intent).toBe('ui_control');
      expect(resolveUiOperation(text, state)).toEqual({
        componentId: 'workspace.left',
        action: 'tab',
        tab: 'situation',
      });
    },
  );
  it.each(['当前海洋态势怎么样', '不要打开海洋态势', '别切换到海洋态势'])(
    '%s保持地图和面板状态',
    (text) => {
      expect(resolveUiOperation(text, state)).toBeNull();
      expect(deriveAgentIntent(text).intent).not.toBe('ui_control');
      if (text === '当前海洋态势怎么样') expect(isUiIntent(text)).toBe(false);
    },
  );
  it('rejects arbitrary properties and unsupported action combinations', () => {
    expect(
      UiOperationSchema.safeParse({ componentId: 'app.page', action: 'close', script: 'alert(1)' })
        .success,
    ).toBe(false);
    expect(uiOperationAllowed({ componentId: 'app.page', action: 'close' })).toBe(false);
    expect(uiOperationAllowed({ componentId: 'workspace.left', action: 'tab', tab: 'tasks' })).toBe(
      false,
    );
  });
});
