export type CapabilityErrorCode =
  | 'configuration'
  | 'invalid_input'
  | 'invalid_output'
  | 'invalid_phase'
  | 'fenced'
  | 'budget'
  | 'skill_changed'
  | 'skill_not_active';

export class CapabilityError extends Error {
  constructor(
    readonly code: CapabilityErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'CapabilityError';
  }
}
