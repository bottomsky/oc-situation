import type { Map as GLMap } from 'maplibre-gl';
import type { MapEffectTarget } from '../types/mapEffects';
import type { ChartBusinessMapPort } from './chartBusinessLayers';
import {
  MAP_EFFECT_COLOR,
  MAP_EFFECT_ICONS,
  mapEffectGlyphBearing,
  mapEffectGlyphImage,
  mapEffectTargetIcon,
} from './mapEffects';

function imageId(icon: string, color: string) {
  return `map-effect-${icon}-${color.replace('#', '').toUpperCase()}`;
}

/** Only point glyphs live in MapLibre. Selection and attention share the SVG host. */
export function highlightGeoJson(targets: MapEffectTarget[], color = MAP_EFFECT_COLOR) {
  return {
    type: 'FeatureCollection' as const,
    features: targets.flatMap((target) => {
      const icon = mapEffectTargetIcon(target);
      return target.geometries.flatMap((geometry) => {
        const coordinates =
          geometry.type === 'Point'
            ? [geometry.coordinates]
            : geometry.type === 'MultiPoint'
              ? geometry.coordinates
              : [];
        return coordinates.map((point) => ({
          type: 'Feature' as const,
          id: target.key,
          properties: {
            key: target.key,
            ...(target.key.startsWith('vessel:')
              ? { mmsi: target.key.slice('vessel:'.length) }
              : {}),
            bearing: mapEffectGlyphBearing(icon, target.bearing),
            markerIcon: imageId(icon, color),
          },
          geometry: { type: 'Point' as const, coordinates: point },
        }));
      });
    }),
  };
}

export function registerVesselHighlightLayers(map: ChartBusinessMapPort, color = MAP_EFFECT_COLOR) {
  if (!map.getSource('vessel-highlights'))
    map.addSource('vessel-highlights', {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });
  for (const icon of MAP_EFFECT_ICONS) {
    const id = imageId(icon, color);
    if (!map.hasImage(id)) map.addImage(id, mapEffectGlyphImage(icon, color), { pixelRatio: 2 });
  }
  if (!map.getLayer('vessel-highlight-marker'))
    map.addLayer({
      id: 'vessel-highlight-marker',
      type: 'symbol',
      source: 'vessel-highlights',
      layout: {
        'icon-image': ['get', 'markerIcon'],
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        'icon-size': 2 / 3,
      },
      paint: {
        'icon-opacity': ['coalesce', ['feature-state', 'opacity'], 1],
        'icon-opacity-transition': { duration: 0, delay: 0 },
      },
    });
}

/** Host calls this for the active batch only, and restores it on every exit path. */
export function updateMapEffectOpacity(
  map: Pick<GLMap, 'setFeatureState'>,
  keys: readonly string[],
  opacity: number,
) {
  for (const key of new Set(keys))
    map.setFeatureState({ source: 'vessel-highlights', id: key }, { opacity });
}
