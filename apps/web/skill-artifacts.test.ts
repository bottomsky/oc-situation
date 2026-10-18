import { describe, expect, it } from 'vitest';
import { readSkillArtifacts } from './app/utils/skillArtifacts';

describe('同任务多步骤产物', () => {
  const route = {
    id: '00000000-0000-4000-8000-000000000001',
    revision: 2,
    name: '东海方案',
    status: 'draft',
    mmsis: [],
    waypoints: [
      [120, 30],
      [121, 31],
    ],
    geometry: {
      type: 'LineString',
      coordinates: [
        [120, 30],
        [121, 31],
      ],
    },
    lengthMeters: 120000,
    generatedBy: 'manual',
    planId: null,
    createdAt: '2026-10-18T00:00:00Z',
    updatedAt: '2026-10-18T00:00:00Z',
  };
  const artifact = (kind: string, payload: unknown) => ({
    id: 'a',
    stepId: 'business',
    kind,
    inputRevision: 2,
    payload,
  });
  it('航线单条与列表统一解析，保留总量和截断状态', () => {
    const single = readSkillArtifacts([artifact('route', { kind: 'route', route })], 2)[0]?.result;
    expect(single).toMatchObject({ kind: 'route', routes: [route], total: 1, truncated: false });
    expect(
      readSkillArtifacts(
        [artifact('route', { kind: 'route', routes: [route], total: 9, truncated: true })],
        2,
      )[0]?.result,
    ).toMatchObject({ total: 9, truncated: true });
  });
  it('非法ID、冲突输入修订、错误持久类型均不生成业务快照', () => {
    for (const payload of [
      { kind: 'route', route: { ...route, id: 'javascript:alert(1)' } },
      { kind: 'route', route, inputRevision: 1 },
      { kind: 'operational_event', route },
    ])
      expect(readSkillArtifacts([artifact('route', payload)], 2)[0]?.result).toBeNull();
  });
  it('事件单条与查询保留摘要级别、发生时间和关联，查询按total标记截断', () => {
    const event = {
      id: route.id,
      revision: 3,
      title: '临时管制',
      summary: '测试摘要',
      category: 'restriction',
      severity: 'unknown',
      occurredAt: null,
      geometry: null,
      linkedMmsis: [],
      linkedRouteIds: [],
      status: 'active',
      primarySourceKey: null,
      sourceSuggestions: {},
      overrides: {},
      mergedInto: null,
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
    };
    expect(
      readSkillArtifacts(
        [artifact('operational_event', { kind: 'operational_event', event })],
        2,
      )[0]?.result,
    ).toMatchObject({ event });
    expect(
      readSkillArtifacts(
        [artifact('operational_events', { kind: 'operational_events', items: [event], total: 4 })],
        2,
      )[0]?.result,
    ).toMatchObject({ items: [event], total: 4, truncated: true });
    expect(
      readSkillArtifacts(
        [artifact('operational_events', { kind: 'operational_events', items: [event], total: 0 })],
        2,
      )[0]?.result,
    ).toBeNull();
  });
  it('规划候选与空间概况按各自契约解析，并拦截payload旧修订', () => {
    const plan = {
      id: route.id,
      status: 'failed',
      input: { operationId: route.id, waypoints: route.waypoints },
      datasetVersion: 'sea-v1',
      restrictionVersion: 2,
      result: null,
      error: 'no_path',
      createdAt: route.createdAt,
      updatedAt: route.updatedAt,
      stale: false,
    };
    expect(
      readSkillArtifacts([artifact('route_plan', { kind: 'route_plan', plan })], 2)[0]?.result,
    ).toMatchObject({ kind: 'route_plan', plan });
    const focus = {
      kind: 'map_focus',
      sessionId: route.id,
      taskId: route.id,
      version: 1,
      inputRevision: 2,
      targets: [],
      missing: [],
      omittedCount: 0,
      bbox: null,
      displayStatus: 'unlocated',
      cameraPolicy: 'if-needed-once',
    };
    expect(readSkillArtifacts([artifact('map_focus', focus)], 2)[0]?.result).toMatchObject({
      displayStatus: 'unlocated',
    });
    expect(
      readSkillArtifacts([artifact('map_focus', { ...focus, inputRevision: 1 })], 2)[0]?.result,
    ).toBeNull();
  });
  const result = {
    kind: 'vessel_list',
    version: 1,
    inputRevision: 2,
    total: 0,
    truncated: false,
    items: [],
    asOf: '2026-10-17T00:00:00Z',
    selection: {},
  };
  it('保留重复类型的两个步骤产物并排除旧输入修订', () => {
    const items = readSkillArtifacts(
      [
        { id: 'a', stepId: 'one', kind: 'vessel_list', inputRevision: 2, payload: result },
        { id: 'b', stepId: 'two', kind: 'vessel_list', inputRevision: 2, payload: result },
        { id: 'c', stepId: 'old', kind: 'vessel_list', inputRevision: 1, payload: result },
      ],
      2,
    );
    expect(items.map((item) => item.id)).toEqual(['a', 'b']);
    expect(items.every((item) => item.result?.kind === 'vessel_list')).toBe(true);
  });
  it('持久类型与payload类型不一致时保留审计卡片而不展示伪造快照', () => {
    const [item] = readSkillArtifacts(
      [{ id: 'a', stepId: 'one', kind: 'ais_heatmap', inputRevision: 2, payload: result }],
      2,
    );
    expect(item?.result).toBeNull();
  });
});
