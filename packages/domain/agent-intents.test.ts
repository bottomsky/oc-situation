import { describe, expect, it } from 'vitest';
import { deriveAgentIntent, requiredAgentInputFields } from './agent-intents';

describe('shared local agent intent routing', () => {
  it.each([
    ['当前 视野有哪些船舶', 'vessel_list'],
    ['查看这艘船的信息', 'vessel_detail'],
    ['分析区域低速活动与公告关联', 'analysis'],
    ['解释上次的低速分析', 'explain'],
    ['你好', 'conversation'],
    ['请定位港口并保存禁航区', 'unresolved'],
    ['港口有哪些船舶', 'vessel_list'],
    ['查看上次结果', 'explain'],
    ['这条公告依据是什么', 'explain'],
    ['该情报的来源是哪里', 'explain'],
    ['解释上次结果，然后按当前视野再查一次', 'vessel_list'],
    ['解释这艘船并重新查询选中船舶的信息', 'vessel_detail'],
    ['解释上次结果，当前范围变了', 'explain'],
    ['做点事情', 'unresolved'],
  ])('%s -> %s', (goal, intent) => {
    expect(deriveAgentIntent(goal).intent).toBe(intent);
  });
  it('selected purpose resolves an earlier ambiguous goal and computes only required fields', () => {
    expect(requiredAgentInputFields({ purpose: 'vessel_list' }, 'unresolved')).toEqual(['region']);
    expect(requiredAgentInputFields({ purpose: 'vessel_detail', mmsis: [] }, 'unresolved')).toEqual(
      ['vessels'],
    );
    expect(
      requiredAgentInputFields({ purpose: 'vessel_detail', mmsis: ['413123456'] }, 'unresolved'),
    ).toEqual([]);
    expect(requiredAgentInputFields({ purpose: 'port-restriction' }, 'analysis')).toEqual([
      'region',
      'time',
    ]);
    expect(requiredAgentInputFields({}, 'conversation')).toEqual([]);
  });
});
