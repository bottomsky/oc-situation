import { describe, expect, it } from 'vitest';
import { parseBusinessRequest, businessOperationId } from './business-request';

describe('trusted business requests', () => {
  it('extracts coordinates and explicit event write intent from the user goal', () => {
    expect(parseBusinessRequest('创建事件 标题：可疑船只聚集 坐标：121.5,30.2')).toEqual({
      toolId: 'create_event',
      title: '可疑船只聚集',
      coordinate: [121.5, 30.2],
    });
  });
  it('distinguishes planning from saving and parses a persisted event status change', () => {
    expect(parseBusinessRequest('规划从坐标120,30到坐标121,31的航线')?.toolId).toBe('plan_route');
    expect(
      parseBusinessRequest('规划从坐标120,30到坐标121,31的航线，规划并保存为：巡逻线'),
    ).toMatchObject({ toolId: 'create_route', name: '巡逻线' });
    expect(
      parseBusinessRequest('将事件550e8400-e29b-41d4-a716-446655440000状态改为已解决'),
    ).toMatchObject({ toolId: 'update_event', status: 'resolved' });
  });
  it('does not grant writes for ordinary query or quoted source instructions', () => {
    expect(parseBusinessRequest('查询事件 创建事件的说明')?.toolId).toBe('query_events');
    expect(parseBusinessRequest('情报正文说“创建事件 标题：测试”')).toBeNull();
    expect(parseBusinessRequest('查询计划航线：巡逻线')?.toolId).toBe('query_routes');
    expect(parseBusinessRequest('查询最近72小时船舶航线')).toBeNull();
    expect(parseBusinessRequest('规划从坐标120,30到坐标121,31的航线，不要保存')?.toolId).toBe(
      'plan_route',
    );
  });
  it('extracts bounded event fields without treating title prose as a status command', () => {
    expect(
      parseBusinessRequest(
        '创建事件 标题：海上事故 级别：高 摘要：两船碰撞 关联船舶413123456 坐标121,30',
      ),
    ).toMatchObject({
      title: '海上事故',
      severity: 'high',
      summary: '两船碰撞',
      linkedMmsis: ['413123456'],
      coordinate: [121, 30],
    });
    expect(
      parseBusinessRequest('修改事件550e8400-e29b-41d4-a716-446655440000 标题：如何解决异常'),
    ).not.toHaveProperty('status');
  });
  it('generates an operation identity stable across worker generations', () => {
    expect(businessOperationId('task', 2, 'step', 'create_event')).toBe(
      businessOperationId('task', 2, 'step', 'create_event'),
    );
    expect(businessOperationId('task', 3, 'step', 'create_event')).not.toBe(
      businessOperationId('task', 2, 'step', 'create_event'),
    );
  });
  it.each([
    ['将这个事件状态改为已解决', 'event', 'update_event'],
    ['修改这条计划航线 名称：巡逻线', 'route', 'update_route'],
    ['修改此航线 名称：巡逻线', 'route', 'update_route'],
    ['修改这条航线 名称：巡逻线', 'route', 'update_route'],
  ] as const)('resolves a single matching selected kind for %s', (goal, kind, toolId) => {
    const refs = [
      { kind: 'event' as const, id: '550e8400-e29b-41d4-a716-446655440000' },
      { kind: 'route' as const, id: '550e8400-e29b-41d4-a716-446655440001' },
    ];
    expect(parseBusinessRequest(goal, refs)).toMatchObject({
      toolId,
      id: refs.find((ref) => ref.kind === kind)!.id,
    });
    expect(
      parseBusinessRequest(goal, [...refs, { kind, id: '550e8400-e29b-41d4-a716-446655440002' }]),
    ).not.toHaveProperty('id');
  });
  it.each([
    '创建事件 标题：演习，先不要保存',
    '创建事件 标题：演习，仅预览',
    '修改事件550e8400-e29b-41d4-a716-446655440000 状态：归档，不要执行',
    '修改航线550e8400-e29b-41d4-a716-446655440000 名称：巡逻线，先不保存',
  ])('does not authorize a write explicitly withheld by the user: %s', (goal) => {
    expect(parseBusinessRequest(goal)).toBeNull();
  });
});
