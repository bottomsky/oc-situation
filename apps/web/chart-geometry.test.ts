import { expect, it } from 'vitest';
import {
  distanceNm,
  splitTrackPoints,
  trackPresentation,
  graticule,
  queryRegionGeoJson,
} from './app/utils/chartGeometry';
it('日期线区域查询按东西两块绘制，清除时图源为空', () => {
  expect(queryRegionGeoJson([170, -10, -170, 10]).features).toHaveLength(2);
  expect(queryRegionGeoJson(null).features).toEqual([]);
});

const p = (lon: number, minute: number) => ({
  lon,
  lat: 0,
  observedAt: new Date(minute * 60000).toISOString(),
  sogKnots: 10,
});
it('按日期线和30分钟数据缺口断开轨迹', () => {
  expect(
    splitTrackPoints([p(179, 0), p(-179, 1), p(-178, 2), p(-177, 60)]).map((s) => s.length),
  ).toEqual([1, 2, 1]);
});
it('海里测距使用短日期线距离，格网跨日期线可见', () => {
  expect(distanceNm([179, 0], [-179, 0])).toBeCloseTo(120.08, 1);
  expect(graticule([170, -10, -170, 10], 4).features.length).toBeGreaterThan(2);
});
it('统一轨迹具备端点、悬停时速和时间渐变属性', () => {
  const features = trackPresentation([
    { mmsi: '123', points: [p(120, 0), p(120.1, 1), p(120.2, 2)] },
  ]).features;
  expect(
    features.filter((f) => f.geometry.type === 'LineString' && f.properties?.kind !== 'direction'),
  ).toHaveLength(2);
  expect(features.some((f) => f.properties?.role === 'start')).toBe(true);
  expect(features.some((f) => f.properties?.role === 'end')).toBe(true);
  expect(features[0]?.properties).toMatchObject({ mmsi: '123', sogKnots: 10 });
});
it('方向箭头沿完整连续航段布置，日期线和缺口保持独立', () => {
  const features = trackPresentation([
    { mmsi: '1', points: [p(179, 0), p(-179, 1), p(-178, 2), p(-177, 60)] },
  ]).features;
  const directions = features.filter((f) => f.properties?.kind === 'direction');
  expect(directions).toHaveLength(1);
  expect(directions[0]?.geometry).toMatchObject({
    type: 'LineString',
    coordinates: [
      [-179, 0],
      [-178, 0],
    ],
  });
});
