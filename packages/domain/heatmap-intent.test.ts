import { describe, expect, it } from 'vitest';
import { deriveAgentIntent, requiredAgentInputFields } from './agent-intents';
import { heatmapSelection } from './heatmap-intent';

const now = new Date('2026-10-14T06:00:00.000Z');
describe('AIS 热力图有限意图与时间解析', () => {
  it.each([
    '生成当前视野 AIS 热力图',
    '查看船舶密度热力图',
    'AIS heatmap',
    '绘制当前视野热力图',
    '重新查询当前视野热力图',
  ])('%s', (text) => {
    expect(deriveAgentIntent(text)).toEqual({ intent: 'ais_heatmap', purpose: 'ais_heatmap' });
  });
  it('解释沿用已保存结果意图', () => {
    expect(deriveAgentIntent('解释上次 AIS 热力图').intent).toBe('explain');
  });
  it.each([
    ['生成热力图', '2026-10-13T06:00:00.000Z', '2026-10-14T06:00:00.000Z'],
    ['过去6小时热力图', '2026-10-14T00:00:00.000Z', '2026-10-14T06:00:00.000Z'],
    ['最近2天热力图', '2026-10-12T06:00:00.000Z', '2026-10-14T06:00:00.000Z'],
    ['昨天热力图', '2026-10-12T16:00:00.000Z', '2026-10-13T16:00:00.000Z'],
    [
      '北京时间2026-10-12 08:00至2026-10-13 08:00热力图',
      '2026-10-12T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
    ],
    [
      '2026-10-12T00:00:00Z至2026-10-13T00:00:00Z热力图',
      '2026-10-12T00:00:00.000Z',
      '2026-10-13T00:00:00.000Z',
    ],
  ])('解析 %s', (text, from, to) => {
    expect(heatmapSelection(text, now)).toEqual({ timeRange: { from, to } });
  });
  it.each([
    '最近热力图',
    '前几天热力图',
    '今天热力图',
    '过去8天热力图',
    '2026-10-12热力图',
    '北京时间2026-02-30 08:00至2026-03-01 08:00热力图',
    '前两天热力图',
    '周一热力图',
    '凌晨热力图',
    '最近100000000000000小时热力图',
    '昨天最近6小时热力图',
    '最近6小时和过去2天热力图',
    'UTC2026-10-12 08:00至北京时间2026-10-13 08:00热力图',
    '昨天上午热力图',
    '昨天8点到10点热力图',
    '昨天9时到12时热力图',
    '昨天九点到十二点热力图',
    '昨天9时30分到12时热力图',
    '昨天九点半到十二点热力图',
    '昨天九时三十分到十二时热力图',
    '昨天9点整到12点整热力图',
    '昨天到今天热力图',
    '最近6小时之前的热力图',
    '最近6小时前的热力图',
    '昨天热力图和前天比较',
    '最近6小时每天上午热力图',
    '北京时间2026-10-12 08:00至2026-10-13 08:00之后热力图',
  ])('含糊或无效时间补问 %s', (text) => {
    expect(heatmapSelection(text, now)).toEqual({ heatmapTimeUnclear: true });
  });
  it('区域与明确时间为必需项', () => {
    expect(
      requiredAgentInputFields({ purpose: 'ais_heatmap', heatmapTimeUnclear: true }, 'ais_heatmap'),
    ).toEqual(['region', 'time']);
  });
});
