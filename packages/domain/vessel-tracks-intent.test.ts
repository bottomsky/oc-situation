import { describe, expect, it } from 'vitest';
import { vesselTracksSelection } from './vessel-tracks-intent';
import { deriveAgentIntent, requiredAgentInputFields } from './agent-intents';
import { isUiIntent, resolveUiOperation } from './agent-ui-intent';
const now = new Date('2026-10-17T08:00:00Z');
describe('本地历史航线意图', () => {
  it.each([
    '绘制当前视野过去24小时货船航线',
    '显示过去3天油轮历史轨迹',
    '查询船名海巡01过去24小时的航线',
  ])('识别新查询 %s', (goal) => {
    expect(deriveAgentIntent(goal)).toEqual({ intent: 'vessel_tracks', purpose: 'vessel_tracks' });
  });
  it.each(['关闭历史航线', '恢复上次航线', '打开历史航线面板'])('区分界面操作 %s', (goal) =>
    expect(isUiIntent(goal)).toBe(true),
  );
  it('面板与快照分开', () => {
    const state = { sequence: 1, route: '/' as const, components: [] };
    expect(resolveUiOperation('打开历史航线面板', state)).toEqual({
      componentId: 'workspace.left',
      action: 'tab',
      tab: 'history-tracks',
    });
    expect(resolveUiOperation('关闭历史航线', state)).toEqual({
      componentId: 'chart.vessel-tracks',
      action: 'close',
    });
    expect(resolveUiOperation('恢复上次航线', state)).toEqual({
      componentId: 'chart.vessel-tracks',
      action: 'show',
    });
  });
  it('按AIS类别展开，明确编码精确匹配', () => {
    expect(vesselTracksSelection('过去24小时货船航线', now).vesselSelector).toEqual({
      shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79],
    });
    expect(vesselTracksSelection('过去24小时AIS船型编码71航线', now).vesselSelector).toEqual({
      shipTypes: [71],
    });
  });
  it.each([
    ['渔船', [30]],
    ['客船', [60, 61, 62, 63, 64, 65, 66, 67, 68, 69]],
    ['油轮', [80, 81, 82, 83, 84, 85, 86, 87, 88, 89]],
  ])('解析%s', (label, types) =>
    expect(vesselTracksSelection(`过去24小时${label}航线`, now).vesselSelector).toEqual({
      shipTypes: types,
    }),
  );
  it('提取MMSI、IMO、名称和明确型号，不推断型号', () => {
    expect(vesselTracksSelection('MMSI 413123456过去24小时航线', now).vesselSelector).toEqual({
      mmsis: ['413123456'],
    });
    expect(vesselTracksSelection('IMO 1234567过去24小时航线', now).vesselSelector).toEqual({
      query: '1234567',
    });
    expect(vesselTracksSelection('船名“海巡01”过去24小时航线', now).vesselSelector).toEqual({
      query: '海巡01',
    });
    expect(vesselTracksSelection('型号053H3过去24小时航线', now).vesselSelector).toEqual({
      model: '053H3',
    });
    expect(vesselTracksSelection('绘制海巡01过去24小时航线', now).vesselSelector).toEqual({
      query: '海巡01',
    });
  });
  it.each(['绘制052D型船舶过去24小时航线', '绘制型号为052D的船舶过去24小时航线'])(
    '明确型号语法 %s',
    (goal) => expect(vesselTracksSelection(goal, now).vesselSelector).toEqual({ model: '052D' }),
  );
  it('多个明确条件按交集保留', () =>
    expect(vesselTracksSelection('货船 船名海巡01 过去24小时航线', now).vesselSelector).toEqual({
      shipTypes: [70, 71, 72, 73, 74, 75, 76, 77, 78, 79],
      query: '海巡01',
    }));
  it('不截断超长数字标识', () => {
    expect(
      vesselTracksSelection('MMSI 1413123456过去24小时航线', now).vesselSelector?.mmsis,
    ).toBeUndefined();
  });
  it('显式船名中的类别词与数字不作独立筛选', () =>
    expect(vesselTracksSelection('船名“货船413123456”过去24小时航线', now).vesselSelector).toEqual({
      query: '货船413123456',
    }));
  it('完整保留带空格船名', () =>
    expect(vesselTracksSelection('船名"Ocean Star"过去24小时航线', now).vesselSelector).toEqual({
      query: 'Ocean Star',
    }));
  it('不静默丢弃多种独立检索条件', () =>
    expect(
      vesselTracksSelection('绘制船名海巡01 IMO1234567过去24小时航线', now).vesselSelector,
    ).toBeUndefined());
  it('否定指令不执行查询', () =>
    expect(deriveAgentIntent('不要绘制型号052D过去24小时航线')).toEqual({ intent: 'unresolved' }));
  it('时间歧义与缺少目标进入补问', () => {
    const selection = vesselTracksSelection('绘制当前视野昨晚货船航线', now);
    expect(selection.tracksTimeUnclear).toBe(true);
    expect(
      requiredAgentInputFields({ ...selection, bbox: [120, 30, 122, 32] }, 'vessel_tracks'),
    ).toEqual(['time']);
    expect(requiredAgentInputFields({ purpose: 'vessel_tracks' }, 'vessel_tracks')).toEqual([
      'region',
      'time',
      'vessel_selector',
    ]);
    expect(
      vesselTracksSelection('绘制当前视野过去24小时历史航线', now).vesselSelector,
    ).toBeUndefined();
  });
});
