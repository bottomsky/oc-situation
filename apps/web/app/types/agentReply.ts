import type { FocusTargetRef, IntelligenceGeometry } from '@ais/contracts';

/** One versioned business object, independently of how many map geometries it has. */
export interface ReplyObjectViewModel {
  key: string;
  ref: FocusTargetRef;
  label: string;
  geometries: IntelligenceGeometry[];
  located: boolean;
  observedAt?: string;
  source?: string;
}
