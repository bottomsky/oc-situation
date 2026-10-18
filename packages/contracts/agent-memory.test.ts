import { describe, expect, it } from 'vitest';
import {
  AgentAccountMemoryMutationSchema,
  AgentSessionMemoryWriteSchema,
  AgentMemoryValueSchema,
} from './agent-memory';

describe('agent memory contracts', () => {
  it('rejects oversized, cyclic, non-JSON and deeply nested values before recursive parsing', () => {
    let nested: unknown = 'leaf';
    for (let index = 0; index < 1000; index++) nested = { nested };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [nested, cyclic, '字'.repeat(6000), NaN, new Date(), undefined])
      expect(AgentMemoryValueSchema.safeParse(value).success).toBe(false);
    expect(AgentMemoryValueSchema.parse({ units: 'knots' })).toEqual({ units: 'knots' });
  });
  it('requires explicit proposed versus remembered account writes and rejects stale negative revisions', () => {
    const request = {
      operationId: '00000000-0000-4000-8000-000000000001',
      expectedRevision: 0,
      action: 'remember',
      category: 'preference',
      key: 'language',
      value: 'zh',
    };
    expect(AgentAccountMemoryMutationSchema.safeParse(request).success).toBe(true);
    expect(
      AgentAccountMemoryMutationSchema.safeParse({ ...request, action: 'automatic' }).success,
    ).toBe(false);
    expect(
      AgentAccountMemoryMutationSchema.safeParse({ ...request, expectedRevision: -1 }).success,
    ).toBe(false);
    expect(
      AgentAccountMemoryMutationSchema.safeParse({ ...request, action: 'propose' }).success,
    ).toBe(false);
  });
  it('keeps complete object memberships and rejects embedded geometry from references', () => {
    const members = Array.from({ length: 1001 }, (_, index) => ({
      kind: 'vessel',
      mmsi: String(100000000 + index),
    }));
    const request = {
      expectedRevision: 0,
      turnSeq: 1,
      objectSets: [
        { id: 'fleet', label: 'fleet', kind: 'vessels', turnSeq: 1, members, source: {} },
      ],
    };
    expect(AgentSessionMemoryWriteSchema.parse(request).objectSets?.[0]?.members).toHaveLength(
      1001,
    );
    expect(
      AgentSessionMemoryWriteSchema.safeParse({
        ...request,
        references: [{ refType: 'route', refId: 'r', geometry: {} }],
      }).success,
    ).toBe(false);
  });
});
