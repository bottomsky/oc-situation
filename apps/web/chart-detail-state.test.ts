import { describe, expect, it } from 'vitest';
import { createChartDetailHost } from './app/composables/useChartDetail';

describe('海图详情来源路由', () => {
  it('人工详情与协同详情共享单浮层，最近打开项保持自己的锚点', () => {
    const host = createChartDetailHost();
    host.open('intelligence', 'left');
    expect(host.active.value).toEqual({ kind: 'intelligence', side: 'left' });
    host.open('task', 'right');
    expect(host.active.value).toEqual({ kind: 'task', side: 'right' });
    expect(host.isOpen('intelligence')).toBe(false);
    expect(host.isOpen('task')).toBe(true);
  });

  it('来源卡关闭回调不会误关后打开的详情', () => {
    const host = createChartDetailHost();
    host.open('sources', 'right');
    host.open('vessel', 'left');
    host.close('sources');
    expect(host.isOpen('vessel')).toBe(true);
    host.close();
    expect(host.active.value).toBeNull();
  });

  it('关闭和重新打开只改变显示状态，来源可跟随新入口切换', () => {
    const host = createChartDetailHost();
    host.open('intelligence', 'left');
    host.close('intelligence');
    host.open('intelligence', 'right');
    expect(host.active.value).toEqual({ kind: 'intelligence', side: 'right' });
  });
});
