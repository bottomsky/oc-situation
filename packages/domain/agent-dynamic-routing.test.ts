import { describe, expect, it } from 'vitest';
import {
  dynamicGoalProjection,
  dynamicTaskSelection,
  shouldUseDynamicSkill,
} from './agent-dynamic-routing';

describe('dynamic skill routing', () => {
  it('routes composite vessel selection, tracks and heatmap before single intent fast paths', () => {
    expect(
      shouldUseDynamicSkill('筛选当前区域货船，再展示历史航线和热力图', {
        enabled: true,
        intent: 'vessel_tracks',
      }),
    ).toBe(true);
    expect(dynamicGoalProjection('在当前区域展示过去24小时货船航线和热力图').operations).toEqual([
      'query_vessels',
      'query_vessel_tracks',
      'query_ais_heatmap',
    ]);
    expect(dynamicGoalProjection('展示最近24小时货船航线并搜索情报').operations).toEqual([
      'query_vessels',
      'query_vessel_tracks',
      'search_intelligence',
    ]);
    expect(dynamicGoalProjection('展示货船和油轮最近24小时航线与热力图').vesselClasses).toEqual([
      'cargo',
      'tanker',
    ]);
  });
  it('preserves known single business, conversation and UI routes and defaults off', () => {
    for (const goal of [
      '查询历史航线',
      '查询当前区域货船航线',
      '生成热力图',
      '关闭热力图',
      '你好',
      '已确认区域，请执行',
    ])
      expect(shouldUseDynamicSkill(goal, { enabled: true })).toBe(false);
    expect(shouldUseDynamicSkill('筛选货船并生成热力图', { enabled: false })).toBe(false);
    expect(shouldUseDynamicSkill('对比区域内多种观测', { enabled: true })).toBe(true);
    expect(
      shouldUseDynamicSkill('执行已有技能', {
        enabled: true,
        skillRef: { skillId: 'cargo-overview' },
      }),
    ).toBe(true);
  });
  it('projects only semantic targets and opaque input references', () => {
    const projected = dynamicGoalProjection(
      '筛选当前区域货船 413123456 121.5,31.2，展示历史航线和热力图 api_key=secret https://private.test',
    );
    expect(projected.operations).toEqual([
      'query_vessels',
      'query_vessel_tracks',
      'query_ais_heatmap',
    ]);
    expect(projected.vesselClass).toBe('cargo');
    expect(JSON.stringify(projected)).not.toMatch(/413123456|121\.5|31\.2|secret|private/);
  });
  it('binds explicit relative time, vessel type and identifier locally', () => {
    const selected = dynamicTaskSelection(
      '查询当前区域货船MMSI413123456最近72小时的航线和热力图',
      {
        bbox: [120, 30, 122, 32],
        timeRange: { from: '2026-10-16T00:00:00Z', to: '2026-10-17T00:00:00Z' },
      },
      new Date('2026-10-17T00:00:00Z'),
    );
    expect(selected.timeRange).toEqual({
      from: '2026-10-14T00:00:00.000Z',
      to: '2026-10-17T00:00:00.000Z',
    });
    expect(selected.mmsis).toEqual(['413123456']);
    expect(selected.vesselSelector).toMatchObject({
      mmsis: ['413123456'],
      shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79],
    });
  });
  it('retains explicit model, name and IMO selectors in composite requests', () => {
    const now = new Date('2026-10-17T00:00:00Z');
    expect(
      dynamicTaskSelection('筛选型号052D的船舶，再展示航线和热力图', {}, now).vesselSelector,
    ).toMatchObject({ model: '052D' });
    expect(
      dynamicTaskSelection('筛选船名“海巡01”的船舶，再展示航线和热力图', {}, now).vesselSelector,
    ).toMatchObject({ query: '海巡01' });
    expect(
      dynamicTaskSelection('筛选IMO1234567船舶，再展示航线和热力图', {}, now).vesselSelector,
    ).toMatchObject({ query: '1234567' });
  });
});
