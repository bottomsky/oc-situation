import type { SymbolLayerSpecification } from 'maplibre-gl';

interface DirectionObservation {
  headingDegrees?: number | null;
  cogDegrees?: number | null;
  quality?: string[];
}

export function resolveVesselDirection(position: DirectionObservation) {
  const valid = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 360;
  if (valid(position.headingDegrees))
    return {
      bearing: position.headingDegrees,
      directionSource: 'heading',
      directionLabel: `艏向 ${position.headingDegrees}°`,
    };
  if (valid(position.cogDegrees))
    return {
      bearing: position.cogDegrees,
      directionSource: 'cog',
      directionLabel: `对地航向 ${position.cogDegrees}°（COG）`,
    };
  return { bearing: 0, directionSource: 'unknown', directionLabel: '方向未知' };
}
export function vesselMarkerProperties(position: DirectionObservation, frame = false) {
  const direction = resolveVesselDirection(position);
  const category = frame ? 'frame' : position.quality?.includes('synthetic') ? 'sample' : 'live';
  return {
    ...direction,
    markerIcon: `vessel-${category}-${direction.directionSource === 'unknown' ? 'unknown' : 'direction'}`,
  };
}
export const vesselSymbolLayout: SymbolLayerSpecification['layout'] = {
  'icon-image': ['get', 'markerIcon'],
  'icon-rotate': ['get', 'bearing'],
  'icon-rotation-alignment': 'map',
  'icon-pitch-alignment': 'map',
  'icon-allow-overlap': true,
  'icon-ignore-placement': true,
  'icon-size': ['interpolate', ['linear'], ['zoom'], 2, 0.25, 6, 0.6, 10, 0.95, 14, 1.15],
};
// The raster points north before MapLibre applies clockwise rotation. Unknown
// directions use a hollow ring whose rotational symmetry communicates no bearing.
export function createVesselIcon(color: string, unknown: boolean) {
  const width = 36;
  const data = new Uint8Array(width * width * 4);
  const rgb = [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16));
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const dx = x + 0.5 - width / 2;
      const dy = y + 0.5 - width / 2;
      const radius = Math.hypot(dx, dy);
      const halfWidth = y < 13 ? (y - 2) * 0.55 : y <= 28 ? 6 : Math.max(0, 6 - (y - 28) * 1.5);
      const outer = unknown
        ? radius >= 5 && radius <= 12
        : y >= 3 && y <= 31 && Math.abs(dx) <= halfWidth;
      const inner = unknown
        ? radius >= 7 && radius <= 10
        : y >= 7 && y <= 29 && Math.abs(dx) <= halfWidth - 1.5;
      if (!outer) continue;
      const offset = (y * width + x) * 4;
      data.set(inner ? rgb : [255, 255, 255], offset);
      data[offset + 3] = 255;
    }
  return { width, height: width, data };
}
