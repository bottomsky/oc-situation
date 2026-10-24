import { describe, expect, it } from 'vitest';
import type { AgentFocusResult } from '@ais/contracts';
import {
  createChartDetailHost,
  createReplyObjectState,
  createReplyObjectLocation,
  createReplyDetailReader,
  replyObjectFocus,
} from './app/composables/useChartDetail';

describe('海图详情来源路由', () => {
  it('命令已验证关注可在同任务同输入代次回退为对象列表；失权或旧轮次不回退', () => {
    const focus = { taskId: 'task', sessionId: 'session', inputRevision: 2 } as AgentFocusResult;
    const reply = { taskId: 'task', sessionId: 'session', inputRevision: 2, readable: true };
    expect(replyObjectFocus(reply, focus)).toBe(focus);
    expect(replyObjectFocus({ ...reply, inputRevision: 3 }, focus)).toBeNull();
    expect(replyObjectFocus({ ...reply, readable: false }, focus)).toBeNull();
    const original = { ...focus, version: 8 };
    expect(replyObjectFocus({ ...reply, focus: original }, focus)).toBe(original);
  });
  it('历史版本403显示局部错误，重试仍读取当前历史id；轮次变化拒绝迟到错误', async () => {
    const reader = createReplyDetailReader();
    const ids: string[] = [];
    let denied = true;
    const read = async (id: string) => {
      ids.push(id);
      if (denied) throw new Error('历史版本无权访问');
    };
    await reader.read('history-v1', read);
    expect(reader.error.value).toBe('历史版本无权访问');
    expect(reader.busy.value).toBe(false);
    denied = false;
    await reader.retry();
    expect(ids).toEqual(['history-v1', 'history-v1']);
    expect(reader.error.value).toBe('');
    let reject: (error: Error) => void = () => {};
    const pending = reader.read(
      'history-v2',
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    reader.reset();
    reject(new Error('迟到403'));
    await pending;
    expect(reader.error.value).toBe('');
    expect(reader.targetId.value).toBe('');
  });
  it('定位按钮跟随高亮最新AIS，回复引用仍保留原观测与几何', () => {
    const object = {
      key: '["vessel","123456789",2,null]',
      ref: { kind: 'vessel', id: '123456789', revision: 2 },
      label: '船甲',
      geometries: [{ type: 'Point', coordinates: [120, 30] }],
      located: true,
      observedAt: '2026-10-01T00:00:00Z',
    } as const;
    const location = createReplyObjectLocation();
    location.update(
      {
        targets: [
          {
            ref: object.ref,
            label: object.label,
            geometry: object.geometries[0],
            observedAt: object.observedAt,
          },
        ],
      } as never,
      [
        {
          kind: 'point',
          mmsi: '123456789',
          lon: 122,
          lat: 31,
          observedAt: '2026-10-01T00:01:00Z',
          sourceId: 'live',
        },
      ] as never,
    );
    expect(location.bounds(object as never)).toEqual([122, 31, 122, 31]);
    expect(object.geometries[0].coordinates).toEqual([120, 30]);
    expect(object.observedAt).toBe('2026-10-01T00:00:00Z');
  });
  it('回复对象轮次变化清空抽屉与详情，使旧对象读取失效；同轮更新保留选择', () => {
    let invalidations = 0;
    const state = createReplyObjectState(() => invalidations++);
    state.setScope('account:task:input-1');
    state.panelOpen.value = true;
    const object = {
      key: 'ship-v1',
      ref: { kind: 'vessel', id: '123456789' },
      label: '船甲',
      geometries: [],
      located: false,
    } as const;
    const current = state.select(object as never);
    state.setScope('account:task:input-1');
    expect(current()).toBe(true);
    expect(state.selected.value?.key).toBe('ship-v1');
    state.setScope('account:task:input-2');
    expect(current()).toBe(false);
    expect(state.panelOpen.value).toBe(false);
    expect(state.selected.value).toBeNull();
    expect(invalidations).toBe(3);
  });
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
