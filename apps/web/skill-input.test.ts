import { describe, expect, it } from 'vitest';
import {
  skillCandidateKey,
  skillChoiceValid,
  inputNeedsIntelligence,
  initializeAgentInputValues,
} from './app/utils/skillInput';
describe('技能歧义补问', () => {
  const candidates = [
    { skillId: 'cargo', version: '1', name: '货船清单' },
    { skillId: 'cargo', version: '2', name: '货船清单新版' },
  ];
  it('必须选择服务端候选中的精确版本', () => {
    expect(skillChoiceValid(undefined, candidates)).toBe(false);
    expect(skillChoiceValid({ skillId: 'cargo' }, candidates)).toBe(false);
    expect(skillChoiceValid({ skillId: 'cargo', version: '3' }, candidates)).toBe(false);
    expect(skillChoiceValid({ skillId: 'cargo', version: '2' }, candidates)).toBe(true);
  });
  it('同技能不同版本的单选项键相互独立', () => {
    expect(skillCandidateKey(candidates[0]!)).not.toBe(skillCandidateKey(candidates[1]!));
  });
});
describe('组合技能通用情报补问', () => {
  it('依据topic字段显示控件，保留没有legacy purpose的组合意图', () => {
    expect(inputNeedsIntelligence(['topic'], undefined)).toBe(true);
    expect(inputNeedsIntelligence(['region'], undefined)).toBe(false);
    expect(inputNeedsIntelligence([], 'intelligence_search')).toBe(true);
    const values = initializeAgentInputValues({}, ['topic']);
    expect(values.intelligenceQuery?.kind).toBe('events');
    expect(values.purpose).toBeUndefined();
  });
  it('初始化克隆草稿并保留已有海况检索类型', () => {
    const prefill = { intelligenceQuery: { kind: 'marine' as const, keyword: '海况' } };
    const values = initializeAgentInputValues(prefill, ['topic']);
    expect(values.intelligenceQuery?.kind).toBe('marine');
    values.intelligenceQuery!.keyword = '修改';
    expect(prefill.intelligenceQuery.keyword).toBe('海况');
  });
});
