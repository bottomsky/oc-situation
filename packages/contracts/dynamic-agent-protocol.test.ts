import { describe, expect, it } from 'vitest';
import {
  AgentIntentSchema,
  AgentMessageInputSchema,
  AgentRetryInputSchema,
  AgentInputSpecSchema,
  AgentInputResponseSchema,
} from './agent';
import { UiCommandSchema, UiStateSchema } from './agent-ui';

describe('dynamic skill task protocol', () => {
  it('carries an exact skill choice through a persisted clarification', () => {
    const skillRef = { skillId: 'dynamic.example', version: 'v1' };
    expect(
      AgentInputSpecSchema.parse({
        fields: ['skill'],
        reason: 'ambiguous_skill',
        skillCandidates: [{ ...skillRef, name: '示例技能' }],
      }).skillCandidates,
    ).toHaveLength(1);
    expect(
      AgentInputResponseSchema.parse({ action: 'accept', inputRevision: 0, values: { skillRef } })
        .action,
    ).toBe('accept');
  });
  it('accepts one generic intent and an explicit immutable skill reference', () => {
    expect(AgentIntentSchema.safeParse('skill').success).toBe(true);
    expect(
      AgentMessageInputSchema.parse({
        content: '使用组合技能',
        skillRef: { skillId: 'dynamic.00000000-0000-4000-8000-000000000001', version: 'v1' },
      }).skillRef,
    ).toEqual({ skillId: 'dynamic.00000000-0000-4000-8000-000000000001', version: 'v1' });
  });

  it('rejects owner injection and makes latest retry an explicit choice', () => {
    expect(
      AgentMessageInputSchema.safeParse({
        content: '使用技能',
        skillRef: { skillId: 'dynamic.test', ownerId: 'other-owner' },
      }).success,
    ).toBe(false);
    expect(AgentRetryInputSchema.parse({ skillVersionPolicy: 'latest' }).skillVersionPolicy).toBe(
      'latest',
    );
    expect(AgentRetryInputSchema.safeParse({ skillVersionPolicy: 'random' }).success).toBe(false);
  });

  it('preserves step and artifact identity on browser commands', () => {
    const command = UiCommandSchema.parse({
      id: '00000000-0000-4000-8000-000000000001',
      taskId: '00000000-0000-4000-8000-000000000002',
      clientId: '00000000-0000-4000-8000-000000000003',
      pageGeneration: 1,
      operation: { componentId: 'chart.heatmap', action: 'show' },
      expectedVersion: 1,
      status: 'queued',
      stepId: 'display-heatmap',
      artifactRef: '00000000-0000-4000-8000-000000000004',
    });
    expect(command.stepId).toBe('display-heatmap');
    expect(command.artifactRef).toBe('00000000-0000-4000-8000-000000000004');
    expect(UiStateSchema.safeParse({ sequence: 1, route: '/skills', components: [] }).success).toBe(
      true,
    );
  });
});
