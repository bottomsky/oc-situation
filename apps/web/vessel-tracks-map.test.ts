import { expect, it, vi } from 'vitest';
import type { VesselTracksResult } from '@ais/contracts';
import { registerVesselTracksLayers, vesselTracksGeoJson } from './app/utils/vesselTracksMap';

it('每船每段独立成线，单点保留为点，关闭清空本图源', () => {
  const point = (lon: number) => ({ lon, lat: 30, observedAt: '2026-10-16T00:00:00Z' });
  const result = {
    tracks: [
      {
        mmsi: '123456789',
        name: '甲',
        segments: [{ points: [point(120), point(121)] }, { points: [point(122)] }],
      },
      { mmsi: '223456789', name: '乙', segments: [{ points: [point(179), point(-179)] }] },
    ],
  } as VesselTracksResult;
  const features = vesselTracksGeoJson(result).features;
  expect(features.filter((f) => f.geometry.type === 'LineString')).toHaveLength(1);
  expect(features.filter((f) => f.geometry.type === 'Point')).toHaveLength(3);
  expect(features.map((f) => f.properties?.mmsi)).toEqual([
    '123456789',
    '123456789',
    '223456789',
    '223456789',
  ]);
  expect(new Set(features.map((f) => f.id)).size).toBe(4);
  expect(vesselTracksGeoJson(null).features).toEqual([]);
});

it('重复注册和样式重载仅恢复专属图层，不修改单船轨迹源', () => {
  const sources = new Set<string>(['track']);
  const layers = new Set<string>(['tracks']);
  const map = {
    getSource: (id: string) => sources.has(id),
    getLayer: (id: string) => layers.has(id),
    addSource: vi.fn((id: string) => {
      sources.add(id);
    }),
    addLayer: vi.fn((layer: { id: string }) => {
      layers.add(layer.id);
    }),
  };
  registerVesselTracksLayers(map);
  registerVesselTracksLayers(map);
  expect(map.addSource).toHaveBeenCalledTimes(1);
  expect(map.addLayer).toHaveBeenCalledTimes(2);
  expect([...sources]).toEqual(['track', 'ais-history-tracks']);
  sources.delete('ais-history-tracks');
  layers.delete('ais-history-tracks');
  layers.delete('ais-history-track-points');
  registerVesselTracksLayers(map);
  expect(map.addSource).toHaveBeenCalledTimes(2);
  expect(map.addLayer).toHaveBeenCalledTimes(4);
  expect(layers.has('tracks')).toBe(true);
});
