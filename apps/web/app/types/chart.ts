import type {
  IntelligenceGeometry,
  Bbox,
  HighlightVessel,
  MapCameraRequest,
  MapCameraResult,
} from '@ais/contracts';
export interface ChartVesselHighlight extends HighlightVessel {
  effectId: string;
  headingDegrees?: number | null;
  cogDegrees?: number | null;
}
export interface ChartLayerVisibility {
  ais: boolean;
  tracks: boolean;
  evidence: boolean;
}

export interface ChartMapControls {
  projectFocus(point: [number, number], anchorLongitude?: number): { x: number; y: number } | null;
  focusViewport(): { left: number; top: number; right: number; bottom: number } | null;
  onFocusRender(listener: () => void): () => void;
  requestFocusRender(): void;

  applyCamera(
    request: MapCameraRequest & { commandId?: string },
    signal?: AbortSignal,
  ): Promise<MapCameraResult>;
  currentCamera(): MapCameraResult | null;
  cameraState(): Omit<MapCameraResult, 'commandId'> | null;
  cameraIntent(options?: { reserveReply?: boolean }): (request: MapCameraRequest) => void;
  interactionState(): { ready: boolean; moving: boolean; drawing: boolean };
  currentBounds(): Bbox | null;
  editGeometry(geometry: IntelligenceGeometry): void;
  resetView(): void;
  zoomIn(): void;
  zoomOut(): void;
  locateIntelligence(eventId?: string): void;
  focusGeometry(geometry: IntelligenceGeometry): void;
  draw(mode: 'point' | 'linestring' | 'polygon' | 'select' | 'cancel'): void;
}
