import type { IntelligenceGeometry } from '@ais/contracts';

export type MapEffectIcon = 'vessel' | 'unknown' | 'alert' | 'danger' | 'opportunity';

export interface MapEffectTarget {
  key: string;
  geometries: IntelligenceGeometry[];
  icon?: MapEffectIcon;
  bearing?: number;
  observedAt?: string;
  effectId?: string;
}

export interface MapAttentionRequest {
  id: string;
  targets: MapEffectTarget[];
  icon: MapEffectIcon;
  color?: string;
}

export interface MapEffectPoint {
  x: number;
  y: number;
}

export interface MapEffectBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface MapEffectFrame {
  request: MapAttentionRequest | null;
  elapsed: number;
  visible: boolean;
  size: number;
  phase: 'contract' | 'blink' | 'static' | 'done';
}
