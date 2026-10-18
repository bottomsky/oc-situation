import { describe, expect, it } from 'vitest';
import { effectiveEventFields, sourceSnapshotKey } from './operational-event';
import { UpdateOperationalEventSchema } from '../contracts/operational-events';

describe('operational event projection', () => {
  it('patches only explicitly supplied fields and rejects simultaneous release', () => {
    const input = {
      operationId: '72f048da-d1b3-4fa7-b2f2-21aac448f62f',
      expectedRevision: 1,
      fields: { title: 'manual' },
    };
    expect(UpdateOperationalEventSchema.parse(input).fields).toEqual({ title: 'manual' });
    expect(
      UpdateOperationalEventSchema.safeParse({ ...input, releaseOverrides: ['title'] }).success,
    ).toBe(false);
  });
  it('retains manual overrides while source suggestions change and restores released fields', () => {
    expect(effectiveEventFields({ title: 'new', summary: 'source' }, { title: 'manual' })).toEqual({
      title: 'manual',
      summary: 'source',
    });
    expect(effectiveEventFields({ title: 'new' }, {})).toEqual({ title: 'new' });
  });
  it('canonicalizes nested snapshots so redelivery does not create a revision', () => {
    expect(sourceSnapshotKey({ a: 1, b: { x: 2, y: 3 } })).toBe(
      sourceSnapshotKey({ b: { y: 3, x: 2 }, a: 1 }),
    );
    expect(sourceSnapshotKey({ reviewStatus: 'confirmed' })).not.toBe(
      sourceSnapshotKey({ reviewStatus: 'rejected' }),
    );
  });
});
