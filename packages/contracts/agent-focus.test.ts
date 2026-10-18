import { describe, expect, it } from 'vitest';
import { CircleRegionSchema } from './spatial';
import { AgentFocusResultSchema } from './agent-focus';
describe('spatial focus contracts', () => {
  it('validates circle distances in meters', () => {
    expect(
      CircleRegionSchema.safeParse({ kind: 'circle', center: [179, 30], radiusMeters: 100 })
        .success,
    ).toBe(true);
    expect(
      CircleRegionSchema.safeParse({ kind: 'circle', center: [0, 0], radiusMeters: 99 }).success,
    ).toBe(false);
  });
  it('rejects a complete result containing missing objects', () => {
    expect(
      AgentFocusResultSchema.safeParse({
        kind: 'map_focus',
        version: 1,
        inputRevision: 0,
        sessionId: 's',
        taskId: 't',
        targets: [],
        missing: [{ kind: 'vessel', id: '123456789' }],
        bbox: null,
        displayStatus: 'complete',
        cameraPolicy: 'if-needed-once',
      }).success,
    ).toBe(false);
  });
});
