import { describe, expect, it } from 'vitest';
import { deriveAgentIntent } from './agent-intents';
import { resolveUiOperation } from './agent-ui-intent';
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
