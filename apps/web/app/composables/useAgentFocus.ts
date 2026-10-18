import { ref, shallowRef } from 'vue';
import type { AgentFocusResult } from '../../../../packages/contracts/agent-focus';
export function useAgentFocus() {
  const displayStatus = ref<AgentFocusResult['displayStatus']>('unlocated');
  const result = shallowRef<AgentFocusResult | null>(null),
    displayed = ref(false),
    artifactRef = ref('');
  let scope = '';
  let taskScope = '';
  let revision = 0;
  let dismissedScope = '';
  function dismiss() {
    dismissedScope = scope;
    reset();
  }
  function reset() {
    result.value = null;
    displayed.value = false;
    displayStatus.value = 'unlocated';
    artifactRef.value = '';
  }
  function setScope(sessionId: string | null, taskId: string | null, inputRevision = 0) {
    taskScope = `${sessionId ?? ''}:${taskId ?? ''}`;
    revision = inputRevision;
    const next = `${taskScope}:${revision}`;
    if (next !== scope) {
      scope = next;
      dismissedScope = '';
      reset();
    }
  }
  function accept(value: AgentFocusResult | null, artifact = '') {
    if (dismissedScope === scope && !artifact) return false;
    if (artifact) dismissedScope = '';
    if (
      !value ||
      `${value.sessionId}:${value.taskId}` !== taskScope ||
      value.inputRevision !== revision
    )
      return false;
    if (result.value && value.inputRevision < result.value.inputRevision) return false;
    if (
      result.value &&
      value.inputRevision === result.value.inputRevision &&
      value.version < result.value.version
    )
      return false;
    if (
      result.value &&
      JSON.stringify(result.value) === JSON.stringify(value) &&
      artifactRef.value === artifact
    )
      return true;
    result.value = value;
    artifactRef.value = artifact;
    displayed.value = false;
    return true;
  }
  function markDisplayed(
    value: AgentFocusResult,
    actualStatus: AgentFocusResult['displayStatus'] = value.displayStatus,
  ) {
    if (value === result.value) {
      displayed.value = true;
      displayStatus.value = actualStatus;
    }
  }
  return {
    result,
    displayStatus,
    displayed,
    artifactRef,
    setScope,
    accept,
    markDisplayed,
    dismiss,
    reset,
  };
}
