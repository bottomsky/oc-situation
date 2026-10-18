import { expect, it } from 'vitest';
import { parseCircleRegion } from './agent-focus';
import { requiredAgentInputFields, deriveAgentIntent } from './agent-intents';
it('routes coordinate radius vessel questions without a missing region', () => {
  const goal = '查询坐标122,31方圆50公里内有哪些船';
  const region = parseCircleRegion(goal);
  expect(region).toEqual({ kind: 'circle', center: [122, 31], radiusMeters: 50000 });
  expect(deriveAgentIntent(goal).intent).toBe('vessel_list');
  expect(requiredAgentInputFields({ region }, 'vessel_list')).toEqual([]);
});
