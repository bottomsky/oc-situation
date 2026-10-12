import { describe, expect, it } from 'vitest';
import {
  resolveVesselDirection,
  vesselMarkerProperties,
  vesselSymbolLayout,
  createVesselIcon,
} from './app/utils/vesselMarkers';

describe('vessel direction markers', () => {
  it.each([0, 90, 180, 270, 359])('uses heading %s clockwise from north', (bearing) => {
    expect(resolveVesselDirection({ headingDegrees: bearing, cogDegrees: 42 })).toEqual({
      bearing,
      directionSource: 'heading',
      directionLabel: `艏向 ${bearing}°`,
    });
  });
  it.each([null, undefined, 511, 360, -1, NaN, Infinity])(
    'falls back from unavailable heading %s to COG',
    (headingDegrees) => {
      expect(resolveVesselDirection({ headingDegrees, cogDegrees: 0 })).toEqual({
        bearing: 0,
        directionSource: 'cog',
        directionLabel: '对地航向 0°（COG）',
      });
    },
  );
  it.each([null, undefined, 511, 360, -1, NaN, Infinity])(
    'uses a neutral marker when COG %s is unavailable',
    (cogDegrees) => {
      expect(vesselMarkerProperties({ cogDegrees, quality: [] })).toMatchObject({
        bearing: 0,
        directionSource: 'unknown',
        directionLabel: '方向未知',
        markerIcon: 'vessel-live-unknown',
      });
    },
  );
  it('keeps synthetic and observation marker identities separate', () => {
    expect(vesselMarkerProperties({ headingDegrees: 90, quality: ['synthetic'] }).markerIcon).toBe(
      'vessel-sample-direction',
    );
    expect(vesselMarkerProperties({ headingDegrees: 90, quality: [] }).markerIcon).toBe(
      'vessel-live-direction',
    );
    expect(vesselMarkerProperties({ headingDegrees: 90, quality: [] }, true).markerIcon).toBe(
      'vessel-frame-direction',
    );
  });
  it('keeps bearing relative to map north and renders overlapping vessels', () => {
    expect(vesselSymbolLayout).toMatchObject({
      'icon-rotate': ['get', 'bearing'],
      'icon-rotation-alignment': 'map',
      'icon-pitch-alignment': 'map',
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
    });
  });
  it('creates a north-pointing triangle and a symmetric unknown symbol', () => {
    const triangle = createVesselIcon('#0b777b', false);
    const neutral = createVesselIcon('#0b777b', true);
    expect(triangle.width).toBe(36);
    expect(triangle.data[(5 * 36 + 18) * 4 + 3]).toBeGreaterThan(0);
    expect(triangle.data[(5 * 36 + 6) * 4 + 3]).toBe(0);
    expect(neutral.data[(18 * 36 + 18) * 4 + 3]).toBe(0);
    for (let y = 0; y < 36; y++)
      for (let x = 0; x < 36; x++) {
        expect(neutral.data[(y * 36 + x) * 4 + 3]).toBe(
          neutral.data[((35 - y) * 36 + 35 - x) * 4 + 3],
        );
      }
  });
});
