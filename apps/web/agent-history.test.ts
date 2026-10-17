import { describe, expect, it } from 'vitest';
import { agentHistoryTime, groupAgentHistory } from './app/utils/agentHistory';
import { createChartDetailHost } from './app/composables/useChartDetail';

describe('智能体历史会话', () => {
  const now = new Date(2026, 9, 17, 12);
  const session = (id: string, title: string, day: number, hour = 12) => ({
    id,
    ownerId: 'owner',
    title,
    createdAt: new Date(2026, 9, day, hour).toISOString(),
  });
  it('按照真实创建时间分组，组内由新到旧排列', () => {
    const groups = groupAgentHistory(
      [
        session('older', '港口分析', 10),
        session('recent', '航线分析', 11),
        session('today1', '目标船舶', 17, 9),
        session('today2', '区域研判', 17, 11),
      ],
      '',
      now,
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['今天', ['today2', 'today1']],
      ['最近 7 天', ['recent']],
      ['更早', ['older']],
    ]);
  });
  it('按本地日历日处理午夜，搜索仅匹配实际会话标题', () => {
    const groups = groupAgentHistory(
      [session('matching', 'AIS 航线分析', 16, 23), session('other', '气象分析', 17)],
      '  ais  ',
      new Date(2026, 9, 17, 0, 1),
    );
    expect(groups.map((group) => [group.label, group.items.map((item) => item.id)])).toEqual([
      ['最近 7 天', ['matching']],
    ]);
  });
  it('不修改服务端列表，空搜索结果不生成空分组', () => {
    const sessions = [session('a', '船舶', 10), session('b', '海域', 17)];
    expect(groupAgentHistory(sessions, '不存在', now)).toEqual([]);
    groupAgentHistory(sessions, '', now);
    expect(sessions.map((item) => item.id)).toEqual(['a', 'b']);
  });
  it('显示创建时间，历史会话与其他详情互斥且保留来源关闭隔离', () => {
    expect(agentHistoryTime(new Date(2026, 9, 17, 9, 24).toISOString(), now)).toBe('09:24');
    expect(agentHistoryTime(new Date(2026, 8, 16, 9, 24).toISOString(), now)).toBe('09/16');
    const host = createChartDetailHost();
    host.open('history', 'right');
    expect(host.isOpen('history')).toBe(true);
    host.open('vessel', 'left');
    expect(host.isOpen('history')).toBe(false);
    host.close('history');
    expect(host.isOpen('vessel')).toBe(true);
  });
});
