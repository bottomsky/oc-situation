import { describe, expect, it } from 'vitest';
import { AgentInputError, bindAgentMapSelection } from './agent';

describe('safe map selection admission', () => {
  it.each([
    '聚焦 MMSI 123456789 缩放到8 然后放大2级',
    '创建一个技能：高亮并聚焦船舶，镜头缩放到8然后放大2级',
    '镜头聚焦经度122.3',
    '创建技能：镜头聚焦经度122.3',
    '镜头聚焦经度200纬度31',
    '创建技能：镜头聚焦经度200纬度31',
  ])('returns a public invalid_input error for %s', (goal) => {
    try {
      bindAgentMapSelection(goal, {});
      expect.fail('Invalid map input must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentInputError);
      expect(error).toMatchObject({
        code: 'invalid_input',
        message: '镜头参数无效，请提供有效经纬度和 0～22 范围内的缩放。',
      });
      expect(String(error)).not.toMatch(/ZodError|invalid_camera_zoom|invalid_camera_point/);
    }
  });
  it('retains a valid dynamic map request and the host vessel binding', () => {
    expect(bindAgentMapSelection('创建技能：聚焦 MMSI123456789 然后放大2级', {})).toMatchObject({
      mmsis: ['123456789'],
      mapTargetZoom: 12,
    });
  });
});
