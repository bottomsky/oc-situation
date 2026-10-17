import { describe, expect, it } from 'vitest';
import { readSkillArtifacts } from './app/utils/skillArtifacts';

describe('同任务多步骤产物', () => {
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
