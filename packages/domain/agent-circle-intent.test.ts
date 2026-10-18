import { expect, it } from 'vitest';
import { parseCircleRegion } from './agent-focus';
import { requiredAgentInputFields, deriveAgentIntent } from './agent-intents';
import { dynamicTaskSelection, shouldUseDynamicSkill } from './agent-dynamic-routing';
it('routes coordinate radius vessel questions without a missing region', () => {
  const goal = '查询坐标122,31方圆50公里内有哪些船';
  const region = parseCircleRegion(goal);
  expect(region).toEqual({ kind: 'circle', center: [122, 31], radiusMeters: 50000 });
  expect(deriveAgentIntent(goal).intent).toBe('vessel_list');
  expect(requiredAgentInputFields({ region }, 'vessel_list')).toEqual([]);
});

it.each([
  '聚集 113.8751, 22.0843 方圆 100公里',
  '聚焦 113.8751, 22.0843 方圆 100公里',
  '定位 [113.8751, 22.0843] 半径100千米',
  '请关注（113.8751，22.0843）方圆100 km',
  '请帮我聚焦坐标113.8751,22.0843方圆100公里',
  '关注经度113.8751 纬度22.0843 半径100000米',
])('routes a single explicit circle locally: %s', (goal) => {
  const region = parseCircleRegion(goal);
  expect(region).toEqual({ kind: 'circle', center: [113.8751, 22.0843], radiusMeters: 100000 });
  expect(deriveAgentIntent(goal).intent).toBe('map_focus');
  expect(requiredAgentInputFields({ region }, 'map_focus')).toEqual([]);
  expect(shouldUseDynamicSkill(goal, { enabled: true })).toBe(false);
  expect(
    dynamicTaskSelection(goal, { bbox: [-180, -80, 180, 80] }, new Date()).bbox,
  ).toBeUndefined();
});

it('keeps circle vessel questions as scoped queries and aggregation analysis distinct', () => {
  const goal = '查询113.8751,22.0843方圆100公里内有哪些船舶';
  expect(parseCircleRegion(goal)?.center).toEqual([113.8751, 22.0843]);
  expect(deriveAgentIntent(goal).intent).toBe('vessel_list');
  expect(deriveAgentIntent('分析113.8751,22.0843方圆100公里内的船舶聚集情况').intent).not.toBe(
    'map_focus',
  );
  expect(deriveAgentIntent('不要聚焦113.8751,22.0843方圆100公里').intent).not.toBe('map_focus');
});
it('keeps decimal coordinate digits out of vessel identifiers', () => {
  const selected = dynamicTaskSelection(
    '聚焦113.875112345,22.084312345方圆100公里',
    {},
    new Date(),
  );
  expect(selected.mmsis).toBeUndefined();
  expect(selected.vesselSelector).toBeUndefined();
});

it.each([
  '聚焦181,22方圆100公里',
  '定位113,91方圆100公里',
  '关注113,22方圆-100公里',
  '聚焦113,22半径0公里',
  '聚焦113,22半径2001公里',
  '聚焦113,22和114,23方圆100公里',
  '聚焦113,22,30方圆100公里',
  '聚焦经度113 经度114 纬度22方圆100公里',
  '聚焦113,22方圆100公里半径200公里',
  '聚焦113,方圆100公里',
  '聚焦方圆100公里',
  '聚焦1e3,22方圆100公里',
  '查询113,22方圆一百公里内有哪些船',
  '查询坐标113,22半径abc公里内有哪些船',
])('rejects invalid or ambiguous circle input without adopting a viewport: %s', (goal) => {
  expect(() => parseCircleRegion(goal)).toThrow();
  expect(() => dynamicTaskSelection(goal, { bbox: [-180, -80, 180, 80] }, new Date())).toThrow();
});

it('leaves ordinary radius terminology outside coordinate request parsing', () => {
  expect(parseCircleRegion('什么是半径')).toBeUndefined();
  expect(parseCircleRegion('某事件摘要谈方圆')).toBeUndefined();
});

it.each([
  '船舶257288000 中心及半径 100 公里的圆形区域多少 传船舶',
  '以MMSI257288000为中心，半径100公里内有多少船舶',
  '查询船舶257288000周围方圆100公里内有哪些船',
])('keeps a vessel circle anchor separate from the vessels being counted: %s', (goal) => {
  expect(() => parseCircleRegion(goal)).not.toThrow();
  expect(parseCircleRegion(goal)).toBeUndefined();
  expect(deriveAgentIntent(goal)).toEqual({ intent: 'vessel_list', purpose: 'vessel_list' });
  expect(shouldUseDynamicSkill(goal, { enabled: true })).toBe(false);
  const selected = dynamicTaskSelection(
    goal,
    {
      bbox: [-180, -80, 180, 80],
      region: { kind: 'bbox', bbox: [-180, -80, 180, 80] },
      mmsis: ['257288000'],
      vesselSelector: { mmsis: ['257288000'] },
    },
    new Date(),
  );
  expect(selected).toMatchObject({ vesselCircle: { mmsi: '257288000', radiusMeters: 100000 } });
  expect(selected.region).toBeUndefined();
  expect(selected.bbox).toBeUndefined();
  expect(selected.mmsis).toBeUndefined();
  expect(selected.vesselSelector?.mmsis).toBeUndefined();
  expect(requiredAgentInputFields(selected, 'vessel_list')).toEqual([]);
});

it.each([
  '以船舶257288000和257288001为中心半径100公里内多少船',
  '以船舶257288000和坐标113,22为中心半径100公里内多少船',
  '船舶25728800中心半径100公里内多少船',
  '船舶257288000中心半径一百公里内多少船',
])('rejects ambiguous or malformed vessel circle anchors: %s', (goal) => {
  expect(() => dynamicTaskSelection(goal, { bbox: [-180, -80, 180, 80] }, new Date())).toThrow();
});
