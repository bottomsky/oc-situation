import { afterEach, describe, expect, it, vi } from 'vitest';
import * as agentStorage from '../../../../packages/infrastructure/agent';
import { AgentController } from './controller';
import type { Infrastructure } from '@ais/infrastructure';
describe('agent feature switch', () => {
  const original = process.env.AGENT_ENABLED;
  afterEach(() => {
    vi.restoreAllMocks();
    if (original === undefined) delete process.env.AGENT_ENABLED;
    else process.env.AGENT_ENABLED = original;
  });
  it('advertises the disabled state and rejects data access before querying', async () => {
    delete process.env.AGENT_ENABLED;
    const controller = new AgentController({} as Infrastructure);
    expect(controller.config().enabled).toBe(false);
    await expect(controller.sessions({ user: { id: 'owner' } } as never)).rejects.toThrow(
      'Agent feature disabled',
    );
  });
  it('advertises bounded defaults when enabled', () => {
    process.env.AGENT_ENABLED = 'true';
    expect(new AgentController({} as Infrastructure).config()).toMatchObject({
      enabled: true,
      defaultHistoryHours: 24,
      maxHistoryHours: 168,
    });
  });
  it('以400响应明确说明热力图船舶筛选上限', async () => {
    process.env.AGENT_ENABLED = 'true';
    vi.spyOn(agentStorage, 'getAgentSession').mockResolvedValue(
      {} as NonNullable<Awaited<ReturnType<typeof agentStorage.getAgentSession>>>,
    );
    const message = '热力图一次最多筛选 100 艘船舶，请缩小船舶范围后重试。';
    vi.spyOn(agentStorage, 'submitAgentMessage').mockRejectedValue(
      new agentStorage.AgentInputError('invalid_input', message),
    );
    const controller = new AgentController({} as Infrastructure);
    const id = '11111111-1111-4111-8111-111111111111';
    await expect(
      controller.message(id, id, { content: '生成热力图' }, { user: { id } } as never),
    ).rejects.toMatchObject({ status: 400, response: { code: 'invalid_input', message } });
  });
});
