import { afterEach, describe, expect, it } from 'vitest';
import { AgentController } from './controller';
import type { Infrastructure } from '@ais/infrastructure';
describe('agent feature switch', () => {
  const original = process.env.AGENT_ENABLED;
  afterEach(() => {
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
});
