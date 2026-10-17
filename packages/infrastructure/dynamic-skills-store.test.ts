import { describe, expect, it, vi } from 'vitest';
import {
  assertTaskDynamicSkillActive,
  publishOwnedSkill,
  DynamicSkillError,
} from './dynamic-skills';
import type { Infrastructure } from './clients';
import { randomUUID } from 'node:crypto';

describe('dynamic skill persistence admission', () => {
  it('blocks new publication and invocation while disabled without touching storage', async () => {
    const old = process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
    process.env.AGENT_DYNAMIC_SKILLS_ENABLED = 'false';
    const query = vi.fn();
    const infra = { pool: { query, connect: query } } as unknown as Infrastructure;
    try {
      await expect(publishOwnedSkill(infra, randomUUID(), {} as never)).rejects.toMatchObject({
        code: 'forbidden',
      });
      expect(
        await assertTaskDynamicSkillActive(infra, {
          ownerId: randomUUID(),
          taskId: randomUUID(),
          workerId: 'worker',
          generation: 1,
          inputRevision: 0,
        }),
      ).toBe(false);
      expect(query).not.toHaveBeenCalled();
    } finally {
      if (old === undefined) delete process.env.AGENT_DYNAMIC_SKILLS_ENABLED;
      else process.env.AGENT_DYNAMIC_SKILLS_ENABLED = old;
    }
  });
  it('exposes stable structured errors for HTTP and runtime translation', () => {
    expect(new DynamicSkillError('skill_disabled', '技能已停用')).toMatchObject({
      code: 'skill_disabled',
      message: '技能已停用',
    });
  });
});
