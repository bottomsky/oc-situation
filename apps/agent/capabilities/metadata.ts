import type { AgentInputField, AgentIntent } from '../../../packages/contracts/agent';

export type CapabilityExecutionMode = 'local' | 'model' | 'legacy';
export interface CapabilityRoutingMetadata {
  readonly intents: readonly AgentIntent[];
  /** Base required fields per intent; the domain input validator handles conditional follow-ups. */
  readonly requiredInputs: Readonly<Partial<Record<AgentIntent, readonly AgentInputField[]>>>;
  readonly executionMode: CapabilityExecutionMode;
  /** Whether this capability is installed and enabled, independent of remote source health. */
  readonly available: boolean;
}
export interface CapabilityDirectoryEntry extends CapabilityRoutingMetadata {
  readonly id: string;
  readonly description: string;
  readonly skillId?: string;
  readonly legacy: boolean;
}
