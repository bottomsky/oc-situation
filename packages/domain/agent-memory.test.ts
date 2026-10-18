import { describe, expect, it } from 'vitest';
import { deriveMemoryIntent, resolveMemorySelection, parseMemoryInstruction } from './agent-memory';

const vessels = (id = 'batch-a', turnSeq = 4, ids = ['413000001', '413000002']) => ({
  id,
  label: '刚才查询的船舶',
  kind: 'vessels' as const,
  turnSeq,
  members: ids.map((mmsi) => ({ kind: 'vessel' as const, mmsi })),
  source: { taskId: 'task-a' },
  querySucceeded: true,
  uiSucceeded: false,
});
const memory = {
  objectSets: [vessels()],
  conditions: { selection: { bbox: [110, 20, 120, 30] }, intent: 'vessel_list' },
};

describe('session memory resolution', () => {
  it('binds bare focus to the full saved identity set after query success even when display failed', () => {
    expect(resolveMemorySelection('聚焦', {}, 'map_camera', memory).selection).toMatchObject({
      mmsis: ['413000001', '413000002'],
      vesselSelector: { mmsis: ['413000001', '413000002'] },
    });
  });
  it('explicit text wins over submitted selection and prior session identity', () => {
    expect(
      resolveMemorySelection('聚焦船舶413999999', { mmsis: ['413888888'] }, 'map_camera', memory)
        .selection.mmsis,
    ).toEqual(['413999999']);
  });
  it('submitted object selection wins over prior session identity without a deictic word', () => {
    expect(
      resolveMemorySelection('聚焦', {}, 'map_camera', memory, { selectedMmsis: ['413888888'] })
        .selection.mmsis,
    ).toEqual(['413888888']);
  });
  it('does not turn viewport or account preferences into a focus object in a new session', () => {
    const result = resolveMemorySelection('聚焦', { bbox: [110, 20, 120, 30] }, 'map_camera', null);
    expect(result.selection.mmsis).toBeUndefined();
    expect(result.selection.mapCamera).toBeUndefined();
  });
  it('asks when the latest compatible round has multiple equally recent object sets', () => {
    expect(
      resolveMemorySelection('聚焦这批', {}, 'map_camera', {
        ...memory,
        objectSets: [vessels(), vessels('batch-b')],
      }).ambiguous,
    ).toBe(true);
  });
  it('keeps older identities out when the most recent query succeeded with an empty set', () => {
    expect(
      resolveMemorySelection('聚焦', {}, 'map_camera', {
        ...memory,
        objectSets: [vessels(), vessels('empty', 5, [])],
      }).selection.mmsis,
    ).toBeUndefined();
  });
  it('inherits compatible query scope for count and tracks and replaces model selectors with identities', () => {
    expect(deriveMemoryIntent('统计刚才这批', { intent: 'unresolved' }, memory)).toEqual({
      intent: 'vessel_list',
      purpose: 'vessel_list',
    });
    expect(
      resolveMemorySelection(
        '查刚才这批的历史轨迹',
        { vesselSelector: { query: '刚才这批' } },
        'vessel_tracks',
        memory,
      ).selection,
    ).toMatchObject({
      bbox: [110, 20, 120, 30],
      vesselSelector: { mmsis: ['413000001', '413000002'] },
    });
  });
  it('preserves current explicit object query instead of reusing old identities', () => {
    expect(
      resolveMemorySelection(
        '高亮型号ABC的船舶',
        { vesselSelector: { model: 'ABC' } },
        'vessel_highlights',
        memory,
      ).selection,
    ).toEqual({ vesselSelector: { model: 'ABC' } });
  });
  it('keeps a new explicit model even when the user says continue', () => {
    expect(
      resolveMemorySelection(
        '继续高亮型号B的船舶',
        { vesselSelector: { model: 'B' } },
        'vessel_highlights',
        memory,
      ).selection.vesselSelector,
    ).toEqual({ model: 'B' });
  });
  it('uses saved query scope ahead of an implicit moved viewport for deictic tracks', () => {
    expect(
      resolveMemorySelection(
        '查刚才这批船过去6小时轨迹',
        { bbox: [0, 0, 1, 1] },
        'vessel_tracks',
        memory,
      ).selection.bbox,
    ).toEqual([110, 20, 120, 30]);
  });
  it('keeps a current explicit named scope ahead of previous session scope while retaining referenced identities', () => {
    const result = resolveMemorySelection(
      '统计刚才这批在研究区的船舶',
      { region: { kind: 'bbox', bbox: [0, 0, 1, 1] }, bbox: [0, 0, 1, 1] },
      'vessel_list',
      memory,
      undefined,
      { explicitScope: true },
    );
    expect(result.selection.bbox).toEqual([0, 0, 1, 1]);
    expect(result.selection.mmsis).toEqual(['413000001', '413000002']);
  });
  it('clearing highlight keeps the referent while an explicit forget command clears it', () => {
    expect(parseMemoryInstruction('清除全部高亮')).toBeNull();
    expect(parseMemoryInstruction('忘掉刚才这批船')).toEqual({ action: 'forget_session_objects' });
  });
  it('asks for a smaller scope instead of silently taking the first hundred members', () => {
    const many = Array.from({ length: 101 }, (_, i) => String(413000000 + i));
    const result = resolveMemorySelection('聚焦', {}, 'map_camera', {
      ...memory,
      objectSets: [vessels('large', 5, many)],
    });
    expect(result.tooMany).toBe(true);
    expect(result.selection.mmsis).toBeUndefined();
  });
  it('parses actual natural-language account save, update, forget and candidate confirmation', () => {
    expect(parseMemoryInstruction('记住：以后回答简短一点')).toEqual({
      action: 'remember',
      content: '以后回答简短一点',
    });
    expect(parseMemoryInstruction('把我的偏好改为：默认看过去6小时')).toEqual({
      action: 'update',
      content: '默认看过去6小时',
    });
    expect(parseMemoryInstruction('忘记我的偏好：默认看过去6小时')).toEqual({
      action: 'forget',
      content: '默认看过去6小时',
    });
    expect(parseMemoryInstruction('确认记住这个偏好')).toEqual({ action: 'confirm' });
  });
});
