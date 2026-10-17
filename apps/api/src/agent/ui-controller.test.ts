import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import * as ui from '../../../../packages/infrastructure/agent-ui';
import { DynamicSkillError } from '../../../../packages/infrastructure/dynamic-skills';
import { AgentUiController } from './ui-controller';
afterEach(() => vi.restoreAllMocks());
describe('动态技能界面命令错误响应', () => {
  it.each([
    ['not_found', 404],
    ['forbidden', 403],
    ['fenced', 403],
    ['invalid_input', 400],
    ['skill_disabled', 409],
    ['skill_revoked', 409],
    ['skill_changed', 409],
  ] as const)('%s映射HTTP %s', async (code, status) => {
    vi.spyOn(ui, 'claimUiCommand').mockRejectedValue(new DynamicSkillError(code));
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(
      new AgentUiController({} as Infrastructure).claim(id, { clientId: id, pageGeneration: 1 }, {
        user: { id },
      } as never),
    ).rejects.toMatchObject({ status });
  });
});
