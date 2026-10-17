import { describe, expect, it } from 'vitest';
import { partitionChartTabs } from './app/utils/chartOverflowTabs';

const tabs = [
  { id: 'search', width: 66 },
  { id: 'intelligence', width: 66 },
  { id: 'layers', width: 66 },
  { id: 'playback', width: 66 },
  { id: 'history-tracks', width: 66 },
  { id: 'heatmap', width: 82 },
];

describe('操作面板功能栏宽度分配', () => {
  it('全部自然宽度恰好容纳时隐藏更多入口', () => {
    expect(partitionChartTabs(tabs, 'search', 432, 4, 32)).toEqual({
      visible: tabs.map((tab) => tab.id),
      overflow: [],
    });
  });

  it('不足时预留32px入口和间距，分别保持原始顺序', () => {
    expect(partitionChartTabs(tabs, 'search', 284, 4, 32)).toEqual({
      visible: ['search', 'intelligence', 'layers'],
      overflow: ['playback', 'history-tracks', 'heatmap'],
    });
  });

  it('从下拉或Agent切换到靠后功能时始终保留当前选中项', () => {
    expect(partitionChartTabs(tabs, 'heatmap', 284, 4, 32)).toEqual({
      visible: ['search', 'intelligence', 'heatmap'],
      overflow: ['layers', 'playback', 'history-tracks'],
    });
  });

  it('重新测量字体或容器后根据实际宽度重新分配', () => {
    const largerLabels = tabs.map((tab) => ({ ...tab, width: tab.width + 20 }));
    expect(partitionChartTabs(largerLabels, 'heatmap', 284, 4, 32).visible).toEqual([
      'search',
      'heatmap',
    ]);
    expect(partitionChartTabs(tabs, 'heatmap', 432, 4, 32).overflow).toEqual([]);
  });

  it('隐藏容器仍保留选中项，空列表返回空集合', () => {
    expect(partitionChartTabs(tabs, 'heatmap', 0, 4, 32)).toEqual({
      visible: ['heatmap'],
      overflow: ['search', 'intelligence', 'layers', 'playback', 'history-tracks'],
    });
    expect(partitionChartTabs([], 'search', 0, 4, 32)).toEqual({ visible: [], overflow: [] });
  });
});
