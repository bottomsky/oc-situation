import { describe, expect, it } from 'vitest';
import { AgentMessageInputSchema, AgentTaskStatusSchema } from './agent';

describe('agent input boundary', () => {
  it('defaults to 24 hours and accepts missing area for clarification', () => {
    expect(AgentMessageInputSchema.parse({ content: '分析区域低速活动' })).toEqual({
      content: '分析区域低速活动',
      historyHours: 24,
    });
  });
  it('rejects unbounded history, empty requests and reversed latitude', () => {
    expect(AgentMessageInputSchema.safeParse({ content: '分析', historyHours: 169 }).success).toBe(
      false,
    );
    expect(AgentMessageInputSchema.safeParse({ content: ' ' }).success).toBe(false);
    expect(
      AgentMessageInputSchema.safeParse({ content: '分析', bbox: [120, 40, 121, 30] }).success,
    ).toBe(false);
  });
  it('allows dateline regions and explicit durable states', () => {
    expect(
      AgentMessageInputSchema.safeParse({ content: '分析', bbox: [179, 0, -179, 20] }).success,
    ).toBe(true);
    expect(AgentTaskStatusSchema.parse('waiting_result')).toBe('waiting_result');
  });
});
