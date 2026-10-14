import { describe, expect, it } from 'vitest';
import * as contracts from './index';

describe('agent capability contracts', () => {
  it('exports binding and execution identity schemas', () => {
    expect(contracts).toHaveProperty('SkillBindingSchema');
    expect(contracts).toHaveProperty('ToolExecutionIdentitySchema');
  });
  it('pins skill content and adapter versions without executable extensions', () => {
    const binding = {
      skillId: 'ais-heatmap',
      version: '1',
      contentHash: 'a'.repeat(64),
      adapterVersion: '1',
    };
    expect(contracts.SkillBindingSchema.parse(binding)).toEqual(binding);
    expect(
      contracts.SkillBindingSchema.safeParse({ ...binding, contentHash: 'unknown' }).success,
    ).toBe(false);
    expect(contracts.SkillBindingSchema.safeParse({ ...binding, command: 'shell' }).success).toBe(
      false,
    );
  });
  it('requires complete durable ownership and revision identity', () => {
    const identity = {
      ownerId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      inputRevision: 0,
      generation: 1,
    };
    expect(contracts.ToolExecutionIdentitySchema.parse(identity)).toEqual(identity);
    expect(
      contracts.ToolExecutionIdentitySchema.safeParse({ ...identity, generation: -1 }).success,
    ).toBe(false);
    expect(
      contracts.ToolExecutionIdentitySchema.safeParse({ ...identity, ownerId: undefined }).success,
    ).toBe(false);
  });
  it('bounds discoverable metadata and permits only distinct tool identifiers', () => {
    const metadata = {
      skillId: 'ais-heatmap',
      version: '1',
      description: '区域船舶密度',
      toolIds: ['query_heatmap'],
    };
    expect(contracts.SkillCapabilityMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      contracts.SkillCapabilityMetadataSchema.safeParse({
        ...metadata,
        toolIds: ['query_heatmap', 'query_heatmap'],
      }).success,
    ).toBe(false);
    expect(
      contracts.SkillCapabilityMetadataSchema.safeParse({ ...metadata, script: 'arbitrary' })
        .success,
    ).toBe(false);
  });
});
