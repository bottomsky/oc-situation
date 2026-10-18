import { expect, it } from 'vitest';
import { namedMemoryFromInstruction, resolveNamedMemory } from './agent-memory-named';
import type { AgentAccountMemoryEntry } from '../contracts/agent-memory';
const entry = (value: unknown, key = '研究区') =>
  ({
    id: 'entry',
    category: 'named_region',
    key,
    value,
    status: 'active',
    source: {},
    revision: 1,
    createdAt: '',
    updatedAt: '',
    expiresAt: null,
  }) as AgentAccountMemoryEntry;
it('binds an explicitly named region to current host geometry', () => {
  expect(
    namedMemoryFromInstruction('这个区域叫研究区', {
      historyHours: 24,
      content: '',
      mapContext: { bbox: [110, 20, 120, 30], capturedAt: new Date().toISOString() },
    }),
  ).toEqual({
    category: 'named_region',
    key: '研究区',
    value: { kind: 'named_region', region: { kind: 'bbox', bbox: [110, 20, 120, 30] } },
  });
});
it('restores named geometry in another session only when the name is explicit', () => {
  const entries = [
    entry({ kind: 'named_region', region: { kind: 'bbox', bbox: [110, 20, 120, 30] } }),
  ];
  expect(resolveNamedMemory('聚焦研究区', {}, entries).selection.region).toEqual({
    kind: 'bbox',
    bbox: [110, 20, 120, 30],
  });
  expect(resolveNamedMemory('聚焦', {}, entries).selection).toEqual({});
});
it('binds named targets to exact selected identities and resolves them without re-running selectors', () => {
  const named = namedMemoryFromInstruction('选中的船舶叫常用船队', {
    historyHours: 24,
    content: '',
    mapContext: {
      bbox: [0, 0, 1, 1],
      selectedMmsis: ['413000001'],
      capturedAt: new Date().toISOString(),
    },
  })!;
  const result = resolveNamedMemory('聚焦常用船队', {}, [entry(named.value, named.key)]);
  expect(result.selection.mmsis).toEqual(['413000001']);
  expect(result.selection.vesselSelector).toEqual({ mmsis: ['413000001'] });
});
it('requests clarification for conflicting explicit names instead of picking one', () => {
  const values = [
    entry({ kind: 'named_region', region: { kind: 'bbox', bbox: [110, 20, 120, 30] } }),
    entry({ kind: 'named_region', region: { kind: 'bbox', bbox: [100, 10, 110, 20] } }, '备选区'),
  ];
  expect(resolveNamedMemory('聚焦研究区和备选区', {}, values).ambiguous).toBe(true);
});
