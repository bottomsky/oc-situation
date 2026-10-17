interface SkillChoice {
  skillId: string;
  version: string;
}
export function skillCandidateKey(candidate: SkillChoice) {
  return JSON.stringify([candidate.skillId, candidate.version]);
}
export function skillChoiceValid(
  ref: { skillId: string; version?: string } | undefined,
  candidates: SkillChoice[],
) {
  return (
    !!ref?.version &&
    candidates.some(
      (candidate) => candidate.skillId === ref.skillId && candidate.version === ref.version,
    )
  );
}
import type { AgentInputValues } from '@ais/contracts';

export function inputNeedsIntelligence(fields: readonly string[], purpose?: string) {
  return fields.includes('topic') || purpose === 'intelligence_search';
}
export function initializeAgentInputValues(
  prefill: AgentInputValues,
  fields: readonly string[],
): AgentInputValues {
  const values: AgentInputValues = JSON.parse(JSON.stringify(prefill));
  if (inputNeedsIntelligence(fields, values.purpose))
    values.intelligenceQuery = { kind: 'events', ...values.intelligenceQuery };
  return values;
}
