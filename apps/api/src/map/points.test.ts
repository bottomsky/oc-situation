import { describe, expect, it, vi } from 'vitest';
import type { Infrastructure } from '@ais/infrastructure';
import type { AuthRequest } from '../auth/guard';
import { MapController } from './controller';

describe('point snapshot HTTP route', () => {
  it('accepts point queries at every zoom and paginates with the authenticated owner', async () => {
    const sql = vi.fn().mockResolvedValue({ rows: [] });
    const controller = new MapController({ pool: { query: sql } } as unknown as Infrastructure);
    const user = { user: { id: 'alice' } } as AuthRequest;
    const initial = await controller.points({ bbox: '170,-80,-170,80', zoom: '1' }, user);
    expect(initial).toMatchObject({ total: 0, complete: true, sequence: 1 });
    expect(sql.mock.calls[0]?.[0]).toContain(' OR ');
    await expect(
      controller.points({ snapshotId: initial.snapshotId, cursor: '0' }, user),
    ).resolves.toEqual(initial);
    await expect(
      controller.points({ snapshotId: initial.snapshotId, cursor: '0' }, {
        user: { id: 'bob' },
      } as AuthRequest),
    ).rejects.toMatchObject({ status: 410 });
  });
  it('rejects mixed or incomplete continuation queries and missing identity', async () => {
    const controller = new MapController({ pool: { query: vi.fn() } } as unknown as Infrastructure);
    const user = { user: { id: 'alice' } } as AuthRequest;
    await expect(
      controller.points({ bbox: '-180,-90,180,90', cursor: '1000' }, user),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.points({ bbox: '-180,-90,180,90', pageSize: 1001 }, user),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      controller.points({ bbox: '-180,-90,180,90' }, {} as AuthRequest),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('allows an authenticated owner to release and idempotently abandon a snapshot', async () => {
    const sql = vi.fn().mockResolvedValue({ rows: [] });
    const controller = new MapController({ pool: { query: sql } } as unknown as Infrastructure);
    const alice = { user: { id: 'alice' } } as AuthRequest;
    const bob = { user: { id: 'bob' } } as AuthRequest;
    const page = await controller.points({ bbox: '-180,-90,180,90' }, alice);
    expect(controller.release(page.snapshotId, bob)).toBeUndefined();
    await expect(
      controller.points({ snapshotId: page.snapshotId, cursor: '0' }, alice),
    ).resolves.toMatchObject({ snapshotId: page.snapshotId });
    expect(controller.release(page.snapshotId, alice)).toBeUndefined();
    expect(controller.release(page.snapshotId, alice)).toBeUndefined();
    await expect(
      controller.points({ snapshotId: page.snapshotId, cursor: '0' }, alice),
    ).rejects.toMatchObject({ status: 410 });
  });
});
