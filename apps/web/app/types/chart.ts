import type { IntelligenceGeometry } from '@ais/contracts';
export interface ChartLayerVisibility {
  ais: boolean;
  tracks: boolean;
  evidence: boolean;
}

export interface ChartMapControls {
  editGeometry(geometry: IntelligenceGeometry): void;
  resetView(): void;
  zoomIn(): void;
  zoomOut(): void;
  locateIntelligence(eventId?: string): void;
  focusGeometry(geometry: IntelligenceGeometry): void;
  draw(mode: 'point' | 'linestring' | 'polygon' | 'select' | 'cancel'): void;
}
