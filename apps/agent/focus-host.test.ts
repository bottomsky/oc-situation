import { expect, it, vi } from 'vitest';
import { createFocusResolver } from './focus-host';
import type { Infrastructure } from '../../packages/infrastructure/clients';
import type { RuntimeContext } from './runtime';
import { focusBounds } from '../../packages/domain/agent-focus';

const geometry = { type: 'Point', coordinates: [121, 30] };
function context(inputRevision = 2, snapshotRevision = 2) {
  return {
    task: { inputRevision },
    intelligenceResult: {
      inputRevision: snapshotRevision,
      evidence: [
        { kind: 'event', event: { id: 'evidence-1', version: 3, title: '本轮证据', geometry } },
      ],
    },
  } as RuntimeContext;
}

it('uses current intelligence evidence geometry and version before mutable relations', async () => {
  const query = vi.fn(() => {
    throw new Error('must not read current relations');
  });
  const resolve = createFocusResolver({ pool: { query } } as unknown as Infrastructure);
  expect(await resolve({ kind: 'intelligence', id: 'evidence-1', revision: 3 }, context())).toEqual(
    {
      ref: { kind: 'intelligence', id: 'evidence-1', revision: 3 },
      label: '本轮证据',
      geometry,
      source: 'intelligence-query-snapshot',
    },
  );
  expect(await resolve({ kind: 'intelligence', id: 'evidence-1' }, context())).toMatchObject({
    ref: { revision: 3 },
    geometry,
  });
  const unlocated = context();
  if (unlocated.intelligenceResult?.evidence[0]?.kind === 'event')
    unlocated.intelligenceResult.evidence[0].event.geometry = null;
  expect(
    await resolve({ kind: 'intelligence', id: 'evidence-1', revision: 3 }, unlocated),
  ).toBeNull();
  expect(query).not.toHaveBeenCalled();
});

it('validates explicit immutable intelligence versions and ignores stale input snapshots', async () => {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const resolve = createFocusResolver({ pool: { query } } as unknown as Infrastructure);
  expect(
    await resolve({ kind: 'intelligence', id: 'evidence-1', revision: 4 }, context()),
  ).toBeNull();
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('version=$2'), ['evidence-1', 4]);
  expect(
    await resolve({ kind: 'intelligence', id: 'evidence-1', revision: 3 }, context(3, 2)),
  ).toBeNull();
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining('version=$2'), ['evidence-1', 3]);
});

it.each([
  [-170, 20, 170, 30],
  [-180, -60, 180, 60],
  [170, 20, -170, 30],
] as [number, number, number, number][])(
  'preserves the selected bbox extent %j,%j,%j,%j in the host geometry',
  async (west, south, east, north) => {
    const bbox: [number, number, number, number] = [west, south, east, north];
    const resolve = createFocusResolver({} as Infrastructure);
    const snapshot = await resolve({ kind: 'region', id: 'task-region' }, {
      task: { selection: { region: { kind: 'bbox', bbox } } },
    } as RuntimeContext);
    expect(snapshot).not.toBeNull();
    expect(Array.isArray(snapshot)).toBe(false);
    if (snapshot && !Array.isArray(snapshot))
      expect(focusBounds([snapshot.geometry])).toEqual(bbox);
  },
);
