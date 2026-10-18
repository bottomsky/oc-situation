import { expect, it } from 'vitest';
import { useAgentFocus } from './useAgentFocus';
import type { AgentFocusResult } from '../../../../packages/contracts/agent-focus';
const value: AgentFocusResult = {
  kind: 'map_focus',
  sessionId: 's',
  taskId: 't',
  version: 1,
  inputRevision: 0,
  targets: [
    {
      ref: { kind: 'vessel', id: '413123456' },
      label: '船',
      geometry: { type: 'Point', coordinates: [122, 31] },
    },
  ],
  missing: [],
  bbox: [122, 31, 122, 31],
  displayStatus: 'complete',
  cameraPolicy: 'if-needed-once',
};
it('records partial actual display without changing immutable result', () => {
  const state = useAgentFocus();
  state.setScope('s', 't');
  state.accept(value);
  state.markDisplayed(value, 'partial');
  expect(state.displayStatus.value).toBe('partial');
  expect(value.displayStatus).toBe('complete');
});
it('keeps a dismissed scope closed across result polling', () => {
  const state = useAgentFocus();
  state.setScope('s', 't');
  state.accept(value);
  state.dismiss();
  expect(state.accept(value)).toBe(false);
  expect(state.result.value).toBeNull();
  expect(state.accept(value, 'explicit-artifact')).toBe(true);
});
