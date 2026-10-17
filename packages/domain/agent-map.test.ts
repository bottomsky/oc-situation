import { describe, expect, it } from 'vitest';
import { deriveAgentIntent } from './agent-intents';
import { mapTaskSelection, highlightsFromVessels, cameraFromVessels } from './agent-map';
import { MapCameraRequestSchema } from '../contracts/agent-map';

describe('map task safety and target preparation', () => {
  it('routes highlight and camera commands before generic UI and vessel queries', () => {
    expect(deriveAgentIntent('高亮 MMSI 123456789 并聚焦').intent).toBe('vessel_highlights');
    expect(deriveAgentIntent('清除全部船舶高亮').intent).toBe('vessel_highlights');
    expect(deriveAgentIntent('镜头聚焦经度 122.3 纬度 31.5 缩放 12').intent).toBe('map_camera');
  });
  it('binds explicit camera parameters and clear parameters', () => {
    expect(mapTaskSelection('镜头聚焦经度 122.3 纬度 31.5 缩放 12', {})).toMatchObject({
      mapCamera: { mode: 'point', center: [122.3, 31.5], zoom: 12 },
    });
    expect(mapTaskSelection('清除全部船舶高亮', {})).toMatchObject({
      highlightClear: { mode: 'all' },
    });
    expect(mapTaskSelection('高亮船舶', {}).highlightAndFocus).toBe(false);
  });
  it('rejects mixed absolute and relative zoom', () => {
    expect(
      MapCameraRequestSchema.safeParse({ mode: 'current', zoom: 10, zoomDelta: 2 }).success,
    ).toBe(false);
  });
  it('keeps target zoom attached to a vessel focus and narrows qualified clearing', () => {
    expect(mapTaskSelection('聚焦 MMSI 123456789 并缩放到8', {})).toMatchObject({
      mmsis: ['123456789'],
      mapTargetZoom: 8,
    });
    expect(mapTaskSelection('聚焦 MMSI 123456789 并缩放到8', {}).mapCamera).toBeUndefined();
    expect(mapTaskSelection('聚焦 MMSI 123456789 然后放大2级', {})).toMatchObject({
      mapTargetZoom: 12,
    });
    expect(mapTaskSelection('聚焦 MMSI 123456789 然后放大2级', {}).mapCamera).toBeUndefined();
    expect(() => mapTaskSelection('聚焦 MMSI 123456789 缩放到8 然后放大2级', {})).toThrow(
      'invalid_camera_zoom',
    );
    expect(mapTaskSelection('清除任务1高亮', {})).toMatchObject({ highlightTaskIndex: 1 });
    expect(mapTaskSelection('清除任务1高亮', {}).highlightClear).toBeUndefined();
    expect(mapTaskSelection('清除某船高亮', {})).toMatchObject({ highlightClearUnclear: true });
    expect(mapTaskSelection('清除某船高亮', {}).highlightClear).toBeUndefined();
  });
  it('rejects truncated targets and lists missing vessel locations', () => {
    const result = {
      kind: 'vessel_list' as const,
      version: 0,
      inputRevision: 0,
      total: 1,
      truncated: false,
      items: [{ mmsi: '123456789', name: null, imo: null, shipType: null, latestPosition: null }],
      asOf: new Date().toISOString(),
      selection: {},
    };
    expect(() => highlightsFromVessels({ ...result, truncated: true }, 0)).toThrow('data_limit');
    expect(() => highlightsFromVessels(result, 0)).toThrow('no_positions');
    expect(() => cameraFromVessels(result)).toThrow('no_positions');
  });
});
